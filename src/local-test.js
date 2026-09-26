import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { z } from 'zod';
import { briefSchema, buildSession, openingLine } from './brief.js';
import { AppError } from './calls.js';

const requestSchema = z.object({ sdp: z.string().min(1).max(65_536).startsWith('v=0'), brief: briefSchema });

export function browserSession(brief, backendModel) {
  const session = buildSession(brief, backendModel);
  // WebRTC negotiates its own codec. Keep the telephone prompt, voice and tools.
  delete session.audio.format;
  return session;
}

export class LocalTests {
  constructor({ config, isPhoneActive = () => false, fetchImpl = fetch, WebSocketImpl = WebSocket,
    now = () => Date.now(), leaseMs = 90_000, closeMs = 15_000, attachMs = 10_000 }) {
    Object.assign(this, { config, isPhoneActive, fetchImpl, WebSocketImpl, now, leaseMs, closeMs, attachMs });
    this.current = null;
    this.records = new Map();
  }
  active() { return Boolean(this.current && !this.current.done); }
  snapshot(record) {
    return { active: !record.done, closing: record.stopping, closeSent: Boolean(record.closeSent), finalized: record.finalized,
      usage: record.usage, error: record.error };
  }
  get(id) {
    const record = this.records.get(id);
    if (!record) throw new AppError(404, 'Browser test not found.');
    return record;
  }
  armLease(record) {
    clearTimeout(record.leaseTimer);
    if (record.done || record.stopping) return;
    record.leaseTimer = setTimeout(() => this.requestClose(record), this.leaseMs);
    record.leaseTimer.unref?.();
  }
  heartbeat(id) {
    const record = this.get(id);
    this.armLease(record);
    return this.snapshot(record);
  }
  finish(record, finalized = false) {
    if (record.done) return;
    record.done = true;
    record.finalized = finalized;
    clearTimeout(record.leaseTimer);
    clearTimeout(record.closeTimer);
    clearTimeout(record.attachTimer);
    if (record.socket?.readyState === 1) record.socket.close();
    else if (record.socket?.readyState === 0) record.socket.terminate();
    if (this.current === record) this.current = null;
  }
  requestClose(record) {
    if (record.done) return;
    record.stopping = true;
    clearTimeout(record.leaseTimer);
    if (!record.sessionId) return; // A late create response is closed on attach.
    if (record.socket?.readyState === 1 && !record.closeSent) {
      try {
        record.socket.send(JSON.stringify({ type: 'session.close', event_id: randomUUID() }));
        record.closeSent = true;
      } catch {
        record.error = 'The browser test control connection was lost. End the browser test.';
      }
    }
    record.closeTimer ??= setTimeout(() => {
      record.error ||= 'The browser test ended without confirmed final voice usage.';
      this.finish(record);
    }, this.closeMs);
    record.closeTimer.unref?.();
  }
  stop(id) {
    const record = this.get(id);
    this.requestClose(record);
    return this.snapshot(record);
  }
  attach(record) {
    // Only lifecycle and final usage belong to this socket. The browser owns
    // greeting, tool execution and captions; audio stays on WebRTC throughout.
    const socket = new this.WebSocketImpl(`wss://api.openai.com/v1/live/sessions/${encodeURIComponent(record.sessionId)}/attach`, {
      headers: { Authorization: `Bearer ${this.config.apiKey}`, 'User-Agent': 'ai-phone-call/Node 0.1.0' },
      maxPayload: 2 * 1024 * 1024,
    });
    record.socket = socket;
    const failed = () => {
      if (record.done) return;
      record.error = 'The browser test control connection was lost. End the browser test.';
      this.requestClose(record);
    };
    socket.on('open', () => {
      clearTimeout(record.attachTimer);
      if (record.stopping) this.requestClose(record);
    });
    socket.on('message', raw => {
      let event;
      try { event = JSON.parse(raw.toString()); } catch { return; }
      if (event.type === 'session.usage.updated') record.usage = event.usage ?? record.usage;
      if (event.type === 'session.closed') {
        record.usage = event.usage ?? record.usage;
        this.finish(record, true);
      }
      if (event.type === 'error') failed();
      // Reflected audio and private transcript content are neither retained nor logged.
    });
    socket.on('error', failed);
    socket.on('close', () => { if (!record.done) failed(); });
    record.attachTimer = setTimeout(failed, this.attachMs);
    record.attachTimer.unref?.();
  }
  async start(input, { signal } = {}) {
    const { sdp, brief } = requestSchema.parse(input);
    if (!this.config.apiKey) throw new AppError(503, 'Set the OpenAI API key before starting a browser test.');
    if (this.active() || this.isPhoneActive()) throw new AppError(409, 'End the active call or browser test first.');
    const record = { id: randomUUID(), sessionId: null, done: false, stopping: false,
      finalized: false, usage: null, error: null, createdAt: this.now() };
    this.current = record; // Reserve synchronously, before the first upstream await.
    this.records.set(record.id, record);
    for (const [id, old] of this.records) {
      if (this.records.size <= 20) break;
      if (old.done) this.records.delete(id);
    }
    const cancel = () => this.requestClose(record);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    this.armLease(record);
    try {
      if (record.stopping) throw new AppError(409, 'Browser test canceled before connecting.');
      const response = await this.fetchImpl('https://api.openai.com/v1/live/sessions', {
        method: 'POST', headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: browserSession(brief, this.config.backendModel), transport: { type: 'webrtc', sdp } }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError(502, 'OpenAI could not start the browser test. Check key access, quota, and connection.');
      }
      const result = await response.json();
      if (typeof result?.session?.id === 'string' && result.session.id) {
        record.sessionId = result.session.id;
        this.attach(record);
      }
      if (!record.sessionId || typeof result.transport?.sdp !== 'string'
          || result.transport.type !== 'webrtc') throw new AppError(502, 'OpenAI returned an incomplete browser connection.');
      if (record.stopping) this.requestClose(record);
      return { id: record.id, session: { id: record.sessionId }, transport: { type: 'webrtc', sdp: result.transport.sdp },
        openingInstruction: `Greet the recipient now in ${brief.language || 'English'}. Say this opening: ${openingLine(brief)}. Then pause and listen.` };
    } catch (error) {
      if (record.sessionId) this.requestClose(record);
      else this.finish(record);
      if (error instanceof AppError || error instanceof z.ZodError) throw error;
      throw new AppError(502, 'The browser connection could not be confirmed. No automatic retry was made.');
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }
  dispose() {
    for (const record of this.records.values()) this.requestClose(record);
  }
}
