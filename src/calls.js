import { randomUUID, randomBytes } from 'node:crypto';
import { briefSchema, openingLine } from './brief.js';
import { TERMINAL } from './store.js';
import { setupStatus } from './config.js';

export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class Calls {
  constructor({ store, config, provider, preflight = async () => {}, prepareVoice = async () => {}, now = () => Date.now() }) {
    Object.assign(this, { store, config, provider, preflight, prepareVoice, now });
    this.timers = new Map();
    this.bridges = new Map();
  }
  plan(input) {
    const brief = briefSchema.parse(input);
    const plan = { ...brief, id: randomUUID(), createdAt: new Date(this.now()).toISOString(), openingLine: openingLine(brief) };
    this.store.state.plans.push(plan);
    this.store.state.plans = this.store.state.plans.slice(-200);
    this.store.save();
    return plan;
  }
  async start(id) {
    const plan = this.store.plan(id);
    if (!plan) throw new AppError(404, 'Call brief not found. Prepare a new brief.');
    // Repeated clicks/retries for the same approved snapshot never create a second call.
    const previous = this.store.state.calls.find(c => c.planId === id);
    if (previous) return previous;
    if (Date.parse(plan.createdAt) + 86400000 < this.now()) throw new AppError(409, 'This brief is over a day old. Review a new brief before calling.');
    if (!setupStatus(this.config).ready) throw new AppError(503, 'Complete the connection setup before placing a call.');
    if (this.store.active()) throw new AppError(409, 'Another call is active. End it before starting a new one.');
    const call = {
      ...plan, id: randomUUID(), planId: id, createdAt: new Date(this.now()).toISOString(),
      status: 'preparing', providerCallSid: null, streamToken: randomBytes(32).toString('hex'),
      transcript: [], events: [], outcome: null, endedAt: null, error: null,
      stopRequested: false, lastSequence: -1, voiceUsage: null, backendUsage: [], finalizationComplete: false,
    };
    this.store.state.calls.push(call);
    this.store.save();
    this.store.event(call, 'Call approved. Checking OpenAI access.');
    let phase = 'preflight';
    try {
      await this.preflight();
      if (TERMINAL.has(call.status)) return call;
      if (call.stopRequested) { this.finish(call, 'canceled'); return call; }
      phase = 'voice';
      this.store.event(call, 'Preparing the voice connection before dialing.');
      await this.prepareVoice(call);
      if (TERMINAL.has(call.status)) return call;
      if (call.stopRequested) { this.finish(call, 'canceled'); return call; }
      phase = 'dial';
      this.store.update(call, { status: 'dialing' });
      this.armDeadline(call);
      const result = await this.provider.create(call);
      this.store.update(call, { providerCallSid: result.sid });
      this.store.event(call, 'Outbound call requested.');
      if (call.stopRequested || TERMINAL.has(call.status)) await this.stop(call.id, 'Stopped before the call connected.');
    } catch (error) {
      if (TERMINAL.has(call.status)) return call;
      if (phase !== 'dial' && call.stopRequested) {
        this.finish(call, 'canceled');
      } else if (phase !== 'dial' || (error.status >= 400 && error.status < 500)) {
        this.store.update(call, { error: phase === 'preflight'
          ? 'OpenAI access check failed. Check the key, project access, and network.'
          : phase === 'voice'
            ? call.error || 'The voice connection could not be prepared. Check OpenAI access and the network.'
            : `Phone provider rejected the call${error.code ? ` (code ${Number(error.code) || 'unknown'})` : ''}. Check account permissions and the phone number.` });
        this.finish(call, 'failed');
      } else {
        // A network timeout does not prove the provider failed to place the call.
        this.store.update(call, { error: 'The provider response is uncertain. Waiting for signed call status; do not retry this call.' });
        this.store.event(call, call.maxDurationSeconds === null
          ? 'Provider acknowledgment missing. Check Twilio call status; do not redial.'
          : 'Provider acknowledgment missing. The call duration cap still applies.');
      }
    }
    return call;
  }
  armDeadline(call) {
    clearTimeout(this.timers.get(call.id));
    this.timers.delete(call.id);
    if (call.maxDurationSeconds === null) return;
    const deadline = Date.parse(call.createdAt) + (call.maxDurationSeconds + 45) * 1000;
    const timer = setTimeout(() => { void this.stop(call.id, 'Maximum call duration reached.').catch(() => {}); }, Math.max(1, deadline - this.now()));
    timer.unref?.();
    this.timers.set(call.id, timer);
  }
  async stop(id, reason = 'Stopped by you.') {
    const call = this.store.call(id);
    if (!call) throw new AppError(404, 'Call not found.');
    this.store.update(call, { stopRequested: true });
    this.bridges.get(id)?.close(reason);
    if (!call.providerCallSid) {
      if (call.status === 'preparing') return call; // start() checks after each preparation step.
      const capped = call.maxDurationSeconds !== null
        && Date.parse(call.createdAt) + (call.maxDurationSeconds + 45) * 1000 <= this.now();
      if (capped) {
        this.store.update(call, { error: 'The provider call ID and disconnection remain unconfirmed. Check Twilio logs. New calls stay blocked until a signed status or stream identifies this call.' });
        this.store.event(call, 'Call status is still uncertain. The provider duration limit starts on connection and does not prove a queued call ended.');
      } else this.store.event(call, 'Stop requested. Waiting for the provider call ID to confirm disconnection.');
      return call;
    }
    try {
      await this.provider.end(call.providerCallSid);
      this.store.event(call, reason);
      this.finish(call, call.status === 'failed' ? 'failed' : 'completed');
    } catch {
      if (TERMINAL.has(call.status)) return call; // A signed callback may have confirmed disconnection while hangup was pending.
      this.store.update(call, { error: 'Could not confirm hangup. Use the phone provider console to end the call.' });
      throw new AppError(502, call.error);
    }
    return call;
  }
  async status(id, payload) {
    const call = this.store.call(id);
    if (!call) return;
    if (!/^CA[a-f\d]{32}$/i.test(payload.CallSid || '')) return;
    if (call.providerCallSid && call.providerCallSid !== payload.CallSid) return;
    if (!call.providerCallSid && (payload.To !== call.phoneNumber || payload.From !== this.config.fromNumber)) return;
    const status = payload.CallStatus === 'answered' ? 'in-progress' : payload.CallStatus;
    if (!['queued', 'initiated', 'ringing', 'in-progress', ...TERMINAL].includes(status)) return;
    this.store.update(call, { providerCallSid: payload.CallSid });
    if (TERMINAL.has(call.status)) {
      if (call.stopRequested && !TERMINAL.has(status)) await this.stop(id, 'Late call status received; stop enforced.');
      return;
    }
    const sequence = Number(payload.SequenceNumber);
    if (!TERMINAL.has(status) && Number.isFinite(sequence) && sequence <= call.lastSequence) return;
    if (Number.isFinite(sequence)) call.lastSequence = Math.max(call.lastSequence, sequence);
    if (TERMINAL.has(status)) this.finish(call, status);
    else {
      this.store.update(call, { status: ['queued', 'initiated'].includes(status) ? 'dialing' : status });
      if (call.stopRequested) await this.stop(id, 'Stop request confirmed.');
    }
  }
  finish(call, status) {
    if (TERMINAL.has(call.status)) return;
    clearTimeout(this.timers.get(call.id));
    this.timers.delete(call.id);
    this.store.update(call, { status, endedAt: new Date(this.now()).toISOString() });
    const bridge = this.bridges.get(call.id);
    this.bridges.delete(call.id);
    bridge?.close('Phone call ended.');
    this.store.event(call, `Call ${status}.`);
    // No model report means unconfirmed, never infer success from transport status.
    if (!call.outcome) this.store.update(call, { outcome: {
      status: 'needs-user', summary: 'No confirmed goal outcome was reported. Review the transcript before deciding what to do next.',
      confirmedDetails: [], nextSteps: ['Review the conversation and verify any agreement directly.'], source: 'system',
    } });
  }
  transcript(call, item) {
    if (!item.text) return;
    const last = call.transcript.at(-1);
    if (last && last.speaker === item.speaker && last.text.length < 1600 && item.startMs != null && last.endMs != null && item.startMs - last.endMs < 1800) {
      last.text += item.text;
      last.endMs = item.endMs;
    } else call.transcript.push({ ...item, at: new Date(this.now()).toISOString() });
    this.store.save();
  }
  async recover() {
    for (const call of this.store.state.calls.filter(c => !TERMINAL.has(c.status))) {
      call.stopRequested = true;
      if (call.status === 'preparing') { this.finish(call, 'canceled'); continue; }
      this.armDeadline(call);
      await this.stop(call.id, 'Recovered after server restart; previous call stopped.').catch(() => {});
    }
  }
  dispose() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const bridge of this.bridges.values()) bridge.close('Server shutting down.');
    this.bridges.clear();
  }
}
