import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Store } from '../src/store.js';
import { createApps } from '../src/server.js';

const waitEvent = (target, name) => once(target, name, { signal: AbortSignal.timeout(1500) });

test('the local listen endpoint carries both bridge tracks without sending audio to the phone or retaining it', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-monitor-http-'));
  const store = new Store(directory);
  const config = { port: 3210, apiKey: 'test-only', accountSid: `AC${'a'.repeat(32)}`, authToken: 'test-only',
    fromNumber: '+12025550100', publicBaseUrl: 'https://example.test', backendModel: 'gpt-5.6-terra' };
  let hooks;
  let stops = 0;
  const apps = createApps({ config, store, preflight: async () => {},
    provider: { create: async () => ({ sid: `CA${'b'.repeat(32)}` }), end: async () => { stops++; } },
    bridgeFactory: options => {
      hooks = options;
      return { prepare: async () => {}, close: () => options.onAudioEnd(), attachProvider: () => true };
    },
  });
  const server = apps.dashboard.listen(0, '127.0.0.1');
  await waitEvent(server, 'listening');
  apps.webhookServer.listen(0, '127.0.0.1');
  await waitEvent(apps.webhookServer, 'listening');
  const requests = [];
  t.after(() => {
    requests.forEach(req => req.destroy());
    apps.monitor.dispose(); apps.calls.dispose(); apps.localTests.dispose();
    server.closeAllConnections(); server.close(); apps.webhookServer.close(); apps.wss.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const plan = apps.calls.plan({ recipientName: 'Expected tester', phoneNumber: '+12025550101', callerName: 'Owner',
    language: 'English', goal: 'Test the local monitor.', context: '', constraints: '', maxDurationSeconds: 60 });
  const call = await apps.calls.start(plan.id);
  hooks.onConnected();
  const request = (route, headers = {}) => http.request({ hostname: '127.0.0.1', port: server.address().port,
    path: route, headers: { host: 'localhost:3210', ...headers } });
  const status = (route, headers) => new Promise(resolve => {
    const req = request(route, headers); requests.push(req);
    req.on('response', res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.end();
  });
  const route = `/api/calls/${call.id}/audio`;
  assert.equal(await status(route, { origin: 'https://attacker.example' }), 403);
  assert.equal(await status(route, { host: 'attacker.example' }), 403);
  assert.equal(await status(route, { 'sec-fetch-site': 'cross-site' }), 403);
  assert.equal((await fetch(`http://127.0.0.1:${apps.webhookServer.address().port}${route}`)).status, 404);
  assert.equal(await status('/api/calls/missing/audio'), 404);

  const received = [];
  const events = new EventEmitter();
  const req = request(route); requests.push(req);
  const response = waitEvent(req, 'response'); req.end();
  const [res] = await response;
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/event-stream/);
  let pending = '';
  res.setEncoding('utf8');
  res.on('data', chunk => {
    pending += chunk;
    for (;;) {
      const boundary = pending.indexOf('\n\n');
      if (boundary < 0) break;
      const text = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
      const type = /^event: ?(.+)$/m.exec(text)?.[1];
      const raw = /^data: ?(.+)$/m.exec(text)?.[1];
      if (type && raw) { const data = JSON.parse(raw); received.push({ type, data }); events.emit(type, data); }
    }
  });
  await waitEvent(events, 'ready');
  const payload = Buffer.alloc(160, 0xff).toString('base64');
  for (const track of ['recipient', 'assistant']) {
    const next = waitEvent(events, 'audio');
    hooks.onAudio({ track, payload, sampleRate: 8000, timestampMs: 100, secret: 'must-not-leak' });
    const [frame] = await next;
    assert.deepEqual(frame, { track, payload, sampleRate: 8000, timestampMs: 100 });
  }
  assert.equal(stops, 0, 'Listening must never call the phone stop endpoint.');
  assert.ok(!JSON.stringify(store.state).includes(payload), 'Audio must not enter persisted phone history.');
  const closed = waitEvent(events, 'ended');
  hooks.onAudioEnd();
  await closed;
  assert.equal(stops, 0, 'Ending the monitor is independent from hanging up.');
  store.update(call, { status: 'completed' });
  assert.equal(await status(route), 409);
  assert.deepEqual(received.map(event => event.type), ['ready', 'audio', 'audio', 'ended']);
});
