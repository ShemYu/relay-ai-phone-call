import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import twilio from 'twilio';
import WebSocket from 'ws';
import { Store } from '../src/store.js';
import { createApps } from '../src/server.js';
import { createLiveBridge } from '../src/live-bridge.js';

const event = (emitter, name) => once(emitter, name, { signal: AbortSignal.timeout(1500) });

test('prepared Live session connects through a signed phone stream without a startup audio queue', { timeout: 5000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-phone-stream-'));
  const store = new Store(directory);
  const config = {
    port: 3210, apiKey: 'test-only', accountSid: 'AC' + 'a'.repeat(32), authToken: 'test-only',
    fromNumber: '+12025550100', publicBaseUrl: 'https://example.test', backendModel: 'gpt-5.6-terra',
  };
  const sockets = new EventEmitter();
  let live;
  class FakeLiveSocket extends EventEmitter {
    constructor() {
      super();
      this.readyState = 0;
      this.sent = [];
      live = this;
      sockets.emit('created', this);
      queueMicrotask(() => { this.readyState = 1; this.emit('open'); });
    }
    send(raw) {
      const message = JSON.parse(raw);
      this.sent.push(message);
      this.emit(message.type, message);
    }
    receive(message) { this.emit('message', JSON.stringify(message)); }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit('close');
    }
  }
  const requested = [];
  const ended = [];
  let audioTimers = 0;
  const apps = createApps({
    config, store, preflight: async () => {},
    provider: {
      create: async call => { requested.push(call.id); return { sid: 'CA' + 'b'.repeat(32) }; },
      end: async sid => { ended.push(sid); },
    },
    bridgeFactory: options => createLiveBridge({
      ...options, WebSocketImpl: FakeLiveSocket,
      timeouts: { startupMs: 1500, attachMs: 1500, finalizeMs: 1500 },
      inputClock: {
        now: () => 5000,
        setTimeout: (...args) => { audioTimers++; return setTimeout(...args); },
        clearTimeout,
      },
    }),
  });
  let peer;
  t.after(async () => {
    apps.calls.dispose();
    if (live?.readyState === 1) live.receive({ type: 'session.closed', usage: {} });
    peer?.terminate();
    for (const socket of apps.wss.clients) socket.terminate();
    apps.localTests.dispose();
    await Promise.all([
      new Promise(resolve => apps.webhookServer.close(resolve)),
      new Promise(resolve => apps.wss.close(resolve)),
    ]);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  apps.webhookServer.listen(0, '127.0.0.1');
  await event(apps.webhookServer, 'listening');
  const plan = apps.calls.plan({
    recipientName: 'Test business', phoneNumber: '+12025550101', callerName: 'Alex', language: 'English',
    goal: 'Ask about opening hours tomorrow.', context: '', constraints: 'Do not book anything.', maxDurationSeconds: 60,
  });
  const created = event(sockets, 'created');
  const starting = apps.calls.start(plan.id);
  await created;
  if (!live.sent.some(message => message.type === 'session.start')) await event(live, 'session.start');
  assert.deepEqual(requested, [], 'Provider dialing waits until the API confirms the Live session is ready.');
  assert.equal(store.active().status, 'preparing');
  assert.deepEqual(live.sent.map(message => message.type), ['session.start']);
  live.receive({ type: 'session.started', session: { id: 'live_integration' } });
  const call = await starting;
  assert.deepEqual(requested, [call.id]);
  assert.equal(call.status, 'dialing');
  assert.equal(call.liveSessionId, 'live_integration');
  assert.deepEqual(live.sent.map(message => message.type), ['session.start'], 'Preparing Live must not trigger the greeting.');

  const mediaPath = `/media/${call.id}`;
  const signature = twilio.getExpectedTwilioSignature(config.authToken, `wss://example.test${mediaPath}`, {});
  peer = new WebSocket(`ws://127.0.0.1:${apps.webhookServer.address().port}${mediaPath}`, {
    headers: { 'x-twilio-signature': signature },
  });
  await event(peer, 'open');
  assert.equal(call.status, 'dialing', 'A signed upgrade still waits for the authenticated stream start.');
  assert.deepEqual(live.sent.map(message => message.type), ['session.start']);
  const greeting = event(live, 'session.instructions.append');
  peer.send(JSON.stringify({ event: 'start', start: {
    streamSid: 'MZ_integration', callSid: call.providerCallSid, accountSid: config.accountSid,
    customParameters: { token: call.streamToken },
    mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
  } }));
  const [instructions] = await greeting;
  assert.match(instructions.content, /Greet the recipient now/);
  assert.equal(call.status, 'in-progress');

  const payload = Buffer.alloc(160, 0x7f).toString('base64');
  const upstream = event(live, 'session.input_audio.append');
  peer.send(JSON.stringify({ event: 'media', streamSid: 'MZ_integration', media: { track: 'inbound', payload } }));
  const [input] = await upstream;
  assert.equal(input.audio, payload);
  assert.equal(audioTimers, 0, 'The first phone frame forwards immediately without any queue timer.');
  const downstream = event(peer, 'message');
  live.receive({ type: 'session.output_audio.delta', delta: payload });
  const [raw] = await downstream;
  assert.deepEqual(JSON.parse(raw), { event: 'media', streamSid: 'MZ_integration', media: { payload } });

  const closeRequested = event(live, 'session.close');
  const stopped = apps.calls.stop(call.id);
  await closeRequested;
  const usage = { input_audio_seconds: 0.02, output_audio_seconds: 0.02 };
  live.receive({ type: 'session.closed', reason: 'client_requested', usage });
  await stopped;
  assert.deepEqual(ended, [call.providerCallSid]);
  assert.equal(call.status, 'completed');
  assert.equal(apps.calls.bridges.size, 0);
  assert.deepEqual(call.voiceUsage, usage);
  assert.equal(call.finalizationComplete, true);
  assert.equal(live.readyState, 3);
});
