import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Calls } from '../src/calls.js';
import { buildSession } from '../src/brief.js';
import { setupStatus } from '../src/config.js';

const config = { apiKey: 'test-only', accountSid: 'AC' + 'a'.repeat(32), authToken: 'test-only', fromNumber: '+12025550100', publicBaseUrl: 'https://example.test' };
const brief = { recipientName: 'Test business', phoneNumber: '+12025550101', callerName: 'Alex', language: 'Japanese', goal: 'Ask about opening hours tomorrow.', context: 'Only ask about hours.', constraints: 'Do not book anything.', maxDurationSeconds: 60 };

function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test-'));
  const store = new Store(directory);
  const requests = [];
  const stopped = [];
  const provider = { create: async call => { requests.push(call); return { sid: 'CA' + 'b'.repeat(32) }; }, end: async sid => { stopped.push(sid); } };
  const calls = new Calls({ config, store, provider, ...overrides });
  t.after(() => { calls.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { calls, store, requests, stopped, provider };
}

test('review has no external side effect, and incomplete setup cannot call', async t => {
  const f = fixture(t, { config: { ...config, apiKey: '' } });
  const plan = f.calls.plan(brief);
  assert.equal(f.requests.length, 0);
  assert.equal(plan.openingLine, 'もしもし。');
  await assert.rejects(f.calls.start(plan.id), /setup/);
  assert.equal(f.store.state.calls.length, 0);
});

test('double click and network retry create exactly one outbound call', async t => {
  let release;
  const f = fixture(t, { preflight: () => new Promise(resolve => { release = resolve; }) });
  const plan = f.calls.plan(brief);
  const first = f.calls.start(plan.id);
  const duplicate = await f.calls.start(plan.id);
  assert.equal(duplicate.status, 'preparing');
  release();
  assert.equal((await first).id, duplicate.id);
  assert.equal((await f.calls.start(plan.id)).id, duplicate.id);
  assert.equal(f.requests.length, 1);
});

test('simultaneous distinct briefs cannot place concurrent calls', async t => {
  const f = fixture(t);
  await f.calls.start(f.calls.plan(brief).id);
  await assert.rejects(f.calls.start(f.calls.plan(brief).id), /Another call/);
  assert.equal(f.requests.length, 1);
});

test('stop during model access check prevents dialing', async t => {
  let release;
  const f = fixture(t, { preflight: () => new Promise(resolve => { release = resolve; }) });
  const pending = f.calls.start(f.calls.plan(brief).id);
  await f.calls.stop(f.store.active().id);
  release();
  const call = await pending;
  assert.equal(call.status, 'canceled');
  assert.equal(f.requests.length, 0);
});

test('the voice session becomes ready before an outbound call is requested', async t => {
  let release;
  const order = [];
  const f = fixture(t, {
    preflight: async () => { order.push('preflight'); },
    prepareVoice: () => new Promise(resolve => { order.push('prepare'); release = resolve; }),
  });
  const pending = f.calls.start(f.calls.plan(brief).id);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['preflight', 'prepare']);
  assert.equal(f.requests.length, 0);
  assert.equal(f.store.active().status, 'preparing');
  assert.equal(f.calls.timers.size, 0);
  release();
  assert.equal((await pending).status, 'dialing');
  assert.equal(f.requests.length, 1);
});

test('stopping during voice preparation cancels it and never dials', async t => {
  let rejectPreparation;
  let closed = 0;
  const f = fixture(t, { prepareVoice: call => {
    f.calls.bridges.set(call.id, { close() { closed++; rejectPreparation(new Error('closed')); } });
    return new Promise((_resolve, reject) => { rejectPreparation = reject; });
  } });
  const pending = f.calls.start(f.calls.plan(brief).id);
  await new Promise(resolve => setImmediate(resolve));
  await f.calls.stop(f.store.active().id);
  const call = await pending;
  assert.equal(call.status, 'canceled');
  assert.equal(call.error, null);
  assert.ok(closed > 0);
  assert.equal(f.calls.bridges.size, 0);
  assert.equal(f.requests.length, 0);
});

test('failed voice preparation cleans up without contacting the phone provider', async t => {
  let closed = 0;
  const f = fixture(t, { prepareVoice: async call => {
    f.calls.bridges.set(call.id, { close() { closed++; } });
    throw new Error('voice unavailable');
  } });
  const call = await f.calls.start(f.calls.plan(brief).id);
  assert.equal(call.status, 'failed');
  assert.match(call.error, /voice connection/);
  assert.equal(closed, 1);
  assert.equal(f.calls.bridges.size, 0);
  assert.equal(f.requests.length, 0);
});

test('provider rejection closes the prepared session', async t => {
  let closed = 0;
  const f = fixture(t, { prepareVoice: async call => {
    f.calls.bridges.set(call.id, { close() { closed++; } });
  } });
  f.provider.create = async () => { throw Object.assign(new Error('rejected'), { status: 400 }); };
  const call = await f.calls.start(f.calls.plan(brief).id);
  assert.equal(call.status, 'failed');
  assert.equal(closed, 1);
  assert.equal(f.calls.bridges.size, 0);
});

test('a terminal callback during preparation prevents dialing and cannot be overwritten', async t => {
  let rejectPreparation;
  const f = fixture(t, { prepareVoice: call => {
    f.calls.bridges.set(call.id, { close() { rejectPreparation(new Error('closed')); } });
    return new Promise((_resolve, reject) => { rejectPreparation = reject; });
  } });
  const pending = f.calls.start(f.calls.plan(brief).id);
  await new Promise(resolve => setImmediate(resolve));
  const call = f.store.active();
  await f.calls.status(call.id, {
    CallSid: 'CA' + 'b'.repeat(32), From: config.fromNumber, To: brief.phoneNumber,
    CallStatus: 'canceled', SequenceNumber: '1',
  });
  await pending;
  assert.equal(call.status, 'canceled');
  assert.equal(call.error, null);
  assert.equal(f.calls.bridges.size, 0);
  assert.equal(f.requests.length, 0);
});

test('a terminal callback wins over a late provider rejection', async t => {
  let rejectDial;
  const f = fixture(t);
  f.provider.create = () => new Promise((_resolve, reject) => { rejectDial = reject; });
  const pending = f.calls.start(f.calls.plan(brief).id);
  await new Promise(resolve => setImmediate(resolve));
  const call = f.store.active();
  await f.calls.status(call.id, {
    CallSid: 'CA' + 'b'.repeat(32), From: config.fromNumber, To: brief.phoneNumber,
    CallStatus: 'no-answer', SequenceNumber: '1',
  });
  rejectDial(Object.assign(new Error('late rejection'), { status: 400 }));
  await pending;
  assert.equal(call.status, 'no-answer');
  assert.equal(call.error, null);
});

test('provider uncertainty retains the prepared session until a terminal callback', async t => {
  let closed = 0;
  const f = fixture(t, { prepareVoice: async call => {
    f.calls.bridges.set(call.id, { close() { closed++; } });
  } });
  f.provider.create = async () => { throw new Error('timeout'); };
  const call = await f.calls.start(f.calls.plan(brief).id);
  assert.equal(f.calls.bridges.has(call.id), true);
  assert.equal(closed, 0);
  await f.calls.status(call.id, {
    CallSid: 'CA' + 'b'.repeat(32), From: config.fromNumber, To: brief.phoneNumber,
    CallStatus: 'no-answer', SequenceNumber: '1',
  });
  assert.equal(closed, 1);
  assert.equal(f.calls.bridges.has(call.id), false);
});

test('server disposal closes any reserved voice session', async t => {
  let closed = 0;
  const f = fixture(t, { prepareVoice: async call => {
    f.calls.bridges.set(call.id, { close() { closed++; } });
  } });
  await f.calls.start(f.calls.plan(brief).id);
  f.calls.dispose();
  assert.equal(closed, 1);
  assert.equal(f.calls.bridges.size, 0);
  assert.equal(f.calls.timers.size, 0);
});

test('out of order or duplicate phone callbacks cannot resurrect a finished call', async t => {
  const f = fixture(t);
  const call = await f.calls.start(f.calls.plan(brief).id);
  const payload = { CallSid: call.providerCallSid, From: config.fromNumber, To: brief.phoneNumber };
  await f.calls.status(call.id, { ...payload, CallStatus: 'in-progress', SequenceNumber: '2' });
  await f.calls.status(call.id, { ...payload, CallStatus: 'ringing', SequenceNumber: '1' });
  assert.equal(call.status, 'in-progress');
  await f.calls.status(call.id, { ...payload, CallStatus: 'completed', SequenceNumber: '3' });
  await f.calls.status(call.id, { ...payload, CallStatus: 'ringing', SequenceNumber: '4' });
  assert.equal(call.status, 'completed');
  assert.equal(call.outcome.status, 'needs-user');
});

test('a provider timeout retains the active reservation until a signed status binds the call', async t => {
  const f = fixture(t);
  f.provider.create = async () => { throw new Error('timeout'); };
  const call = await f.calls.start(f.calls.plan(brief).id);
  assert.equal(call.status, 'dialing');
  assert.match(call.error, /uncertain/);
  await f.calls.stop(call.id);
  await f.calls.status(call.id, { CallSid: 'CA' + 'c'.repeat(32), From: config.fromNumber, To: brief.phoneNumber, CallStatus: 'ringing', SequenceNumber: '1' });
  assert.equal(f.stopped.length, 1);
  assert.equal(call.status, 'completed');
});

test('runtime tokens and provider data never enter model context or dashboard response', async t => {
  const f = fixture(t);
  const call = await f.calls.start(f.calls.plan(brief).id);
  const session = JSON.stringify(buildSession(call, 'gpt-5.6-terra'));
  assert.ok(!session.includes(call.streamToken));
  assert.ok(!session.includes(call.providerCallSid));
  assert.equal(f.store.publicCall(call).streamToken, undefined);
  assert.equal(f.store.publicCall(call).providerCallSid, undefined);
  assert.equal(setupStatus(config).apiKey, undefined);
});

test('restart recovery stops the previous call without redialing', async t => {
  const f = fixture(t);
  const call = await f.calls.start(f.calls.plan(brief).id);
  await f.calls.recover();
  assert.equal(f.requests.length, 1);
  assert.equal(f.stopped.length, 1);
  assert.equal(call.status, 'completed');
});

test('invalid brief and duration cannot enter calling flow', t => {
  const f = fixture(t);
  assert.throws(() => f.calls.plan({ ...brief, phoneNumber: '123' }));
  assert.throws(() => f.calls.plan({ ...brief, maxDurationSeconds: 99999 }));
});

test('an unlimited brief creates no app deadline and can still be stopped manually', async t => {
  const f = fixture(t);
  const plan = f.calls.plan({ ...brief, maxDurationSeconds: null });
  assert.equal(plan.maxDurationSeconds, null);
  const call = await f.calls.start(plan.id);
  assert.equal(call.maxDurationSeconds, null);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].maxDurationSeconds, null);
  assert.equal(f.calls.timers.size, 0);
  assert.equal(f.store.active().id, call.id);
  await f.calls.stop(call.id);
  assert.deepEqual(f.stopped, [call.providerCallSid]);
  assert.equal(call.status, 'completed');
  assert.equal(call.stopRequested, true);
  assert.equal(f.store.active(), undefined);
  assert.equal(f.calls.timers.size, 0);
});

test('an unlimited call with an uncertain provider result remains reserved after elapsed time', async t => {
  let now = Date.now();
  const f = fixture(t, { now: () => now });
  f.provider.create = async () => { throw new Error('connection reset'); };
  const call = await f.calls.start(f.calls.plan({ ...brief, maxDurationSeconds: null }).id);
  assert.equal(call.providerCallSid, null);
  assert.equal(call.status, 'dialing');
  assert.match(call.error, /uncertain/);
  assert.equal(f.calls.timers.size, 0);
  now += 24 * 60 * 60 * 1000;
  await f.calls.stop(call.id);
  assert.equal(f.store.active().id, call.id);
  assert.equal(call.status, 'dialing');
  assert.equal(call.stopRequested, true);
  assert.equal(f.stopped.length, 0);
  assert.equal(f.calls.timers.size, 0);
  await assert.rejects(f.calls.start(f.calls.plan({ ...brief, maxDurationSeconds: null }).id), /Another call/);
  await f.calls.status(call.id, {
    CallSid: 'CA' + 'c'.repeat(32), From: config.fromNumber, To: brief.phoneNumber,
    CallStatus: 'ringing', SequenceNumber: '1',
  });
  assert.equal(f.stopped.length, 1, 'A late provider identity must still honor the pending manual stop.');
  assert.equal(call.status, 'completed');
  assert.equal(f.calls.timers.size, 0);
});

test('nullable duration preserves the numeric bounds and default duration', t => {
  const f = fixture(t);
  for (const value of [60, 300, 600]) {
    assert.equal(f.calls.plan({ ...brief, maxDurationSeconds: value }).maxDurationSeconds, value);
  }
  for (const value of [0, 59, 60.5, 601, 99999]) {
    assert.throws(() => f.calls.plan({ ...brief, maxDurationSeconds: value }));
  }
  const { maxDurationSeconds: _duration, ...withoutDuration } = brief;
  assert.equal(f.calls.plan(withoutDuration).maxDurationSeconds, 300);
});

test('unknown queued calls remain reserved after the duration deadline', async t => {
  let now = Date.now();
  const f = fixture(t, { now: () => now });
  f.provider.create = async () => { throw new Error('connection reset'); };
  const call = await f.calls.start(f.calls.plan(brief).id);
  now += 200000;
  await f.calls.stop(call.id, 'Deadline');
  assert.equal(f.store.active().id, call.id);
  assert.match(call.error, /unconfirmed/);
  await assert.rejects(f.calls.start(f.calls.plan(brief).id), /Another call/);
});

test('hangup network failure cannot override signed confirmation of disconnection', async t => {
  const f = fixture(t);
  const call = await f.calls.start(f.calls.plan(brief).id);
  let rejectEnd;
  f.provider.end = () => new Promise((_resolve, reject) => { rejectEnd = reject; });
  const stop = f.calls.stop(call.id);
  await f.calls.status(call.id, { CallSid: call.providerCallSid, CallStatus: 'completed', SequenceNumber: '3' });
  rejectEnd(new Error('network timeout'));
  await stop;
  assert.equal(call.status, 'completed');
  assert.equal(call.error, null);
});
