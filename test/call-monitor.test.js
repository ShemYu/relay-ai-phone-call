import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import { CallMonitor } from '../src/call-monitor.js';

class Response extends EventEmitter {
  constructor() {
    super(); this.headers = {}; this.chunks = []; this.writableLength = 0;
    this.writableEnded = false; this.destroyed = false; this.throwOnWrite = false;
  }
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  flushHeaders() { this.headersFlushed = true; }
  write(chunk) {
    if (this.throwOnWrite) throw new Error('Synthetic disconnected observer.');
    this.chunks.push(chunk);
    return this.writableLength < 16 * 1024;
  }
  end() { this.writableEnded = true; this.emit('close'); }
  destroy() { this.destroyed = true; this.emit('close'); }
}

function fixture(t) {
  const calls = new Map([
    ['first', { id: 'first', status: 'in-progress' }],
    ['second', { id: 'second', status: 'ringing' }],
    ['ended', { id: 'ended', status: 'completed' }],
  ]);
  let saved = 0;
  const store = { call: id => calls.get(id), save: () => { saved++; } };
  const monitor = new CallMonitor({ store });
  t.after(() => monitor.dispose());
  const subscribe = (id = 'first') => {
    const req = new EventEmitter();
    const res = new Response();
    monitor.subscribe(req, res, id);
    return { req, res };
  };
  return { monitor, store, calls, subscribe, saved: () => saved };
}

function audio(index = 1, track = 'recipient') {
  const bytes = Buffer.alloc(160, index);
  return { track, payload: bytes.toString('base64'), sampleRate: 8000, timestampMs: index * 20 };
}

function events(res, type) {
  return res.chunks.filter(chunk => chunk.startsWith(`event: ${type}\n`))
    .map(chunk => JSON.parse(chunk.split('\ndata: ')[1].trim()));
}

test('live monitor streams ready, both audio tracks, then ended without storing audio', t => {
  const f = fixture(t);
  const before = JSON.stringify([...f.calls]);
  const { res } = f.subscribe();
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.match(res.headers['cache-control'], /no-store/);
  assert.equal(res.headersFlushed, true);
  assert.deepEqual(events(res, 'ready'), [{ sampleRate: 8000, encoding: 'audio/pcmu' }]);
  const frames = [audio(1), audio(2, 'assistant'), audio(3)];
  frames.forEach(frame => f.monitor.publish('first', { ...frame, unrelatedRuntimeField: 'must-not-appear' }));
  assert.deepEqual(events(res, 'audio'), frames);
  f.monitor.end('first');
  assert.deepEqual(events(res, 'ended'), [{}]);
  assert.equal(res.writableEnded, true);
  assert.equal(f.monitor.listenerCount, 0);
  assert.equal(f.monitor.heartbeatTimer, undefined);
  assert.equal(f.saved(), 0);
  assert.equal(JSON.stringify([...f.calls]), before);
});

test('a real SSE response stays subscribed after its GET completes and cleans up on client disconnect', async t => {
  const f = fixture(t);
  let serverResponse;
  const server = http.createServer((req, res) => { serverResponse = res; f.monitor.subscribe(req, res, 'first'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let request;
  const response = await new Promise((resolve, reject) => {
    request = http.get({ hostname: '127.0.0.1', port: server.address().port, path: '/' }, resolve);
    request.on('error', reject);
  });
  t.after(() => { response.destroy(); request.destroy(); server.close(); });
  const [ready] = await once(response, 'data');
  assert.match(ready.toString(), /event: ready/);
  assert.equal(f.monitor.listenerCount, 1);
  const received = once(response, 'data');
  f.monitor.publish('first', audio(1));
  const [chunk] = await received;
  assert.match(chunk.toString(), /event: audio/);
  assert.ok(chunk.toString().includes(audio(1).payload));
  const closed = once(serverResponse, 'close');
  response.destroy();
  await closed;
  assert.equal(f.monitor.listenerCount, 0);
  assert.equal(f.monitor.heartbeatTimer, undefined);
});

test('monitor rejects nonexistent and terminal calls and limits concurrent listeners', t => {
  const f = fixture(t);
  assert.throws(() => f.subscribe('missing'), { status: 404 });
  for (const status of ['completed', 'busy', 'no-answer', 'canceled', 'failed']) {
    f.calls.get('ended').status = status;
    assert.throws(() => f.subscribe('ended'), { status: 409 });
  }
  const first = f.subscribe();
  f.subscribe(); f.subscribe('second'); f.subscribe('second');
  assert.throws(() => f.subscribe(), { status: 429 });
  first.res.destroy();
  assert.doesNotThrow(() => f.subscribe());
  assert.equal(f.monitor.listenerCount, 4);
});

test('subscribers are isolated by call ID and ending one call leaves the other live', t => {
  const f = fixture(t);
  const first = f.subscribe('first');
  const second = f.subscribe('second');
  f.monitor.publish('first', audio(1));
  f.monitor.publish('second', audio(2, 'assistant'));
  assert.deepEqual(events(first.res, 'audio'), [audio(1)]);
  assert.deepEqual(events(second.res, 'audio'), [audio(2, 'assistant')]);
  f.monitor.end('first');
  f.monitor.publish('second', audio(3));
  assert.equal(second.res.writableEnded, false);
  assert.deepEqual(events(second.res, 'audio'), [audio(2, 'assistant'), audio(3)]);
  assert.equal(f.monitor.listenerCount, 1);
});

test('late and reconnected observers receive no replay of earlier audio', t => {
  const f = fixture(t);
  f.monitor.publish('first', audio(1));
  const original = f.subscribe();
  assert.deepEqual(events(original.res, 'audio'), []);
  f.monitor.publish('first', audio(2));
  const later = f.subscribe();
  assert.deepEqual(events(later.res, 'audio'), []);
  original.res.destroy();
  const reconnect = f.subscribe();
  assert.deepEqual(events(reconnect.res, 'audio'), []);
  f.monitor.publish('first', audio(3));
  assert.deepEqual(events(later.res, 'audio'), [audio(3)]);
  assert.deepEqual(events(reconnect.res, 'audio'), [audio(3)]);
});

test('a slow or throwing observer is disconnected without affecting other listeners or the call', t => {
  const f = fixture(t);
  const slow = f.subscribe();
  const broken = f.subscribe();
  const healthy = f.subscribe();
  slow.res.writableLength = 64 * 1024 + 1;
  broken.res.throwOnWrite = true;
  assert.doesNotThrow(() => f.monitor.publish('first', audio(1)));
  assert.equal(slow.res.destroyed, true);
  assert.equal(broken.res.destroyed, true);
  assert.deepEqual(events(healthy.res, 'audio'), [audio(1)]);
  assert.equal(f.monitor.listenerCount, 1);
  assert.equal(f.calls.get('first').status, 'in-progress');
  assert.equal(f.saved(), 0);
  f.monitor.publish('first', audio(2));
  assert.deepEqual(events(healthy.res, 'audio'), [audio(1), audio(2)]);
});

test('one valid large chunk is forwarded but cannot accumulate another chunk on a backed-up observer', t => {
  const f = fixture(t);
  const { res } = f.subscribe();
  const large = { ...audio(1), payload: Buffer.alloc(90_000, 0xff).toString('base64') };
  const originalWrite = res.write.bind(res);
  res.write = chunk => { const result = originalWrite(chunk); res.writableLength += Buffer.byteLength(chunk); return result; };
  f.monitor.publish('first', large);
  assert.deepEqual(events(res, 'audio'), [large]);
  assert.equal(res.destroyed, false);
  f.monitor.publish('first', audio(2));
  assert.equal(res.destroyed, true);
  assert.equal(events(res, 'audio').length, 1);
  assert.equal(f.monitor.listenerCount, 0);
});

test('disconnect and request abort release response handlers and stop the last heartbeat timer', t => {
  const f = fixture(t);
  const first = f.subscribe();
  const second = f.subscribe();
  assert.notEqual(f.monitor.heartbeatTimer, undefined);
  first.res.emit('close');
  assert.equal(f.monitor.listenerCount, 1);
  assert.equal(first.req.listenerCount('aborted'), 0);
  assert.equal(first.res.listenerCount('close'), 0);
  assert.equal(first.res.listenerCount('error'), 0);
  second.req.emit('aborted');
  assert.equal(second.res.destroyed, true);
  assert.equal(f.monitor.listenerCount, 0);
  assert.equal(f.monitor.heartbeatTimer, undefined);
  assert.equal(f.monitor.listeners.size, 0);
});

test('heartbeat notices terminal provider status even when no more audio is published', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(t);
  const first = f.subscribe();
  const second = f.subscribe('second');
  t.mock.timers.tick(10_000);
  assert.equal(first.res.chunks.at(-1), ': heartbeat\n\n');
  f.calls.get('first').status = 'failed';
  f.calls.delete('second');
  t.mock.timers.tick(10_000);
  assert.deepEqual(events(first.res, 'ended'), [{}]);
  assert.deepEqual(events(second.res, 'ended'), [{}]);
  assert.equal(first.res.writableEnded, true);
  assert.equal(second.res.writableEnded, true);
  assert.equal(f.monitor.listenerCount, 0);
  assert.equal(f.monitor.heartbeatTimer, undefined);
});

test('heartbeat also evicts a stalled listener during otherwise silent audio', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(t);
  const { res } = f.subscribe();
  res.writableLength = 100_000;
  t.mock.timers.tick(10_000);
  assert.equal(res.destroyed, true);
  assert.equal(f.monitor.listenerCount, 0);
});

test('malformed frames or observer-side store errors never throw into the audio path', t => {
  const f = fixture(t);
  const { res } = f.subscribe();
  for (const frame of [null, {}, { ...audio(), track: 'microphone' }, { ...audio(), sampleRate: 48000 },
    { ...audio(), timestampMs: NaN }, { ...audio(), timestampMs: -1 }, { ...audio(), payload: 'not base64' },
    { ...audio(), payload: 'A'.repeat(256_004) }]) {
    assert.doesNotThrow(() => f.monitor.publish('first', frame));
  }
  assert.doesNotThrow(() => f.monitor.publish('first', { get track() { throw new Error('Synthetic invalid event.'); } }));
  assert.deepEqual(events(res, 'audio'), []);
  f.store.call = () => { throw new Error('Synthetic store failure.'); };
  assert.doesNotThrow(() => f.monitor.publish('first', audio(1)));
  assert.deepEqual(events(res, 'audio'), []);
});

test('dispose closes every stream, is idempotent, and prevents new subscriptions', t => {
  const f = fixture(t);
  const first = f.subscribe();
  const second = f.subscribe('second');
  f.monitor.dispose();
  f.monitor.dispose();
  assert.deepEqual(events(first.res, 'ended'), [{}]);
  assert.deepEqual(events(second.res, 'ended'), [{}]);
  assert.equal(first.res.writableEnded, true);
  assert.equal(second.res.writableEnded, true);
  assert.equal(f.monitor.listeners.size, 0);
  assert.equal(f.monitor.heartbeatTimer, undefined);
  assert.throws(() => f.subscribe(), { status: 503 });
  assert.doesNotThrow(() => f.monitor.publish('first', audio(1)));
});
