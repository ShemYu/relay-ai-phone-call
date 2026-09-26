import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises';
import { createLiveBridge } from '../src/live-bridge.js';

class Socket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.sent = [];
  }
  open() { this.readyState = 1; this.emit('open'); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  receive(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }
  terminate() { this.close(); }
}

class InputClock {
  constructor(lateness = 0) {
    this.time = 0;
    this.lateness = lateness;
    this.pending = new Map();
    this.now = () => this.time;
    this.setTimeout = (callback, delay) => {
      const timer = { unref() {} };
      this.pending.set(timer, { callback, at: this.time + Math.max(0, delay) + this.lateness });
      return timer;
    };
    this.clearTimeout = timer => this.pending.delete(timer);
  }
  advanceTo(target) {
    assert.ok(target >= this.time, 'The input clock must remain monotonic.');
    let iterations = 0;
    for (;;) {
      const due = [...this.pending.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!due || due[1].at > target) break;
      assert.ok(++iterations < 100_000, 'Input scheduler must not spin indefinitely.');
      this.time = Math.max(this.time, due[1].at);
      this.pending.delete(due[0]);
      due[1].callback();
    }
    this.time = target;
  }
  stallFor(duration) { this.time += duration; }
}

const inputMessages = live => live.sent.filter(event => event.type === 'session.input_audio.append');

function frame(index) {
  const bytes = Buffer.alloc(160, 0xff); // 20 ms of 8 kHz mu-law audio.
  bytes.writeUInt32LE(index);
  return bytes.toString('base64');
}

function setup(t, options = {}) {
  const sockets = [];
  class LiveSocket extends Socket {
    constructor(url, settings) { super(); this.url = url; this.settings = settings; sockets.push(this); }
  }
  const provider = new Socket();
  provider.open();
  const call = {
    id: 'task-1', providerCallSid: `CA${'a'.repeat(32)}`, accountSid: 'AC_account', streamToken: 'random-secret-token',
    language: 'Japanese', callerName: 'Owner', openingLine: 'こんにちは。Ownerの代理のAIアシスタントです。',
  };
  const session = {
    model: 'gpt-live-1', audio: { format: { type: 'audio/pcmu', rate: 8000 }, output: { voice: 'marin' } },
    delegation: { type: 'responses', responses: { model: 'gpt-5.6-terra', parallel_tool_calls: false } },
  };
  const seen = { transcripts: [], events: [], sessions: [], usage: [], outcomes: [], ends: [], failures: [], providerIds: [], connections: [] };
  const bridge = createLiveBridge({
    providerSocket: provider, call, apiKey: 'test-only-key', sessionConfig: session,
    onTranscript: (value) => seen.transcripts.push(value),
    onEvent: (value) => seen.events.push(value),
    onSession: (value) => seen.sessions.push(value),
    onUsage: (value, final) => seen.usage.push({ value, final }),
    onOutcome: (value) => seen.outcomes.push(value),
    onEnd: (reason) => seen.ends.push(reason),
    onFailure: (reason) => seen.failures.push(reason),
    onProviderCallSid: (id) => seen.providerIds.push(id),
    onConnected: () => seen.connections.push(true),
    WebSocketImpl: LiveSocket,
    ...options,
  });
  const start = (overrides = {}) => provider.receive({ event: 'start', start: {
    accountSid: call.accountSid, callSid: call.providerCallSid, streamSid: 'MZ_stream',
    mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
    customParameters: { token: call.streamToken }, ...overrides,
  } });
  const media = (payload) => provider.receive({ event: 'media', streamSid: 'MZ_stream', media: { track: 'inbound', payload } });
  const ready = () => {
    start();
    const live = sockets[0];
    live.open();
    live.receive({ type: 'session.started', session: { id: 'live_test' } });
    return live;
  };
  t.after(() => {
    bridge.close();
    if (sockets[0]?.readyState === 1) sockets[0].receive({ type: 'session.closed', usage: { seconds: 0 }, reason: 'close_requested' });
  });
  return { sockets, provider, call, session, seen, bridge, start, ready, media };
}

function response(live, event, eventId) {
  live.receive({ type: 'response.event', delegation_id: 'delegation_one', ...(eventId ? { event_id: eventId } : {}), event });
}

function tool(live, id, name, args) {
  response(live, { type: 'response.output_item.done', item: {
    type: 'function_call', status: 'completed', call_id: id, name, arguments: JSON.stringify(args),
  } });
}

test('listen-in copies only accepted authenticated audio and ends without controlling the call', t => {
  const heard = [];
  let ended = 0;
  const f = setup(t, { onAudio: value => heard.push(value), onAudioEnd: () => ended++ });
  const payload = Buffer.alloc(160, 0xff).toString('base64');
  f.media(payload);
  assert.equal(heard.length, 0, 'No audio before stream authentication.');
  const live = f.ready();
  f.provider.receive({ event: 'media', streamSid: 'wrong', media: { track: 'inbound', payload } });
  f.provider.receive({ event: 'media', streamSid: 'MZ_stream', media: { track: 'outbound', payload } });
  assert.equal(heard.length, 0);
  f.media(payload);
  live.receive({ type: 'session.output_audio.delta', delta: payload });
  assert.deepEqual(heard.map(({ track, payload: audio, sampleRate }) => ({ track, audio, sampleRate })), [
    { track: 'recipient', audio: payload, sampleRate: 8000 },
    { track: 'assistant', audio: payload, sampleRate: 8000 },
  ]);
  assert.ok(heard.every(frame => Number.isFinite(frame.timestampMs)));
  assert.equal(inputMessages(live)[0].audio, payload);
  assert.equal(f.provider.sent.at(-1).media.payload, payload);
  f.bridge.close();
  f.bridge.close();
  assert.equal(ended, 1);
  f.media(payload);
  live.receive({ type: 'session.output_audio.delta', delta: payload });
  assert.equal(heard.length, 2, 'No monitor audio after close.');
});

test('listen-in observer failures cannot interrupt either direction of a phone call', t => {
  const f = setup(t, { onAudio: () => { throw new Error('Broken browser listener'); }, onAudioEnd: () => { throw new Error('Closed listener'); } });
  const live = f.ready();
  const payload = Buffer.alloc(160, 0xff).toString('base64');
  f.media(payload);
  live.receive({ type: 'session.output_audio.delta', delta: payload });
  assert.equal(inputMessages(live)[0].audio, payload);
  assert.equal(f.provider.sent.at(-1).media.payload, payload);
  assert.deepEqual(f.seen.failures, []);
  assert.doesNotThrow(() => f.bridge.close());
});

const outcome = {
  status: 'achieved', summary: 'Recipient confirmed the table.', confirmedDetails: ['Friday at 18:00'], nextSteps: [],
};

test('authenticates the actual stream before opening OpenAI, then preserves initial audio', (t) => {
  const f = setup(t);
  assert.equal(f.sockets.length, 0);
  f.provider.receive({ event: 'connected', protocol: 'Call' });
  assert.equal(f.sockets.length, 0);
  f.start();
  const live = f.sockets[0];
  assert.equal(live.url, 'wss://api.openai.com/v1/live/sessions');
  assert.equal(live.settings.headers.Authorization, 'Bearer test-only-key');
  const payload = Buffer.alloc(160, 0xff).toString('base64');
  f.media(payload);
  assert.equal(live.sent.length, 0);
  live.open();
  assert.equal(live.sent.length, 1);
  assert.equal(live.sent[0].type, 'session.start');
  assert.deepEqual(live.sent[0].session, f.session);
  live.receive({ type: 'session.started', session: { id: 'live_test' } });
  assert.deepEqual(f.seen.sessions, ['live_test']);
  assert.equal(live.sent[1].type, 'session.instructions.append');
  assert.match(live.sent[1].content, /Japanese/);
  assert.match(live.sent[1].content, /AIアシスタント/);
  assert.equal(live.sent[1].delegation_id, null);
  assert.deepEqual(live.sent[2], { type: 'session.input_audio.append', audio: payload });
});

for (const [label, overrides] of [
  ['call identity', { callSid: `CA${'b'.repeat(32)}` }],
  ['call identifier format', { callSid: 'CA_wrong' }],
  ['account identity', { accountSid: 'AC_wrong' }],
  ['stream token', { customParameters: { token: 'wrong-token' } }],
  ['codec', { mediaFormat: { encoding: 'audio/pcm', sampleRate: 8000, channels: 1 } }],
]) {
  test(`rejects incorrect ${label} without using the OpenAI key`, (t) => {
    const f = setup(t);
    f.start(overrides);
    assert.equal(f.sockets.length, 0);
    assert.equal(f.seen.failures.length, 1);
    assert.equal(f.provider.readyState, 3);
  });
}

test('binds a fast-answer provider ID only after all stream checks pass', (t) => {
  const f = setup(t);
  f.call.providerCallSid = null;
  const sid = `CA${'b'.repeat(32)}`;
  f.start({ callSid: sid });
  assert.deepEqual(f.seen.providerIds, [sid]);
  assert.equal(f.call.providerCallSid, sid);
  assert.equal(f.sockets.length, 1);
});

test('does not bind an unknown provider ID from an invalid stream', (t) => {
  const f = setup(t);
  f.call.providerCallSid = null;
  f.start({ callSid: `CA${'b'.repeat(32)}`, customParameters: { token: 'incorrect' } });
  assert.deepEqual(f.seen.providerIds, []);
  assert.equal(f.call.providerCallSid, null);
  assert.equal(f.sockets.length, 0);
});

test('passes μ-law output without conversion and retains exact transcript text and timing', (t) => {
  const f = setup(t);
  const live = f.ready();
  const audio = Buffer.from([0, 127, 255, 10]).toString('base64');
  live.receive({ type: 'session.output_audio.delta', delta: audio });
  assert.deepEqual(f.provider.sent[0], { event: 'media', streamSid: 'MZ_stream', media: { payload: audio } });
  const fragment = { type: 'session.input_transcript.delta', event_id: 'caption_1', delta: ' Yes, yes ', start_ms: 1000, end_ms: 1200 };
  live.receive(fragment);
  live.receive(fragment);
  live.receive({ type: 'session.output_transcript.delta', delta: 'Thank you.', start_ms: 1100, end_ms: 1400 });
  assert.deepEqual(f.seen.transcripts, [
    { speaker: 'recipient', text: ' Yes, yes ', startMs: 1000, endMs: 1200 },
    { speaker: 'assistant', text: 'Thank you.', startMs: 1100, endMs: 1400 },
  ]);
  assert.equal(f.provider.sent.filter((value) => value.event === 'clear').length, 0);
});

test('bounds startup audio instead of silently discarding the recipient opening', (t) => {
  const f = setup(t);
  f.start();
  f.media(Buffer.alloc(32_001, 0xff).toString('base64'));
  assert.equal(f.seen.failures.length, 1);
  assert.match(f.seen.failures[0], /behind/);
});

test('preparing Live before the phone stream removes startup lag for a full minute with late timers', async t => {
  const clock = new InputClock(4);
  const f = setup(t, { inputClock: clock, providerSocket: undefined });
  const preparing = f.bridge.prepare();
  assert.equal(f.bridge.prepare(), preparing, 'Preparation reuses one connection.');
  const live = f.sockets[0];
  live.open();
  clock.advanceTo(2000);
  live.receive({ type: 'session.started', session: { id: 'paced_session' } });
  await preparing;
  assert.equal(f.seen.connections.length, 0);
  assert.equal(live.sent.some(event => event.type === 'session.instructions.append'), false);
  // Ringing time must not create audio or let the input pacer build send credit.
  clock.advanceTo(5000);
  assert.equal(f.bridge.attachProvider(f.provider), true);
  f.start();
  assert.equal(f.seen.connections.length, 1);
  const deliveries = [];
  const arrivals = new Map();
  const send = live.send.bind(live);
  live.send = raw => {
    const event = JSON.parse(raw);
    if (event.type === 'session.input_audio.append') {
      const index = Buffer.from(event.audio, 'base64').readUInt32LE();
      deliveries.push({ index, lag: clock.now() - arrivals.get(index) });
    }
    send(raw);
  };
  const expected = [];
  let maxQueuedMs = 0;
  for (let index = 0; index < 3000; index++) {
    // Small packet jitter exercises the pacer's timers as well as its fast path.
    const at = 5000 + index * 20 + (index % 5 === 0 ? 4 : 0);
    clock.advanceTo(at);
    arrivals.set(index, at);
    expected.push(frame(index));
    f.media(expected.at(-1));
    maxQueuedMs = Math.max(maxQueuedMs, (expected.length - inputMessages(live).length) * 20);
  }
  assert.deepEqual(f.seen.failures, []);
  assert.ok(maxQueuedMs <= 20, `The live phone path must not inherit session startup lag (${maxQueuedMs} ms).`);
  clock.advanceTo(65_100);
  assert.ok(deliveries.every(row => row.lag >= 0 && row.lag <= 20), 'Every audio frame must reach the API within 20 ms of receipt.');
  assert.ok(deliveries.some(row => row.lag > 0), 'Packet jitter must exercise the delayed input timer.');
  const delivered = inputMessages(live).map(event => Buffer.from(event.audio, 'base64'));
  assert.equal(delivered.length, expected.length, 'Every received frame must be delivered exactly once.');
  assert.equal(Buffer.concat(delivered).equals(Buffer.concat(expected.map(payload => Buffer.from(payload, 'base64')))), true,
    'Pacing must preserve every audio byte in the original order.');
  assert.deepEqual(f.seen.failures, []);
  assert.equal(clock.pending.size, 0);
});

test('a prepared session waits for authenticated start before speech, transcripts or tool side effects', async t => {
  const f = setup(t, { providerSocket: undefined });
  const preparing = f.bridge.prepare();
  const live = f.sockets[0];
  live.open();
  live.receive({ type: 'session.started', session: { id: 'prepared' } });
  await preparing;
  assert.equal(f.bridge.attachProvider(f.provider), true);
  assert.equal(f.bridge.attachProvider(new Socket()), false);
  f.media(frame(0));
  live.receive({ type: 'session.output_audio.delta', delta: frame(0) });
  live.receive({ type: 'session.output_transcript.delta', delta: 'Early speech', start_ms: 0, end_ms: 50 });
  response(live, { type: 'response.created', response: { id: 'early' } });
  tool(live, 'early_outcome', 'report_call_outcome', outcome);
  tool(live, 'early_end', 'end_call', {});
  response(live, { type: 'response.completed', response: { id: 'early', usage: { input_tokens: 10 } } });
  await tick();
  assert.deepEqual(f.provider.sent, []);
  assert.deepEqual(inputMessages(live), []);
  assert.deepEqual(f.seen.transcripts, []);
  assert.deepEqual(f.seen.outcomes, []);
  assert.deepEqual(f.seen.ends, []);
  const results = live.sent.filter(event => event.type === 'response.item.create');
  assert.equal(results.length, 2);
  assert.ok(results.every(event => JSON.parse(event.item.output).error.includes('not connected')));
  assert.equal(f.seen.usage.length, 1, 'Pre-call backend usage must still be accounted for.');
  f.start();
  live.receive({ type: 'session.started', session: { id: 'prepared' } });
  assert.equal(f.seen.connections.length, 1);
  assert.equal(live.sent.filter(event => event.type === 'session.instructions.append').length, 1);
  f.media(frame(1));
  live.receive({ type: 'session.output_audio.delta', delta: frame(1) });
  assert.equal(inputMessages(live).length, 1);
  assert.equal(f.provider.sent.filter(event => event.event === 'media').length, 1);
});

test('an invalid stream cannot attach audio to the prepared session', async t => {
  const f = setup(t, { providerSocket: undefined });
  const preparing = f.bridge.prepare();
  const live = f.sockets[0];
  live.open();
  live.receive({ type: 'session.started', session: { id: 'prepared' } });
  await preparing;
  f.bridge.attachProvider(f.provider);
  f.start({ customParameters: { token: 'wrong-token' } });
  assert.equal(f.seen.failures.length, 1);
  assert.equal(f.seen.connections.length, 0);
  assert.equal(live.sent.some(event => event.type === 'session.instructions.append'), false);
  assert.equal(live.sent.at(-1).type, 'session.close');
});

for (const failure of ['close', 'error', 'timeout']) {
  test(`preparation rejects promptly on ${failure} without a phone stream`, async t => {
    const f = setup(t, { providerSocket: undefined, timeouts: { startupMs: failure === 'timeout' ? 5 : 15_000 } });
    const preparing = f.bridge.prepare();
    if (failure === 'close') f.bridge.close('Canceled during preparation');
    if (failure === 'error') f.sockets[0].emit('error', new Error('simulated socket failure'));
    const rejected = assert.rejects(preparing, failure === 'close' ? /Canceled/ : failure === 'error' ? /connection failed/ : /ready in time/);
    if (failure === 'timeout') await delay(20);
    await rejected;
    assert.equal(f.sockets[0].readyState, 3);
    assert.equal(f.bridge.attachProvider(f.provider), false);
    assert.equal(f.seen.connections.length, 0);
  });
}

test('a prepared session awaiting a phone stream has a bounded lifetime and finalizes usage', async t => {
  const f = setup(t, { providerSocket: undefined, timeouts: { attachMs: 5 } });
  const preparing = f.bridge.prepare();
  const live = f.sockets[0];
  live.open();
  live.receive({ type: 'session.started', session: { id: 'prepared' } });
  await preparing;
  await delay(20);
  assert.match(f.seen.failures[0], /phone stream did not connect/);
  assert.equal(live.sent.at(-1).type, 'session.close');
  live.receive({ type: 'session.closed', usage: { seconds: 1 }, reason: 'close_requested' });
  assert.deepEqual(f.seen.usage.at(-1), { value: { seconds: 1 }, final: true });
  assert.equal(live.readyState, 3);
});

test('input pacing caps queued-stall catchup to 100 ms without dropping buffered audio', t => {
  const clock = new InputClock();
  const f = setup(t, { inputClock: clock });
  const live = f.ready();
  const expected = Array.from({ length: 12 }, (_, index) => frame(index));
  expected.forEach(f.media);
  const before = inputMessages(live).length;
  assert.equal(before, 1);
  assert.equal(clock.pending.size, 1);
  clock.stallFor(1000);
  clock.advanceTo(clock.now());
  const caughtUp = inputMessages(live).slice(before);
  const caughtUpMs = caughtUp.reduce((bytes, event) => bytes + Buffer.from(event.audio, 'base64').length, 0) / 8;
  assert.ok(caughtUpMs > 0 && caughtUpMs <= 100, `One catchup turn must not burst more than 100 ms (${caughtUpMs} ms).`);
  assert.ok(clock.pending.size > 0, 'The remaining backlog must still be paced.');
  clock.advanceTo(1500);
  assert.deepEqual(inputMessages(live).map(event => event.audio), expected);
  assert.deepEqual(f.seen.failures, []);
});

test('input pacing splits oversized packets into bounded frames while preserving partial-frame bytes', t => {
  const clock = new InputClock();
  const f = setup(t, { inputClock: clock });
  const live = f.ready();
  const packet = Buffer.from(Array.from({ length: 1607 }, (_, index) => index % 256));
  const tail = Buffer.from([3, 1, 4, 1, 5]);
  f.media(packet.toString('base64'));
  f.media(tail.toString('base64'));
  const immediate = inputMessages(live);
  assert.equal(immediate.length, 1, 'A multi-frame packet must not bypass real-time pacing.');
  assert.equal(Buffer.from(immediate[0].audio, 'base64').length, 160);
  clock.stallFor(1000);
  clock.advanceTo(clock.now());
  const catchupBytes = inputMessages(live).slice(1).reduce((sum, event) => sum + Buffer.from(event.audio, 'base64').length, 0);
  assert.ok(catchupBytes <= 800, 'Even a large original packet must respect the 100 ms catchup budget.');
  clock.advanceTo(1500);
  const frames = inputMessages(live).map(event => Buffer.from(event.audio, 'base64'));
  assert.ok(frames.every(bytes => bytes.length <= 160));
  assert.equal(Buffer.concat(frames).equals(Buffer.concat([packet, tail])), true);
  assert.deepEqual(f.seen.failures, []);
});

test('input pacing does not accumulate send credit during an empty-queue idle period', t => {
  const clock = new InputClock();
  const f = setup(t, { inputClock: clock });
  const live = f.ready();
  f.media(frame(0));
  clock.advanceTo(10_000);
  const before = inputMessages(live).length;
  for (let index = 1; index <= 10; index++) f.media(frame(index));
  assert.equal(inputMessages(live).length - before, 1, 'Fresh audio after idle starts a new timeline instead of spending idle credit.');
  clock.advanceTo(10_500);
  assert.deepEqual(inputMessages(live).map(event => event.audio), Array.from({ length: 11 }, (_, index) => frame(index)));
  assert.deepEqual(f.seen.failures, []);
});

test('closing a bridge cancels its pending input timer and prevents later audio delivery', t => {
  const clock = new InputClock(4);
  const f = setup(t, { inputClock: clock });
  const live = f.ready();
  f.media(frame(0));
  f.media(frame(1));
  assert.equal(clock.pending.size, 1);
  const sent = inputMessages(live).length;
  f.bridge.close();
  assert.equal(clock.pending.size, 0);
  clock.advanceTo(60_000);
  assert.equal(inputMessages(live).length, sent);
});

test('input pacing still fails a real backlog above the 32 KB limit', t => {
  const clock = new InputClock();
  const f = setup(t, { inputClock: clock });
  const live = f.ready();
  f.media(frame(0));
  clock.stallFor(5000);
  // Deliver a network-coalesced backlog at one instant; the pacer must never
  // replace the queue bound with an unlimited catchup burst.
  for (let index = 1; index <= 207; index++) f.media(frame(index));
  assert.equal(f.seen.failures.length, 1);
  assert.match(f.seen.failures[0], /behind/);
  assert.ok(inputMessages(live).length <= 6);
  assert.equal(clock.pending.size, 0);
});

test('deduplicates tool side effects and submits all results before one response continuation', async (t) => {
  const f = setup(t);
  const live = f.ready();
  response(live, { type: 'response.created', response: { id: 'resp_1' } });
  tool(live, 'tool_outcome', 'report_call_outcome', outcome);
  tool(live, 'tool_outcome', 'report_call_outcome', outcome);
  tool(live, 'tool_unknown', 'not_allowed', {});
  await tick();
  assert.equal(f.seen.outcomes.length, 1);
  assert.equal(live.sent.filter((value) => value.type === 'response.create').length, 0);
  // Live completions intentionally have output: [], so the bridge must retain
  // the calls it collected from the individual output-item events.
  const completed = { type: 'response.completed', response: { id: 'resp_1', output: [], usage: { input_tokens: 20 } } };
  response(live, completed);
  response(live, completed);
  await tick();
  const results = live.sent.filter((value) => value.type === 'response.item.create');
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((value) => value.item.call_id), ['tool_outcome', 'tool_unknown']);
  assert.equal(JSON.parse(results[0].item.output).saved, true);
  assert.equal(JSON.parse(results[1].item.output).error, 'Unknown function.');
  assert.equal(live.sent.filter((value) => value.type === 'response.create').length, 1);
  assert.equal(f.seen.usage.filter((value) => value.value?.backend).length, 1);
  assert.equal(live.sent.at(-1).type, 'response.create');
  assert.equal(results.some((value) => 'delegation_id' in value), false);
});

test('returns a function error for invalid outcome instead of persisting false success', async (t) => {
  const f = setup(t);
  const live = f.ready();
  response(live, { type: 'response.created', response: { id: 'resp_bad' } });
  tool(live, 'tool_bad', 'report_call_outcome', { status: 'achieved', summary: 'Done' });
  response(live, { type: 'response.completed', response: { id: 'resp_bad', output: [] } });
  await tick();
  assert.equal(f.seen.outcomes.length, 0);
  const result = live.sent.find((value) => value.type === 'response.item.create');
  assert.match(JSON.parse(result.item.output).error, /Invalid outcome/);
  assert.equal(f.seen.failures.length, 0);
});

test('ends after the provider acknowledges queued playback, then preserves final usage', async (t) => {
  const f = setup(t);
  const live = f.ready();
  live.receive({ type: 'session.output_audio.delta', delta: Buffer.alloc(160, 0x80).toString('base64') });
  response(live, { type: 'response.created', response: { id: 'resp_end' } });
  tool(live, 'tool_end', 'end_call', {});
  response(live, { type: 'response.completed', response: { id: 'resp_end', output: [] } });
  await tick();
  const mark = f.provider.sent.find((value) => value.event === 'mark');
  assert.ok(mark);
  assert.equal(f.seen.ends.length, 0);
  const sentCount = f.provider.sent.length;
  live.receive({ type: 'session.output_audio.delta', delta: Buffer.alloc(160, 0x80).toString('base64') });
  assert.equal(f.provider.sent.length, sentCount);
  f.provider.receive({ event: 'mark', streamSid: 'MZ_stream', mark: mark.mark });
  assert.equal(f.seen.ends.length, 1);
  assert.equal(live.sent.at(-1).type, 'session.close');
  assert.equal(live.readyState, 1, 'keep receiving until final usage');
  live.receive({ type: 'session.closed', usage: { seconds: 42 }, reason: 'close_requested' });
  assert.deepEqual(f.seen.usage.at(-1), { value: { seconds: 42 }, final: true });
  assert.equal(live.readyState, 3);
  assert.equal(f.seen.ends.length, 1);
});

test('releases a call if the provider never confirms playback', async (t) => {
  const f = setup(t, { timeouts: { drainMs: 5 } });
  const live = f.ready();
  response(live, { type: 'response.created', response: { id: 'resp_end' } });
  tool(live, 'tool_end', 'end_call', {});
  response(live, { type: 'response.completed', response: { id: 'resp_end' } });
  await delay(20);
  assert.equal(f.seen.ends.length, 1);
  assert.match(f.seen.events.join('\n'), /playback was not confirmed/);
});

test('marks usage incomplete when a session is lost instead of claiming final accounting', (t) => {
  const f = setup(t);
  const live = f.ready();
  live.receive({ type: 'session.usage.updated', usage: { seconds: 12 } });
  live.close();
  assert.equal(f.seen.failures.length, 1);
  assert.equal(f.seen.usage.some((value) => value.final), false);
  assert.deepEqual(f.seen.usage.at(-1).value, { seconds: 12 });
});

test('graceful finalization has a deadline and ignores late model tools', async (t) => {
  const f = setup(t, { timeouts: { finalizeMs: 5 } });
  const live = f.ready();
  f.bridge.close('Owner stopped the call');
  tool(live, 'late_outcome', 'report_call_outcome', outcome);
  await delay(20);
  assert.equal(f.seen.outcomes.length, 0);
  assert.equal(live.readyState, 3);
  assert.equal(f.seen.usage.some((value) => value.final), false);
  assert.match(f.seen.events.join('\n'), /could not be confirmed/);
});
