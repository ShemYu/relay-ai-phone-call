import { timingSafeEqual, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { openingLine, outcomeSchema } from './brief.js';

const OPEN = 1;

export function validateOutcome(value) {
  const result = outcomeSchema.safeParse(value);
  return result.success ? result.data : null;
}

function equalToken(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function audioByteLength(payload) {
  if (typeof payload !== 'string' || !payload || payload.length > 256_000
      || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return 0;
  return Buffer.byteLength(payload, 'base64');
}

/**
 * Bridge a signature-verified Twilio Media Stream to the Live API. The server
 * still owns outbound call permission, Twilio signatures, and PSTN hangup.
 * Protocol references: OpenAI voice-websockets/live-delegation/live-conversations
 * and Twilio voice/media-streams/websocket-messages (checked 2026-09-24).
 */
export function createLiveBridge({
  providerSocket, call, apiKey, sessionConfig,
  onTranscript = () => {}, onEvent = () => {}, onSession = () => {},
  onUsage = () => {}, onOutcome = () => {}, onEnd = () => {},
  onAudio = () => {}, onAudioEnd = () => {},
  onFailure = () => {}, onProviderCallSid = () => {}, onConnected = () => {}, WebSocketImpl = WebSocket,
  // Injectable deadlines keep transport-failure tests fast without real calls.
  timeouts = {},
  inputClock = { now: () => performance.now(), setTimeout, clearTimeout },
}) {
  const startupMs = timeouts.startupMs ?? 15_000;
  const finalizeMs = timeouts.finalizeMs ?? 5_000;
  const drainMs = timeouts.drainMs ?? 8_000;
  const attachMs = timeouts.attachMs ?? 60_000;
  const initialProviderSocket = providerSocket;
  providerSocket = undefined;
  let liveSocket;
  let streamSid;
  let started = false;
  let requested = false;
  let closing = false;
  let finalized = false;
  let terminalNotified = false;
  let lastVoiceUsage = null;
  let inputBytes = 0;
  let inputTimer;
  let nextInputAt;
  let finalizeTimer;
  let drainTimer;
  let attachTimer;
  let endMarker;
  let endReason;
  let outputStopped = false;
  let connected = false;
  let audioEnded = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Direct stream users need not await prepare(); still handle readiness failure.
  ready.catch(() => {});
  const inputQueue = [];
  const responses = new Map();
  const currentResponses = new Map();
  const toolCalls = new Map();
  const eventIds = new Set();
  const startupTimer = setTimeout(() => fail('The voice connection did not become ready in time.'), startupMs);
  startupTimer.unref?.();

  function emit(message) { onEvent(message); }
  function copyAudio(track, payload) {
    if (closing || audioEnded) return;
    // Listening is an optional observer: it never owns phone delivery or its
    // pacing, and a broken listener must not terminate the telephone call.
    try { onAudio({ track, payload, sampleRate: 8000, timestampMs: performance.now() })?.catch?.(() => {}); } catch {}
  }
  function endAudio() {
    if (audioEnded) return;
    audioEnded = true;
    try { onAudioEnd()?.catch?.(() => {}); } catch {}
  }
  function send(socket, value) {
    if (socket?.readyState !== OPEN) return false;
    socket.send(JSON.stringify(value));
    return true;
  }
  function sendLive(value) { return !closing && send(liveSocket, value); }
  function reportIncomplete() {
    if (!finalized) onUsage(lastVoiceUsage, false);
  }
  function closeTransport(socket) {
    if (!socket || socket.readyState >= 2) return;
    // ws.close() during CONNECTING emits an error; listeners are installed first.
    socket.close();
  }
  function release() {
    endAudio();
    clearTimeout(finalizeTimer);
    clearTimeout(startupTimer);
    inputClock.clearTimeout(inputTimer);
    clearTimeout(drainTimer);
    clearTimeout(attachTimer);
    closeTransport(liveSocket);
    closeTransport(providerSocket);
  }
  function close(reason = 'Call ended') {
    if (closing) return;
    closing = true;
    endAudio();
    rejectReady(new Error(reason));
    outputStopped = true;
    clearTimeout(startupTimer);
    inputClock.clearTimeout(inputTimer);
    clearTimeout(drainTimer);
    clearTimeout(attachTimer);
    inputQueue.length = 0;
    inputBytes = 0;
    closeTransport(providerSocket);
    if (started && liveSocket?.readyState === OPEN && !finalized) {
      send(liveSocket, { type: 'session.close', event_id: randomUUID() });
      finalizeTimer = setTimeout(() => {
        reportIncomplete();
        emit('Final voice usage could not be confirmed before the connection closed.');
        release();
        liveSocket?.terminate?.();
      }, finalizeMs);
      finalizeTimer.unref?.();
    } else {
      reportIncomplete();
      release();
    }
  }
  function notifyTerminal(callback, reason) {
    if (terminalNotified) return;
    terminalNotified = true;
    // Hangup happens in the owning server; a failed callback must not create an
    // unhandled rejection or cause a second attempt with an unknown outcome.
    try {
      Promise.resolve(callback(reason)).catch(() => emit('The provider call status needs to be checked.'));
    } catch { emit('The provider call status needs to be checked.'); }
  }
  function fail(reason) {
    if (closing) return;
    notifyTerminal(onFailure, reason);
    close(reason);
  }
  function end(reason) {
    if (closing) return;
    notifyTerminal(onEnd, reason);
    close(reason);
  }

  // The outbound flow prepares Live before dialing, so audio begins without a
  // startup backlog. Preserve early frames for direct stream integrations too.
  // Advance an absolute sample clock, not "now + frame duration": scheduling
  // delays must not accumulate on every frame and eventually fill the queue.
  // Recover at most 100ms after a stall, keeping startup audio paced as well.
  function pumpInput() {
    if (!started || closing || !inputQueue.length || inputTimer !== undefined) return;
    const now = inputClock.now();
    // 80ms of clock debt plus the current 20ms frame is at most 100ms.
    nextInputAt = Math.max(nextInputAt ?? now, now - 80);
    while (inputQueue.length && !closing) {
      const wait = nextInputAt - inputClock.now();
      if (wait > 0) {
        inputTimer = inputClock.setTimeout(() => { inputTimer = undefined; pumpInput(); }, Math.ceil(wait));
        inputTimer.unref?.();
        return;
      }
      const chunk = inputQueue.shift();
      inputBytes -= chunk.bytes;
      if (!sendLive({ type: 'session.input_audio.append', audio: chunk.payload })) return;
      nextInputAt += chunk.bytes / 8;
    }
  }
  function queueInput(payload) {
    const bytes = audioByteLength(payload);
    if (!bytes) return fail('The phone provider sent an invalid audio frame.');
    if (inputBytes + bytes > 32_000) return fail('The voice connection fell too far behind the call.');
    // An idle source cannot build up credit to send its next burst all at once.
    if (started && !inputQueue.length && inputTimer === undefined) {
      nextInputAt = Math.max(nextInputAt ?? 0, inputClock.now());
    }
    // Twilio normally supplies 20ms frames; normalize larger packets so a
    // delayed packet cannot bypass pacing with several seconds in one append.
    const audio = Buffer.from(payload, 'base64');
    for (let offset = 0; offset < audio.length; offset += 160) {
      const frame = audio.subarray(offset, offset + 160);
      inputQueue.push({ payload: frame.toString('base64'), bytes: frame.length });
    }
    inputBytes += bytes;
    pumpInput();
    copyAudio('recipient', payload);
  }

  function requestEnd(reason) {
    if (endMarker || closing) return;
    endReason = reason;
    // The end_call tool contract requires saying goodbye first. Freeze later
    // output, then use a mark to confirm the audio already queued at Twilio has
    // played. Live has no output-audio-done event to substitute for this barrier.
    outputStopped = true;
    endMarker = `end_${randomUUID()}`;
    if (!send(providerSocket, { event: 'mark', streamSid, mark: { name: endMarker } })) {
      end(reason);
      return;
    }
    drainTimer = setTimeout(() => {
      emit('The call ended after the bounded audio-playback wait; final playback was not confirmed.');
      end(reason);
    }, drainMs);
    drainTimer.unref?.();
  }

  async function executeTool(item) {
    if (!connected) return { error: 'The recipient has not connected yet. Wait for the phone stream.' };
    let args;
    try {
      if (typeof item.arguments !== 'string' || item.arguments.length > 24_000) throw new Error();
      args = JSON.parse(item.arguments);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error();
    } catch { return { error: 'Invalid function arguments.' }; }
    if (item.name === 'report_call_outcome') {
      const outcome = validateOutcome(args);
      if (!outcome) return { error: 'Invalid outcome. Supply status, summary, confirmedDetails, and nextSteps.' };
      try {
        await onOutcome(outcome);
        return { saved: true, attribution: 'model-reported; review the transcript for confirmation' };
      } catch { return { error: 'The call outcome could not be saved.' }; }
    }
    if (item.name === 'end_call') {
      // Start draining only after returning every result and continuing the
      // response, so no function result is stranded by session.close.
      endReason ??= 'The assistant ended the call after its goodbye.';
      return { accepted: true, message: 'The call will end after the currently queued audio plays. Do not speak again.' };
    }
    return { error: 'Unknown function.' };
  }

  function responseRecord(envelope, event) {
    const delegationId = envelope.delegation_id ?? 'session';
    const responseId = event.response?.id ?? event.response_id ?? currentResponses.get(delegationId) ?? 'pending';
    if (event.type === 'response.created' && event.response?.id) currentResponses.set(delegationId, responseId);
    const key = `${delegationId}:${responseId}`;
    if (!responses.has(key)) responses.set(key, { key, calls: new Map(), complete: false, continuing: false });
    return responses.get(key);
  }
  async function continueResponse(record) {
    if (!record.complete || !record.calls.size || record.continuing || closing) return;
    record.continuing = true;
    for (const [id, work] of record.calls) {
      const output = await work.result;
      if (closing) return;
      if (!work.submitted) {
        if (!sendLive({ type: 'response.item.create', event_id: randomUUID(), item: {
          type: 'function_call_output', call_id: id, output: JSON.stringify(output),
        } })) return;
        work.submitted = true;
      }
    }
    sendLive({ type: 'response.create', event_id: randomUUID() });
    if (endReason) requestEnd(endReason);
  }
  function handleResponse(envelope) {
    const event = envelope.event;
    if (!event || typeof event.type !== 'string') return;
    if (event.type === 'response.failed' || event.type === 'response.incomplete') {
      return fail('The reasoning backend could not complete its work.');
    }
    if (!['response.created', 'response.output_item.done', 'response.completed'].includes(event.type)) return;
    const record = responseRecord(envelope, event);
    if (event.type === 'response.output_item.done' && event.item?.type === 'function_call'
        && event.item.status === 'completed') {
      const item = event.item;
      if (typeof item.call_id !== 'string' || !item.call_id) return fail('The reasoning backend sent an invalid function call.');
      if (!toolCalls.has(item.call_id)) toolCalls.set(item.call_id, { result: executeTool(item), submitted: false });
      record.calls.set(item.call_id, toolCalls.get(item.call_id));
    }
    if (event.type === 'response.completed') {
      record.complete = true;
      if (event.response?.usage && !record.usageReported) {
        record.usageReported = true;
        onUsage({ backend: event.response.usage, responseId: event.response.id }, false);
      }
    }
    continueResponse(record).catch(() => fail('The reasoning result could not be processed.'));
  }

  function liveMessage(raw) {
    try {
      const event = JSON.parse(raw.toString());
      if (event.event_id) {
        if (eventIds.has(event.event_id)) return;
        eventIds.add(event.event_id);
        // Cap bookkeeping for a long call. Tool side effects have their own IDs.
        if (eventIds.size > 20_000) eventIds.delete(eventIds.values().next().value);
      }
      if (event.type === 'session.closed') {
        if (finalized) return;
        finalized = true;
        rejectReady(new Error('The voice session ended before it was ready.'));
        lastVoiceUsage = event.usage ?? lastVoiceUsage;
        onUsage(lastVoiceUsage, true);
        emit(`Voice session finalized (${event.reason ?? 'closed'}).`);
        if (!closing) notifyTerminal(onEnd, 'The voice session ended.');
        closing = true;
        release();
        return;
      }
      if (event.type === 'session.usage.updated') {
        lastVoiceUsage = event.usage;
        onUsage(lastVoiceUsage, false);
        return;
      }
      // Final transcript fragments can arrive while graceful close is pending.
      if (event.type === 'session.input_transcript.delta' || event.type === 'session.output_transcript.delta') {
        if (connected && typeof event.delta === 'string') onTranscript({
          speaker: event.type === 'session.input_transcript.delta' ? 'recipient' : 'assistant',
          text: event.delta, startMs: event.start_ms, endMs: event.end_ms,
        });
        return;
      }
      if (closing) return;
      if (event.type === 'session.started') {
        if (started) return;
        if (typeof event.session?.id !== 'string' || !event.session.id) {
          return fail('The voice service did not return a valid session identifier.');
        }
        started = true;
        clearTimeout(startupTimer);
        onSession(event.session?.id);
        if (closing) return;
        if (!streamSid) {
          attachTimer = setTimeout(() => fail('The phone stream did not connect to the prepared voice session in time.'), attachMs);
          attachTimer.unref?.();
        }
        resolveReady();
        connectAudio();
      } else if (event.type === 'session.output_audio.delta' && connected && !outputStopped) {
        if (!audioByteLength(event.delta)) return fail('The voice model sent an invalid audio frame.');
        if (providerSocket.bufferedAmount > 256_000) return fail('The phone audio connection is too slow.');
        if (send(providerSocket, { event: 'media', streamSid, media: { payload: event.delta } })) {
          copyAudio('assistant', event.delta);
        }
      } else if (event.type === 'response.event') {
        handleResponse(event);
      } else if (event.type === 'error') {
        fail('The voice service rejected a session operation. Check model access and configuration.');
      }
    } catch { fail('The voice service returned an unreadable event.'); }
  }

  function connectAudio() {
    if (!started || !streamSid || closing || connected) return;
    clearTimeout(attachTimer);
    connected = true;
    onConnected();
    emit('Phone audio connected to GPT-Live.');
    sendLive({ type: 'session.instructions.append', event_id: randomUUID(), delegation_id: null,
      content: `Greet the recipient now in ${call.language || 'English'}. Say this opening: ${call.openingLine || openingLine(call)}. Then pause and listen.` });
    pumpInput();
  }

  function prepare() {
    if (!liveSocket && !closing) {
      try { connectLive(); }
      catch { fail('The OpenAI voice connection failed.'); }
    }
    return ready;
  }

  function connectLive() {
    if (!apiKey) return fail('The OpenAI API key is not configured.');
    liveSocket = new WebSocketImpl('wss://api.openai.com/v1/live/sessions', {
      headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': 'ai-phone-call/Node 0.1.0' },
      maxPayload: 2 * 1024 * 1024,
    });
    liveSocket.on('open', () => {
      if (closing || requested) return;
      requested = true;
      sendLive({ type: 'session.start', event_id: randomUUID(), session: sessionConfig });
    });
    liveSocket.on('message', liveMessage);
    liveSocket.on('error', () => fail('The OpenAI voice connection failed.'));
    liveSocket.on('close', () => {
      if (finalized) return;
      reportIncomplete();
      if (!closing) fail('The voice connection closed before final usage was confirmed.');
      clearTimeout(finalizeTimer);
    });
  }

  function providerMessage(raw) {
    if (closing) return;
    try {
      const event = JSON.parse(raw.toString());
      if (event.event === 'start') {
        const start = event.start;
        if (streamSid) return fail('A second phone stream attempted to start.');
        if (!start || !/^CA[a-f\d]{32}$/i.test(start.callSid || '')
            || (call.providerCallSid && start.callSid !== call.providerCallSid) || start.accountSid !== call.accountSid
            || !equalToken(start.customParameters?.token, call.streamToken)) {
          return fail('The phone stream did not match the authorized call.');
        }
        const format = start.mediaFormat;
        if (!format || format.encoding !== 'audio/x-mulaw' || format.sampleRate !== 8000 || format.channels !== 1) {
          return fail('The phone stream used an unsupported audio format.');
        }
        if (typeof start.streamSid !== 'string' || !start.streamSid) return fail('The phone stream identifier was missing.');
        // A fast answer can start streaming before the outbound REST request or
        // status callback returns. Only an authenticated, token-matched stream
        // may bind the provider ID, and never replace an already-known ID.
        if (!call.providerCallSid) {
          call.providerCallSid = start.callSid;
          onProviderCallSid(start.callSid);
        }
        streamSid = start.streamSid;
        prepare();
        connectAudio();
      } else if (event.event === 'media') {
        if (!streamSid || event.streamSid !== streamSid || event.media?.track !== 'inbound') return;
        queueInput(event.media.payload);
      } else if (event.event === 'mark' && endMarker && event.mark?.name === endMarker && event.streamSid === streamSid) {
        clearTimeout(drainTimer);
        end(endReason);
      } else if (event.event === 'stop') {
        end('The recipient disconnected.');
      }
    } catch { fail('The phone provider returned an unreadable event.'); }
  }

  function attachProvider(socket) {
    if (providerSocket || closing) return false;
    providerSocket = socket;
    providerSocket.on('message', providerMessage);
    providerSocket.on('error', () => fail('The phone audio connection failed.'));
    providerSocket.on('close', () => {
      if (!closing) end('The phone audio connection closed.');
    });
    return true;
  }

  if (initialProviderSocket) attachProvider(initialProviderSocket);
  return { close, prepare, attachProvider };
}
