import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePcmu, MonitorTimeline, MonitorBufferError, PcmuMonitorPlayer, createCallMonitor } from '../public/call-monitor.js';

// Independent reference: Python standard-library audioop.ulaw2lin applied to
// all 256 G.711 mu-law codewords. No Python runtime is needed to run this test.
const pcmuReference = [
  -32124, -31100, -30076, -29052, -28028, -27004, -25980, -24956, -23932, -22908, -21884, -20860, -19836, -18812, -17788, -16764,
  -15996, -15484, -14972, -14460, -13948, -13436, -12924, -12412, -11900, -11388, -10876, -10364, -9852, -9340, -8828, -8316,
  -7932, -7676, -7420, -7164, -6908, -6652, -6396, -6140, -5884, -5628, -5372, -5116, -4860, -4604, -4348, -4092,
  -3900, -3772, -3644, -3516, -3388, -3260, -3132, -3004, -2876, -2748, -2620, -2492, -2364, -2236, -2108, -1980,
  -1884, -1820, -1756, -1692, -1628, -1564, -1500, -1436, -1372, -1308, -1244, -1180, -1116, -1052, -988, -924,
  -876, -844, -812, -780, -748, -716, -684, -652, -620, -588, -556, -524, -492, -460, -428, -396,
  -372, -356, -340, -324, -308, -292, -276, -260, -244, -228, -212, -196, -180, -164, -148, -132,
  -120, -112, -104, -96, -88, -80, -72, -64, -56, -48, -40, -32, -24, -16, -8, 0,
  32124, 31100, 30076, 29052, 28028, 27004, 25980, 24956, 23932, 22908, 21884, 20860, 19836, 18812, 17788, 16764,
  15996, 15484, 14972, 14460, 13948, 13436, 12924, 12412, 11900, 11388, 10876, 10364, 9852, 9340, 8828, 8316,
  7932, 7676, 7420, 7164, 6908, 6652, 6396, 6140, 5884, 5628, 5372, 5116, 4860, 4604, 4348, 4092,
  3900, 3772, 3644, 3516, 3388, 3260, 3132, 3004, 2876, 2748, 2620, 2492, 2364, 2236, 2108, 1980,
  1884, 1820, 1756, 1692, 1628, 1564, 1500, 1436, 1372, 1308, 1244, 1180, 1116, 1052, 988, 924,
  876, 844, 812, 780, 748, 716, 684, 652, 620, 588, 556, 524, 492, 460, 428, 396,
  372, 356, 340, 324, 308, 292, 276, 260, 244, 228, 212, 196, 180, 164, 148, 132,
  120, 112, 104, 96, 88, 80, 72, 64, 56, 48, 40, 32, 24, 16, 8, 0,
];

const silence = (samples = 160) => Buffer.alloc(samples, 255).toString('base64');
const frame = (track = 'recipient', samples = 160, timestampMs = 1000) => ({ track, payload: silence(samples), sampleRate: 8000, timestampMs });

class Gain {
  constructor() { this.gain = { value: 1, setTargetAtTime: (value) => { this.gain.value = value; } }; }
  connect() {}
  disconnect() { this.disconnected = true; }
}
class FakeContext {
  constructor() { this.currentTime = 0; this.state = 'suspended'; this.destination = {}; this.created = []; this.gains = []; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
  createGain() { const gain = new Gain(); this.gains.push(gain); return gain; }
  createBuffer(channels, length, rate) {
    assert.equal(channels, 1);
    assert.equal(rate, 8000);
    return { length, copyToChannel(data, channel) { assert.equal(data.length, length); assert.equal(channel, 0); this.samples = [...data]; } };
  }
  createBufferSource() {
    const source = { connect() {}, disconnect() { this.disconnected = true; }, start(at) { this.at = at; }, stop() { this.stopped = true; } };
    this.created.push(source);
    return source;
  }
}
class Control extends EventTarget {
  constructor() { super(); this.value = '80'; this.disabled = false; this.hidden = false; }
  setAttribute(key, value) { this[key] = value; }
}

function harness(t, Context = FakeContext) {
  const contexts = [];
  const streams = [];
  class ContextImpl extends Context { constructor() { super(); contexts.push(this); } }
  class Events extends EventTarget {
    constructor(url) { super(); this.url = url; streams.push(this); }
    close() { this.closed = true; }
    emit(type, data) { this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) })); }
  }
  const nodes = new Map(['listen', 'stop', 'mute', 'volume', 'volume-value', 'status'].map((key) => [`[data-monitor-${key}]`, new Control()]));
  const root = { dataset: {}, querySelector: (selector) => nodes.get(selector) };
  const monitor = createCallMonitor({ root, AudioContextImpl: ContextImpl, EventSourceImpl: Events });
  const click = async (name) => {
    nodes.get(`[data-monitor-${name}]`).dispatchEvent(new Event('click'));
    await Promise.resolve();
    await Promise.resolve();
  };
  const ready = () => streams.at(-1).emit('ready', { sampleRate: 8000, encoding: 'audio/pcmu' });
  t.after(() => monitor.dispose());
  return { root, nodes, monitor, streams, contexts, click, ready };
}

test('PCMU decoding matches all 256 independent reference codewords and rejects malformed input', () => {
  const payload = Buffer.from(Array.from({ length: 256 }, (_, index) => index)).toString('base64');
  assert.deepEqual(Array.from(decodePcmu(payload), (value) => Math.round(value * 32768)), pcmuReference);
  for (const input of ['', 'bad', 'A===', '{}==', null, 'A'.repeat(256004)]) assert.throws(() => decodePcmu(input));
});

test('speaker timelines overlap and preserve normal chunks without serializing the other speaker', () => {
  const timeline = new MonitorTimeline();
  const recipient = timeline.plan('recipient', 160, 1000, 10);
  const assistant = timeline.plan('assistant', 8000, 1000, 10);
  assert.equal(recipient.startsAt, 10.08);
  assert.equal(assistant.startsAt, recipient.startsAt);
  assert.equal(assistant.duration, 1);
  const nextRecipient = timeline.plan('recipient', 160, 1020, 10.02);
  assert.ok(Math.abs(nextRecipient.startsAt - 10.1) < 1e-10);
  const nextAssistant = timeline.plan('assistant', 8000, 1100, 10.1);
  assert.equal(nextAssistant.startsAt, assistant.endsAt);
  assert.equal(nextAssistant.duration, 1);
});

test('late, out-of-order and oversized backlogs stop instead of growing a queue or truncating samples', () => {
  const timeline = new MonitorTimeline();
  timeline.plan('recipient', 160, 1000, 10);
  assert.throws(() => timeline.plan('recipient', 160, 900, 10), MonitorBufferError);
  assert.throws(() => timeline.plan('recipient', 160, 1030, 12), MonitorBufferError);
  assert.throws(() => new MonitorTimeline().plan('assistant', 24000, 1000, 10), MonitorBufferError);
  assert.throws(() => new MonitorTimeline().plan('recipient', 160, 1000, 10, 128), MonitorBufferError);
  timeline.reset();
  assert.equal(timeline.plan('recipient', 160, 90000, 20).startsAt, 20.08);
});

test('player uses complete 8 kHz buffers, two-speaker gain headroom and immediate source cleanup', async () => {
  const context = new FakeContext();
  await context.resume();
  const player = new PcmuMonitorPlayer(context);
  player.enqueue(frame('recipient', 160));
  player.enqueue(frame('assistant', 8000));
  assert.equal(context.created[0].buffer.length, 160);
  assert.equal(context.created[1].buffer.length, 8000);
  assert.equal(context.created[0].at, context.created[1].at);
  assert.equal(context.gains[1].gain.value, 0.5);
  assert.equal(context.gains[2].gain.value, 0.5);
  player.setVolume(0.8, true);
  assert.equal(context.gains[0].gain.value, 0);
  player.setVolume(0.3, false);
  assert.equal(context.gains[0].gain.value, 0.3);
  player.close();
  assert.ok(context.created.every((source) => source.stopped && source.disconnected && source.buffer === null));
  assert.ok([...player.sources.values()].every((sources) => sources.size === 0));
  assert.equal(player.timeline.tracks.size, 0);
  assert.equal(context.state, 'running', 'the resource owner closes its context separately');
});

test('listening and retry require explicit clicks; SSE errors close the source without reconnecting', async (t) => {
  const h = harness(t);
  h.monitor.setCall({ id: 'call-1', active: true });
  assert.equal(h.streams.length, 0);
  await h.click('listen');
  assert.equal(h.streams[0].url, '/api/calls/call-1/audio');
  h.ready();
  h.streams[0].emit('audio', frame());
  assert.equal(h.root.dataset.monitorState, 'listening');
  h.streams[0].emit('error', {});
  assert.equal(h.streams[0].closed, true);
  assert.equal(h.contexts[0].state, 'closed');
  assert.equal(h.root.dataset.monitorState, 'error');
  assert.ok(h.contexts[0].created.every((source) => source.stopped));
  h.monitor.setCall({ id: 'call-1', active: true });
  assert.equal(h.streams.length, 1);
  await h.click('listen');
  assert.equal(h.streams.length, 2);
});

test('call switch and Stop listening flush immediately; ended calls cannot open streams', async (t) => {
  const h = harness(t);
  h.monitor.setCall({ id: 'call-1', active: true });
  await h.click('listen'); h.ready(); h.streams[0].emit('audio', frame());
  h.monitor.setCall({ id: 'call-2', active: true });
  assert.equal(h.streams[0].closed, true);
  assert.equal(h.contexts[0].state, 'closed');
  assert.equal(h.streams.length, 1);
  await h.click('listen'); h.ready(); h.streams[1].emit('audio', frame());
  await h.click('stop');
  assert.equal(h.streams[1].closed, true);
  assert.ok(h.contexts[1].created.every((source) => source.stopped));
  h.monitor.setCall({ id: 'call-2', active: false });
  await h.click('listen');
  assert.equal(h.streams.length, 2);
  assert.equal(h.nodes.get('[data-monitor-listen]').disabled, true);
});

test('canceling a pending browser-audio resume never opens a late event stream', async (t) => {
  class PendingContext extends FakeContext {
    resume() { return new Promise((resolve) => { this.finishResume = resolve; }); }
  }
  const h = harness(t, PendingContext);
  h.monitor.setCall({ id: 'call-1', active: true });
  await h.click('listen');
  await h.click('stop');
  h.contexts[0].finishResume();
  await Promise.resolve();
  assert.equal(h.contexts[0].state, 'closed');
  assert.equal(h.streams.length, 0);
});

test('the ended event flushes remaining preview audio and closes its resources', async (t) => {
  const h = harness(t);
  h.monitor.setCall({ id: 'call-1', active: true });
  await h.click('listen'); h.ready(); h.streams[0].emit('audio', frame());
  h.streams[0].emit('ended', {});
  assert.equal(h.streams[0].closed, true);
  assert.equal(h.root.dataset.monitorState, 'ended');
  assert.equal(h.contexts[0].state, 'closed');
  assert.ok(h.contexts[0].created.every((source) => source.stopped));
});
