import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { browserSession, LocalTests } from '../src/local-test.js';
import { briefSchema, buildSession } from '../src/brief.js';
import { createApps } from '../src/server.js';
import { Store } from '../src/store.js';

const key = 'synthetic-local-test-key';
const brief = {
  recipientName: 'Browser tester', phoneNumber: '+12025550123', callerName: 'Alex', language: 'Japanese',
  goal: 'Check whether both sides can hear clear speech.', context: 'An offline fixture.',
  constraints: 'Do not make commitments.', maxDurationSeconds: null,
};
const input = { sdp: 'v=0\r\no=synthetic-offer\r\n', brief };
const answer = { session: { id: 'live_test_session' }, transport: { type: 'webrtc', sdp: 'v=0\r\no=synthetic-answer\r\n' } };
const response = (body = answer, status = 201) => new Response(JSON.stringify(body), { status });

function fixture(t, options = {}) {
  const config = { port: 3210, apiKey: key, backendModel: 'test-reasoning-model', accountSid: '', authToken: '', fromNumber: '', publicBaseUrl: '', ...options.config };
  const requests = [];
  const sockets = [];
  class Socket extends EventEmitter {
    constructor(url, settings) { super(); this.url = url; this.settings = settings; this.readyState = 0; this.sent = []; sockets.push(this); }
    open() { this.readyState = 1; this.emit('open'); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    receive(event) { this.emit('message', Buffer.from(JSON.stringify(event))); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
    terminate() { this.close(); }
  }
  const manager = new LocalTests({
    config, WebSocketImpl: Socket,
    fetchImpl: async (url, init) => { requests.push({ url, init }); return options.fetchImpl ? options.fetchImpl(url, init) : response(); },
    isPhoneActive: options.isPhoneActive ?? (() => false),
    leaseMs: options.leaseMs ?? 90_000, closeMs: options.closeMs ?? 15_000, attachMs: options.attachMs ?? 10_000,
  });
  t.after(() => {
    manager.dispose();
    // No real transport exists; finish test records to clear every fixture timer.
    for (const record of manager.records.values()) manager.finish(record);
  });
  return { manager, config, sockets, requests };
}

async function httpFixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-local-test-'));
  const store = new Store(directory);
  const f = fixture(t, { ...options, isPhoneActive: () => Boolean(store.active()) });
  let phoneRequests = 0;
  const provider = {
    async create() { phoneRequests++; throw new Error('Unexpected phone request in an offline fixture.'); },
    async end() { phoneRequests++; throw new Error('Unexpected phone hangup in an offline fixture.'); },
  };
  const app = createApps({ config: f.config, store, provider, localTests: f.manager, preflight: async () => {}, settingsPath: path.join(directory, '.env.local') });
  const server = app.dashboard.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); app.wss.close(); app.calls.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  async function request(route, method = 'GET', body, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: route, method,
        headers: { host: 'localhost:3210', 'content-type': 'application/json', ...headers } }, res => {
        let text = '';
        res.setEncoding('utf8'); res.on('data', part => { text += part; });
        res.on('end', () => resolve({ status: res.statusCode, text, body: JSON.parse(text), headers: res.headers }));
      });
      req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  return { ...f, app, store, request, phoneRequests: () => phoneRequests, directory };
}

test('browser session keeps the telephone prompt, voice, backend and tools while letting WebRTC negotiate audio', () => {
  const expected = buildSession(brief, 'test-reasoning-model');
  delete expected.audio.format;
  assert.deepEqual(browserSession(brief, 'test-reasoning-model'), expected);
  assert.equal(browserSession(brief, 'test-reasoning-model').model, 'gpt-live-1');
  assert.equal(browserSession(brief, 'test-reasoning-model').audio.output.voice, 'marin');
  assert.deepEqual(buildSession(brief, 'test-reasoning-model').audio.format, { type: 'audio/pcmu', rate: 8000 });
});

test('browser negotiation uses only server-side credentials and returns an allowlisted answer', async t => {
  const f = fixture(t, { fetchImpl: async () => response({ ...answer, apiKey: key, internal: 'private', session: { ...answer.session, token: key } }) });
  const result = await f.manager.start(input);
  assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  assert.equal(request.url, 'https://api.openai.com/v1/live/sessions');
  assert.equal(request.init.headers.Authorization, `Bearer ${key}`);
  assert.deepEqual(JSON.parse(request.init.body), {
    session: browserSession(brief, f.config.backendModel), transport: { type: 'webrtc', sdp: input.sdp },
  });
  assert.equal(request.init.body.includes(key), false);
  assert.deepEqual(result.session, answer.session);
  assert.deepEqual(result.transport, answer.transport);
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal(Object.hasOwn(result, 'internal'), false);
  assert.ok(result.openingInstruction.includes('もしもし。'));
  assert.equal(f.sockets[0].settings.headers.Authorization, `Bearer ${key}`);
  assert.equal(f.sockets[0].url, 'wss://api.openai.com/v1/live/sessions/live_test_session/attach');
});

test('missing OpenAI access or an active phone call rejects browser creation before any upstream request', async t => {
  const missing = fixture(t, { config: { apiKey: '' } });
  await assert.rejects(missing.manager.start(input), { status: 503 });
  assert.equal(missing.requests.length, 0);
  assert.equal(missing.manager.active(), false);
  const busy = fixture(t, { isPhoneActive: () => true });
  await assert.rejects(busy.manager.start(input), { status: 409 });
  assert.equal(busy.requests.length, 0);
  assert.equal(busy.manager.active(), false);
});

test('browser startup reserves the singleton before negotiation finishes', async t => {
  let resolveCreate;
  const f = fixture(t, { fetchImpl: () => new Promise(resolve => { resolveCreate = resolve; }) });
  const pending = f.manager.start(input);
  assert.equal(f.manager.active(), true);
  await assert.rejects(f.manager.start(input), { status: 409 });
  assert.equal(f.requests.length, 1);
  resolveCreate(response());
  const result = await pending;
  f.sockets[0].open();
  f.manager.stop(result.id);
  f.manager.stop(result.id);
  assert.equal(f.sockets[0].sent.filter(event => event.type === 'session.close').length, 1);
  assert.equal(f.manager.active(), true, 'Closing retains the reservation until closure or the bounded cleanup deadline.');
  f.sockets[0].receive({ type: 'session.closed', usage: { seconds: 1 } });
  assert.equal(f.manager.active(), false);
  assert.deepEqual(f.manager.heartbeat(result.id), { active: false, closing: true, closeSent: true, finalized: true, usage: { seconds: 1 }, error: null });
});

test('an aborted negotiation closes a late-created session instead of abandoning it', async t => {
  let resolveCreate;
  const f = fixture(t, { fetchImpl: () => new Promise(resolve => { resolveCreate = resolve; }) });
  const controller = new AbortController();
  const pending = f.manager.start(input, { signal: controller.signal });
  controller.abort();
  assert.equal(f.manager.active(), true);
  resolveCreate(response());
  const result = await pending;
  f.sockets[0].open();
  assert.equal(f.manager.heartbeat(result.id).closing, true);
  assert.equal(f.sockets[0].sent.filter(event => event.type === 'session.close').length, 1);
  f.sockets[0].receive({ type: 'session.closed', usage: { seconds: 0 } });
  assert.equal(f.manager.active(), false);
  assert.equal(f.manager.heartbeat(result.id).finalized, true);
});

test('an already-aborted start does not issue a paid session request', async t => {
  const f = fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.manager.start(input, { signal: controller.signal }), { status: 409 });
  assert.equal(f.requests.length, 0);
  assert.equal(f.manager.active(), false);
});

test('heartbeat refreshes the lease but cannot revive a closing session, whose cleanup is bounded', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { leaseMs: 100, closeMs: 50, attachMs: 500 });
  const result = await f.manager.start(input);
  const socket = f.sockets[0]; socket.open();
  t.mock.timers.tick(80);
  assert.equal(f.manager.heartbeat(result.id).closing, false);
  t.mock.timers.tick(80);
  assert.equal(socket.sent.length, 0);
  t.mock.timers.tick(20);
  assert.equal(socket.sent.filter(event => event.type === 'session.close').length, 1);
  assert.equal(f.manager.heartbeat(result.id).closing, true);
  t.mock.timers.tick(50);
  const snapshot = f.manager.heartbeat(result.id);
  assert.equal(snapshot.active, false);
  assert.equal(snapshot.finalized, false);
  assert.match(snapshot.error, /without confirmed/);
  assert.equal(socket.readyState, 3);
  assert.equal(f.manager.active(), false);
});

test('control attachment timeout closes the reservation without claiming finalized usage', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { attachMs: 20, closeMs: 30, leaseMs: 1000 });
  const result = await f.manager.start(input);
  t.mock.timers.tick(20);
  assert.equal(f.manager.heartbeat(result.id).closing, true);
  t.mock.timers.tick(30);
  assert.equal(f.manager.active(), false);
  assert.equal(f.manager.heartbeat(result.id).finalized, false);
  assert.equal(f.sockets[0].readyState, 3);
});

test('a known created session is closed even when the upstream WebRTC answer is malformed', async t => {
  const f = fixture(t, { fetchImpl: async () => response({ session: answer.session, transport: { type: 'webrtc' } }) });
  await assert.rejects(f.manager.start(input), { status: 502 });
  assert.equal(f.sockets.length, 1, 'The known session must retain its cleanup connection.');
  f.sockets[0].open();
  assert.equal(f.sockets[0].sent.filter(event => event.type === 'session.close').length, 1);
  assert.equal(f.manager.active(), true);
  f.sockets[0].receive({ type: 'session.closed' });
  assert.equal(f.manager.active(), false);
});

test('upstream failures are sanitized and do not leave an active local reservation', async t => {
  let bodyCanceled = false;
  const rejected = fixture(t, { fetchImpl: async () => ({ ok: false, body: { async cancel() { bodyCanceled = true; } }, async json() { throw new Error(key); } }) });
  await assert.rejects(rejected.manager.start(input), error => error.status === 502 && !error.message.includes(key));
  assert.equal(bodyCanceled, true);
  assert.equal(rejected.manager.active(), false);
  const failed = fixture(t, { fetchImpl: async () => { throw new Error(`Connection failed: ${key}`); } });
  await assert.rejects(failed.manager.start(input), error => error.status === 502 && !error.message.includes(key));
  assert.equal(failed.manager.active(), false);
});

test('browser endpoints reject hostile hosts and origins before negotiation or mutation', async t => {
  const f = await httpFixture(t);
  for (const headers of [
    { host: 'attacker.test' }, { origin: 'https://attacker.test' }, { origin: 'null' },
    { origin: 'http://localhost:3211' }, { 'sec-fetch-site': 'cross-site' },
  ]) {
    assert.equal((await f.request('/api/local-test/config', 'GET', undefined, headers)).status, 403);
    assert.equal((await f.request('/api/local-test/session', 'POST', input, headers)).status, 403);
    assert.equal((await f.request('/api/local-test/unknown/stop', 'POST', {}, headers)).status, 403);
    assert.equal((await f.request('/api/local-test/unknown/heartbeat', 'POST', {}, headers)).status, 403);
  }
  assert.equal((await f.request('/api/local-test/session', 'POST', input, { 'content-type': 'text/plain' })).status, 415);
  assert.equal(f.requests.length, 0);
  assert.equal(f.phoneRequests(), 0);
  assert.equal(f.manager.active(), false);
});

test('OpenAI-only browser testing neither requires Twilio nor mutates phone call records', async t => {
  const f = await httpFixture(t);
  f.store.state.plans.push({ ...brief, id: 'plan-for-telephone', privateRuntimeValue: key });
  const initialStore = JSON.stringify(f.store.state);
  const config = await f.request('/api/local-test/config');
  assert.equal(config.status, 200);
  assert.equal(config.body.ready, true);
  assert.deepEqual(config.body.brief, briefSchema.parse(brief));
  assert.equal(config.text.includes(key), false);
  assert.equal(config.headers['cache-control'], 'no-store');
  const session = await f.request('/api/local-test/session', 'POST', input, { origin: 'http://localhost:3210' });
  assert.equal(session.status, 201);
  assert.equal(session.text.includes(key), false);
  f.sockets[0].open();
  assert.equal((await f.request('/api/plans/plan-for-telephone/call', 'POST', {})).status, 409);
  assert.equal((await f.request('/api/settings', 'POST', { accountSid: '' })).status, 409);
  assert.equal(f.phoneRequests(), 0);
  assert.equal(JSON.stringify(f.store.state), initialStore);
  assert.equal((await f.request(`/api/local-test/${session.body.id}/heartbeat`, 'POST', {})).body.active, true);
  assert.equal((await f.request(`/api/local-test/${session.body.id}/stop`, 'POST', {})).body.closing, true);
  f.sockets[0].receive({ type: 'session.closed', usage: { seconds: 2 } });
  const ended = await f.request(`/api/local-test/${session.body.id}/heartbeat`, 'POST', {});
  assert.equal(ended.body.finalized, true);
  assert.equal(ended.body.active, false);
  assert.equal(f.phoneRequests(), 0);
  assert.equal(JSON.stringify(f.store.state), initialStore);
});

test('HTTP browser setup reports missing key and invalid offers without upstream work', async t => {
  const missing = await httpFixture(t, { config: { apiKey: '' } });
  assert.equal((await missing.request('/api/local-test/config')).body.ready, false);
  assert.equal((await missing.request('/api/local-test/session', 'POST', input)).status, 503);
  assert.equal(missing.requests.length, 0);
  const f = await httpFixture(t);
  for (const sdp of ['', 'invalid', 'v=0' + 'x'.repeat(65_536)]) {
    assert.equal((await f.request('/api/local-test/session', 'POST', { ...input, sdp })).status, 400);
  }
  assert.equal((await f.request('/api/local-test/missing/heartbeat', 'POST', {})).status, 404);
  assert.equal((await f.request('/api/local-test/missing/stop', 'POST', {})).status, 404);
  f.store.state.calls.push({ id: 'active-telephone', status: 'dialing' });
  assert.equal((await f.request('/api/local-test/session', 'POST', input)).status, 409);
  assert.equal(f.requests.length, 0);
  assert.equal(f.phoneRequests(), 0);
});
