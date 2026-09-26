const RATE = 8000;
const TRACKS = ['recipient', 'assistant'];
const MAX_PAYLOAD_CHARS = 256000;

export function decodePcmu(payload) {
  if (typeof payload !== 'string' || !payload.length || payload.length > MAX_PAYLOAD_CHARS
    || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) throw new Error('Invalid PCMU audio.');
  const bytes = atob(payload);
  if (!bytes.length) throw new Error('Empty PCMU audio.');
  const samples = new Float32Array(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) {
    const value = ~bytes.charCodeAt(index) & 255;
    const magnitude = (((value & 15) << 3) + 132) << ((value >> 4) & 7);
    samples[index] = ((value & 128) ? 132 - magnitude : magnitude - 132) / 32768;
  }
  return samples;
}

export class MonitorBufferError extends Error {}

// Timestamp values share the server's monotonic clock; only their differences
// are compared with the AudioContext clock. Each speaker has an independent
// timeline so simultaneous speech is mixed rather than serialized.
export class MonitorTimeline {
  constructor({ leadSeconds = 0.08, maxQueueSeconds = 2, maxLateSeconds = 0.75, maxSourcesPerTrack = 128 } = {}) {
    Object.assign(this, { leadSeconds, maxQueueSeconds, maxLateSeconds, maxSourcesPerTrack });
    this.reset();
  }
  reset() {
    this.originTimestamp = null;
    this.originAudioTime = null;
    this.tracks = new Map();
  }
  plan(track, sampleCount, timestampMs, now, sourceCount = 0) {
    if (!TRACKS.includes(track) || !Number.isInteger(sampleCount) || sampleCount < 1
      || !Number.isFinite(timestampMs) || timestampMs < 0 || !Number.isFinite(now)) throw new Error('Invalid audio timing.');
    if (this.originTimestamp === null) {
      this.originTimestamp = timestampMs;
      this.originAudioTime = now + this.leadSeconds;
    }
    const previous = this.tracks.get(track);
    if (previous && timestampMs < previous.timestampMs) throw new MonitorBufferError('Audio arrived out of order.');
    const desired = this.originAudioTime + (timestampMs - this.originTimestamp) / 1000;
    const duration = sampleCount / RATE;
    const startsAt = Math.max(desired, previous?.endsAt ?? 0, now + 0.01);
    const endsAt = startsAt + duration;
    if (desired < now - this.maxLateSeconds || endsAt - now > this.maxQueueSeconds || sourceCount >= this.maxSourcesPerTrack) {
      throw new MonitorBufferError('Listening fell behind the live call.');
    }
    this.tracks.set(track, { timestampMs, endsAt });
    return { startsAt, endsAt, duration };
  }
}

export class PcmuMonitorPlayer {
  constructor(context, { volume = 0.8, muted = false, ...limits } = {}) {
    this.context = context;
    this.timeline = new MonitorTimeline(limits);
    this.sources = new Map(TRACKS.map((track) => [track, new Set()]));
    this.output = context.createGain();
    this.output.gain.value = muted ? 0 : volume;
    this.output.connect(context.destination);
    this.trackOutputs = new Map(TRACKS.map((track) => {
      const gain = context.createGain();
      gain.gain.value = 0.5; // Headroom for two full-scale simultaneous tracks.
      gain.connect(this.output);
      return [track, gain];
    }));
    this.closed = false;
  }
  setVolume(volume, muted) {
    if (!this.closed) this.output.gain.setTargetAtTime(muted ? 0 : Math.max(0, Math.min(1, volume)), this.context.currentTime, 0.01);
  }
  enqueue(frame) {
    if (this.closed) return;
    if (!frame || frame.sampleRate !== RATE || !TRACKS.includes(frame.track)) throw new Error('Unsupported preview audio format.');
    if (this.context.state !== 'running') throw new Error('Audio playback is no longer running.');
    const samples = decodePcmu(frame.payload);
    const sources = this.sources.get(frame.track);
    const timing = this.timeline.plan(frame.track, samples.length, frame.timestampMs, this.context.currentTime, sources.size);
    const buffer = this.context.createBuffer(1, samples.length, RATE);
    buffer.copyToChannel(samples, 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.trackOutputs.get(frame.track));
    source.onended = () => { sources.delete(source); source.disconnect(); };
    sources.add(source);
    source.start(timing.startsAt);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const sources of this.sources.values()) {
      for (const source of [...sources]) {
        source.onended = null;
        try { source.stop(); } catch { /* It may already have ended. */ }
        source.disconnect();
        source.buffer = null;
      }
      sources.clear();
    }
    this.timeline.reset();
    for (const gain of this.trackOutputs.values()) gain.disconnect();
    this.output.disconnect();
  }
}

/**
 * Local, receive-only monitor. setCall({id, active}) never starts playback.
 * Only the explicit Listen button opens an EventSource or AudioContext.
 * dispose()/stop() close preview resources without invoking a phone API.
 */
export function createCallMonitor({ root, AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext, EventSourceImpl = globalThis.EventSource }) {
  const listen = root.querySelector('[data-monitor-listen]');
  const stopButton = root.querySelector('[data-monitor-stop]');
  const muteButton = root.querySelector('[data-monitor-mute]');
  const volumeInput = root.querySelector('[data-monitor-volume]');
  const volumeValue = root.querySelector('[data-monitor-volume-value]');
  const status = root.querySelector('[data-monitor-status]');
  let selected = null;
  let session = null;
  let disposed = false;
  let muted = false;
  let volume = Number(volumeInput.value) / 100;
  const supported = Boolean(AudioContextImpl && EventSourceImpl);

  function render() {
    listen.disabled = disposed || !supported || !selected?.active || Boolean(session);
    stopButton.hidden = !session;
    muteButton.disabled = !session;
    muteButton.textContent = muted ? 'Unmute' : 'Mute';
    muteButton.setAttribute('aria-pressed', String(muted));
    volumeValue.textContent = `${Math.round(volume * 100)}%`;
  }
  function message(state, text) {
    root.dataset.monitorState = state;
    status.textContent = text;
  }
  function release(current) {
    if (!current || current.closed) return;
    current.closed = true;
    clearTimeout(current.readyTimer);
    current.source?.close(); // Suppress EventSource's automatic reconnect.
    current.player?.close();
    if (current.context) {
      current.context.onstatechange = null;
      if (current.context.state !== 'closed') current.context.close().catch(() => {});
    }
    if (session === current) session = null;
  }
  function stop(state = 'stopped', text = 'Listening stopped. The phone call continues.') {
    release(session);
    message(state, text);
    render();
  }
  function fail(current, text) {
    if (session !== current || current.closed) return;
    stop('error', `${text} Click Listen to try again. The phone call is unaffected.`);
  }

  async function start() {
    if (disposed || session || !selected?.active || !supported) return;
    const current = { callId: selected.id, closed: false, ready: false, heardAudio: false };
    session = current;
    message('connecting', 'Connecting to the live audio preview…');
    render();
    try {
      current.context = new AudioContextImpl();
      current.readyTimer = setTimeout(() => fail(current, 'Browser audio playback did not start.'), 8000);
      await current.context.resume();
      if (current.closed || session !== current || selected?.id !== current.callId || !selected?.active) { release(current); return; }
      if (current.context.state !== 'running') throw new Error('Browser audio could not start.');
      clearTimeout(current.readyTimer);
      current.player = new PcmuMonitorPlayer(current.context, { volume, muted });
      current.context.onstatechange = () => {
        if (session === current && !current.closed && current.context.state !== 'running') fail(current, 'Browser audio playback paused.');
      };
      current.source = new EventSourceImpl(`/api/calls/${encodeURIComponent(current.callId)}/audio`);
      current.readyTimer = setTimeout(() => fail(current, 'The audio preview did not become ready.'), 12000);
      current.source.addEventListener('ready', ({ data }) => {
        if (session !== current || current.closed) return;
        try {
          const format = JSON.parse(data);
          if (format.sampleRate !== RATE || format.encoding !== 'audio/pcmu') throw new Error();
          if (current.ready) throw new Error();
          current.ready = true;
          clearTimeout(current.readyTimer);
          message('listening', 'Listening is on. Waiting for live audio…');
        } catch { fail(current, 'The preview audio format could not be confirmed.'); }
      });
      current.source.addEventListener('audio', ({ data }) => {
        if (session !== current || current.closed) return;
        try {
          if (!current.ready) throw new Error('Audio arrived before the preview was ready.');
          current.player.enqueue(JSON.parse(data));
          if (!current.heardAudio) {
            current.heardAudio = true;
            message('listening', 'Listening to both sides of this call.');
          }
        } catch (error) {
          fail(current, error instanceof MonitorBufferError ? 'Listening fell behind; queued preview audio was discarded.' : 'The live audio preview could not continue.');
        }
      });
      current.source.addEventListener('ended', () => {
        if (session === current && !current.closed) stop('ended', 'The live audio stream ended. There is no replay in this monitor.');
      });
      current.source.addEventListener('error', () => fail(current, 'The listening connection was interrupted.'));
    } catch {
      fail(current, 'Listening could not start. Check browser audio access and the selected call.');
    }
  }

  function mute() { muted = !muted; session?.player?.setVolume(volume, muted); render(); }
  function changeVolume() { volume = Math.max(0, Math.min(100, Number(volumeInput.value))) / 100; session?.player?.setVolume(volume, muted); render(); }
  function stopClicked() { stop(); }
  listen.addEventListener('click', start);
  stopButton.addEventListener('click', stopClicked);
  muteButton.addEventListener('click', mute);
  volumeInput.addEventListener('input', changeVolume);

  function setCall(call) {
    if (disposed) return;
    const changed = selected?.id !== call?.id;
    if (changed) release(session);
    selected = call?.id ? { id: call.id, active: Boolean(call.active) } : null;
    if (!supported) message('unavailable', 'This browser does not support live audio listening.');
    else if (!selected) message('idle', 'Select an active call to listen.');
    else if (!selected.active) {
      release(session);
      message('ended', 'This call is no longer active. There is no replay in this monitor.');
    } else if (changed) message('idle', 'Press Listen to hear this call from this point onward.');
    render();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    release(session);
    listen.removeEventListener('click', start);
    stopButton.removeEventListener('click', stopClicked);
    muteButton.removeEventListener('click', mute);
    volumeInput.removeEventListener('input', changeVolume);
    render();
  }
  setCall(null);
  return { setCall, stop, dispose };
}
