import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import twilio from 'twilio';
import WebSocket from 'ws';
import { Store } from '../src/store.js';
import { createApps } from '../src/server.js';

test('public webhook listener exposes no dashboard/API and rejects unsigned status', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-http-'));
  const store = new Store(dir);
  const config = { port: 3210, accountSid: 'AC' + 'a'.repeat(32), authToken: 'test', publicBaseUrl: 'https://example.test' };
  const app = createApps({ config, store, provider: {} });
  app.webhookServer.listen(0, '127.0.0.1');
  await once(app.webhookServer, 'listening');
  t.after(() => { app.calls.dispose(); app.webhookServer.close(); app.wss.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.webhookServer.address().port}`;
  assert.equal((await fetch(base + '/api/calls')).status, 404);
  assert.equal((await fetch(base + '/')).status, 404);
  assert.equal((await fetch(base + '/twilio/status/none', { method: 'POST' })).status, 403);
  const body = { AccountSid: config.accountSid, CallSid: 'CA' + 'b'.repeat(32), CallStatus: 'completed' };
  const signature = twilio.getExpectedTwilioSignature(config.authToken, config.publicBaseUrl + '/twilio/status/none', body);
  const response = await fetch(base + '/twilio/status/none', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature }, body: new URLSearchParams(body) });
  assert.equal(response.status, 204);
});

test('dashboard rejects hostile hosts, cross-origin posts and malformed origins', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-local-'));
  const config = { port: 3210, apiKey: '', accountSid: '', authToken: '', fromNumber: '', publicBaseUrl: '' };
  const app = createApps({ config, store: new Store(dir), provider: {} });
  const server = app.dashboard.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); app.wss.close(); app.calls.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  async function request(headers) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/status', headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end();
    });
  }
  assert.equal(await request({ host: 'localhost:3210' }), 200);
  assert.equal(await request({ host: 'attacker.example' }), 403);
  assert.equal(await request({ host: 'localhost:3210', origin: 'https://attacker.example' }), 403);
  assert.equal(await request({ host: 'localhost:3210', origin: 'null' }), 403);
  assert.equal(await request({ host: 'localhost:3210', 'sec-fetch-site': 'cross-site' }), 403);
});

test('media upgrade authenticates the public WSS URL before attaching the prepared bridge', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-upgrade-'));
  const store = new Store(dir);
  const config = { port: 3210, apiKey: 'test-only', accountSid: 'AC' + 'a'.repeat(32), authToken: 'test', fromNumber: '+12025550100', publicBaseUrl: 'https://example.test', backendModel: 'gpt-5.6-terra' };
  let bridged = 0;
  let attached = 0;
  let providerSocket;
  let handlers;
  const app = createApps({ config, store, preflight: async () => {},
    provider: { create: async () => ({ sid: 'CA' + 'b'.repeat(32) }) },
    bridgeFactory: options => {
      bridged++;
      handlers = options;
      assert.equal(options.providerSocket, undefined);
      return {
        async prepare() { options.onSession('live_prepared'); },
        attachProvider(socket) { attached++; providerSocket = socket; return true; },
        close() { providerSocket?.close(); },
      };
    },
  });
  const plan = app.calls.plan({ recipientName: 'Test', phoneNumber: '+12025550101', callerName: 'Alex', language: 'English', goal: 'Ask about opening hours.', context: '', constraints: '', maxDurationSeconds: 60 });
  const call = await app.calls.start(plan.id);
  const id = call.id;
  assert.equal(bridged, 1);
  assert.equal(call.liveSessionId, 'live_prepared');
  assert.equal(call.status, 'dialing', 'A prepared session is not an answered phone call.');
  app.webhookServer.listen(0, '127.0.0.1');
  await once(app.webhookServer, 'listening');
  t.after(() => {
    for (const socket of app.wss.clients) socket.terminate();
    app.calls.dispose(); app.webhookServer.close(); app.wss.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  const url = `ws://127.0.0.1:${app.webhookServer.address().port}/media/${id}`;
  async function attempt(signature) {
    return new Promise(resolve => {
      const ws = new WebSocket(url, { headers: { 'x-twilio-signature': signature } });
      ws.on('open', () => resolve(101));
      ws.on('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode); });
      ws.on('error', () => {});
    });
  }
  assert.equal(await attempt('invalid'), 403);
  assert.equal(bridged, 1);
  assert.equal(attached, 0);
  const signature = twilio.getExpectedTwilioSignature(config.authToken, `wss://example.test/media/${id}`, {});
  call.status = 'preparing';
  assert.equal(await attempt(signature), 403, 'The stream cannot attach before dialing is authorized.');
  assert.equal(attached, 0);
  call.status = 'dialing';
  assert.equal(await attempt(signature), 101);
  assert.equal(bridged, 1);
  assert.equal(attached, 1);
  assert.equal(call.status, 'dialing', 'The WebSocket upgrade alone does not validate the stream start.');
  handlers.onConnected();
  assert.equal(call.status, 'in-progress');
  assert.equal(await attempt(signature), 403); // One live stream per authorized call.
  providerSocket.close();
  await once(providerSocket, 'close');
  assert.equal(app.calls.bridges.has(id), true, 'Socket closure must retain the call reservation.');
  assert.equal(await attempt(signature), 403);
});

test('even a signed media upgrade cannot create a missing prepared session', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-unprepared-'));
  const store = new Store(dir);
  const id = '12345678-1234-1234-1234-123456789abc';
  store.state.calls.push({ id, status: 'dialing', stopRequested: false });
  const config = { port: 3210, accountSid: 'AC' + 'a'.repeat(32), authToken: 'test', publicBaseUrl: 'https://example.test' };
  let bridged = 0;
  const app = createApps({ config, store, provider: {}, bridgeFactory: () => { bridged++; } });
  app.webhookServer.listen(0, '127.0.0.1');
  await once(app.webhookServer, 'listening');
  t.after(() => { app.calls.dispose(); app.webhookServer.close(); app.wss.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const signature = twilio.getExpectedTwilioSignature(config.authToken, `wss://example.test/media/${id}`, {});
  const status = await new Promise(resolve => {
    const socket = new WebSocket(`ws://127.0.0.1:${app.webhookServer.address().port}/media/${id}`, { headers: { 'x-twilio-signature': signature } });
    socket.on('unexpected-response', (_req, res) => { res.resume(); socket.terminate(); resolve(res.statusCode); });
    socket.on('error', () => {});
  });
  assert.equal(status, 403);
  assert.equal(bridged, 0);
});

function preparedFixture(t, configure = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-prepared-'));
  const store = new Store(dir);
  const config = { port: 3210, apiKey: 'test-only', accountSid: 'AC' + 'a'.repeat(32), authToken: 'test', fromNumber: '+12025550100', publicBaseUrl: 'https://example.test', backendModel: 'gpt-5.6-terra' };
  const ended = [];
  const provider = { create: async () => ({ sid: 'CA' + 'b'.repeat(32) }), end: async sid => { ended.push(sid); } };
  let handlers;
  let closed = 0;
  const bridge = { async prepare() { handlers.onSession('live_prepared'); }, attachProvider() { return true; }, close() { closed++; } };
  configure({ bridge, provider, getHandlers: () => handlers });
  const app = createApps({ config, store, provider, preflight: async () => {}, bridgeFactory: options => { handlers = options; return bridge; } });
  const plan = app.calls.plan({ recipientName: 'Test', phoneNumber: '+12025550101', callerName: 'Alex', language: 'English', goal: 'Ask about opening hours.', context: '', constraints: '', maxDurationSeconds: 60 });
  t.after(() => { app.calls.dispose(); app.wss.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { app, store, plan, ended, provider, getHandlers: () => handlers, getClosed: () => closed };
}

test('failed voice preparation remains a preparation failure and never dials', async t => {
  let dialed = false;
  const f = preparedFixture(t, ({ bridge, provider, getHandlers }) => {
    bridge.prepare = async () => {
      getHandlers().onFailure('Voice startup failed.');
      throw new Error('Voice startup failed.');
    };
    provider.create = async () => { dialed = true; };
  });
  const call = await f.app.calls.start(f.plan.id);
  assert.equal(call.status, 'failed');
  assert.equal(call.error, 'Voice startup failed.');
  assert.equal(dialed, false);
  assert.equal(f.getClosed(), 1);
  assert.equal(f.app.calls.bridges.size, 0);
});

test('voice failure during a pending dial stops the late provider ID', async t => {
  let resolveDial;
  const f = preparedFixture(t, ({ provider }) => {
    provider.create = () => new Promise(resolve => { resolveDial = resolve; });
  });
  const pending = f.app.calls.start(f.plan.id);
  await new Promise(resolve => setImmediate(resolve));
  const call = f.store.active();
  f.getHandlers().onFailure('Voice connection closed.');
  assert.equal(call.stopRequested, true);
  assert.equal(call.status, 'dialing');
  assert.equal(f.app.calls.bridges.has(call.id), true);
  assert.equal(f.ended.length, 0);
  resolveDial({ sid: 'CA' + 'b'.repeat(32) });
  await pending;
  assert.deepEqual(f.ended, ['CA' + 'b'.repeat(32)]);
  assert.equal(call.status, 'completed');
  assert.equal(call.error, 'Voice connection closed.');
  assert.equal(f.app.calls.bridges.size, 0);
});

test('voice failure immediately after readiness cannot race into dialing', async t => {
  let dialed = false;
  const f = preparedFixture(t, ({ bridge, provider, getHandlers }) => {
    bridge.prepare = () => new Promise(resolve => {
      getHandlers().onSession('live_prepared');
      resolve();
      getHandlers().onFailure('Voice connection closed after readiness.');
    });
    provider.create = async () => { dialed = true; };
  });
  const call = await f.app.calls.start(f.plan.id);
  assert.equal(call.status, 'failed');
  assert.equal(call.error, 'Voice connection closed after readiness.');
  assert.equal(dialed, false);
  assert.equal(f.getClosed(), 1);
  assert.equal(f.app.calls.bridges.size, 0);
});

test('a voice session ending before dialing is reported as a preparation failure', async t => {
  let dialed = false;
  const f = preparedFixture(t, ({ bridge, provider, getHandlers }) => {
    bridge.prepare = () => new Promise(resolve => {
      getHandlers().onSession('live_prepared');
      resolve();
      getHandlers().onEnd('The voice session ended.');
    });
    provider.create = async () => { dialed = true; };
  });
  const call = await f.app.calls.start(f.plan.id);
  assert.equal(call.status, 'failed');
  assert.equal(call.error, 'The voice session ended.');
  assert.equal(call.stopRequested, false);
  assert.equal(dialed, false);
  assert.equal(f.getClosed(), 1);
  assert.equal(f.app.calls.bridges.size, 0);
});

test('unanswered calls close the prepared session and still accept final usage', async t => {
  const f = preparedFixture(t);
  const call = await f.app.calls.start(f.plan.id);
  await f.app.calls.status(call.id, { CallSid: call.providerCallSid, CallStatus: 'no-answer', SequenceNumber: '1' });
  assert.equal(call.status, 'no-answer');
  assert.equal(f.getClosed(), 1);
  assert.equal(f.app.calls.bridges.size, 0);
  f.getHandlers().onUsage({ total_seconds: 2 }, true);
  assert.deepEqual(call.voiceUsage, { total_seconds: 2 });
  assert.equal(call.finalizationComplete, true);
  f.getHandlers().onConnected();
  assert.equal(call.status, 'no-answer', 'Late readiness cannot resurrect a finished call.');
});
