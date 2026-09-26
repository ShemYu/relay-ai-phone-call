import { AppError } from './calls.js';
import { TERMINAL } from './store.js';

const MAX_LISTENERS = 4;
const MAX_PENDING_BYTES = 64 * 1024;
const HEARTBEAT_MS = 10_000;

function validFrame(frame) {
  return frame && ['recipient', 'assistant'].includes(frame.track)
    && frame.sampleRate === 8000 && Number.isFinite(frame.timestampMs) && frame.timestampMs >= 0
    && typeof frame.payload === 'string' && frame.payload.length > 0 && frame.payload.length <= 256_000
    && frame.payload.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(frame.payload);
}

/** Live, receive-only fan-out. Frames are never retained or written to the store. */
export class CallMonitor {
  constructor({ store }) {
    this.store = store;
    this.listeners = new Map();
    this.listenerCount = 0;
    this.heartbeatTimer = undefined;
    this.disposed = false;
  }

  subscribe(req, res, callId) {
    if (this.disposed) throw new AppError(503, 'Live call monitoring is shutting down.');
    const call = this.store.call(callId);
    if (!call) throw new AppError(404, 'Call not found.');
    if (TERMINAL.has(call.status)) throw new AppError(409, 'This call has ended. Live audio is no longer available.');
    if (this.listenerCount >= MAX_LISTENERS) throw new AppError(429, 'The live listener limit has been reached.');

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    const listener = { req, res, callId, closed: false };
    listener.disconnect = () => this.remove(listener);
    listener.error = () => this.remove(listener, 'destroy');
    req.once('aborted', listener.error);
    res.once('close', listener.disconnect);
    res.once('error', listener.error);
    if (!this.listeners.has(callId)) this.listeners.set(callId, new Set());
    this.listeners.get(callId).add(listener);
    this.listenerCount++;
    try {
      res.flushHeaders?.();
      this.write(listener, 'event: ready\ndata: {"sampleRate":8000,"encoding":"audio/pcmu"}\n\n');
    } catch {
      this.remove(listener, 'destroy');
    }
    if (this.listenerCount && this.heartbeatTimer === undefined) {
      this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
      this.heartbeatTimer.unref?.();
    }
  }

  write(listener, message) {
    if (listener.closed) return false;
    const { res } = listener;
    try {
      if (res.destroyed || res.writableEnded || res.writableLength > MAX_PENDING_BYTES) {
        this.remove(listener, 'destroy');
        return false;
      }
      // A single valid large frame is allowed. If it remains buffered, the next
      // write or heartbeat disconnects this listener before accepting more.
      // No drain queue or replay buffer is created by the monitor.
      res.write(message);
      return true;
    } catch {
      this.remove(listener, 'destroy');
      return false;
    }
  }

  remove(listener, closeResponse) {
    if (listener.closed) return;
    listener.closed = true;
    const group = this.listeners.get(listener.callId);
    group?.delete(listener);
    if (!group?.size) this.listeners.delete(listener.callId);
    this.listenerCount--;
    listener.req.off('aborted', listener.error);
    listener.res.off('close', listener.disconnect);
    listener.res.off('error', listener.error);
    if (!this.listenerCount && this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    try {
      if (closeResponse === 'destroy') listener.res.destroy();
      else if (closeResponse === 'end') listener.res.end();
    } catch { /* A broken observer must not affect the telephone call. */ }
  }

  publish(callId, frame) {
    // This function runs in the live audio path. Never propagate an observer
    // error, malformed frame, or disconnected HTTP response into that path.
    try {
      if (this.disposed || !this.listeners.has(callId) || !validFrame(frame)) return;
      const call = this.store.call(callId);
      if (!call || TERMINAL.has(call.status)) { this.end(callId); return; }
      const { track, payload, sampleRate, timestampMs } = frame;
      const message = `event: audio\ndata: ${JSON.stringify({ track, payload, sampleRate, timestampMs })}\n\n`;
      for (const listener of [...this.listeners.get(callId)]) this.write(listener, message);
    } catch { /* Monitoring is optional and may never interrupt the call. */ }
  }

  heartbeat() {
    for (const [callId, listeners] of [...this.listeners]) {
      try {
        const call = this.store.call(callId);
        if (!call || TERMINAL.has(call.status)) { this.end(callId); continue; }
        for (const listener of [...listeners]) this.write(listener, ': heartbeat\n\n');
      } catch {
        // If the store cannot confirm this call, stop observation without
        // altering the call or attempting to recover any audio.
        this.end(callId);
      }
    }
  }

  end(callId) {
    for (const listener of [...(this.listeners.get(callId) ?? [])]) {
      this.write(listener, 'event: ended\ndata: {}\n\n');
      this.remove(listener, 'end');
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const callId of [...this.listeners.keys()]) this.end(callId);
  }
}
