import dotenv from 'dotenv';
import express from 'express';
import http from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import twilio from 'twilio';
import { ZodError } from 'zod';
import { readConfig, setupStatus } from './config.js';
import { Store, TERMINAL } from './store.js';
import { Calls, AppError } from './calls.js';
import { createProvider, checkOpenAI } from './provider.js';
import { buildSession, outcomeSchema } from './brief.js';
import { createLiveBridge } from './live-bridge.js';
import { publicSettings, validateSettings, persistSettings } from './settings.js';
import { LocalTests } from './local-test.js';
import { CallMonitor } from './call-monitor.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function localOnly(port) {
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  const origins = new Set([...hosts].map(host => `http://${host}`));
  return (req, res, next) => {
    if (!hosts.has(req.headers.host) || (req.headers.origin && !origins.has(req.headers.origin))) {
      return res.status(403).json({ error: 'The dashboard is accessible only from localhost.' });
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Cross-site requests are not allowed.' });
    if (!['GET', 'HEAD'].includes(req.method) && !req.is('application/json')) return res.status(415).json({ error: 'Send application/json.' });
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; frame-ancestors 'none'");
    next();
  };
}

export function createApps({ config, store, provider, bridgeFactory = createLiveBridge, preflight = () => checkOpenAI(config),
  settingsPath = path.join(root, '.env.local'), providerFactory = createProvider, localTests: suppliedLocalTests }) {
  const monitor = new CallMonitor({ store });
  const calls = new Calls({ store, config, provider, preflight, prepareVoice: async call => {
    call.accountSid = config.accountSid;
    const bridge = bridgeFactory({
      call, apiKey: config.apiKey,
      sessionConfig: buildSession(call, config.backendModel),
      onAudio: frame => monitor.publish(call.id, frame),
      onAudioEnd: () => monitor.end(call.id),
      onProviderCallSid: sid => store.update(call, { providerCallSid: sid }),
      onTranscript: item => calls.transcript(call, item),
      onEvent: message => store.event(call, message),
      onSession: id => store.update(call, { liveSessionId: id }),
      onConnected: () => {
        if (!call.stopRequested && !TERMINAL.has(call.status)) store.update(call, { status: 'in-progress' });
      },
      onUsage: (usage, finalized) => {
        if (usage?.backend) { call.backendUsage.push(usage); store.save(); }
        else store.update(call, { voiceUsage: usage, finalizationComplete: finalized });
      },
      onOutcome: raw => { const outcome = outcomeSchema.parse(raw); store.update(call, { outcome: { ...outcome, source: 'model' } }); },
      onEnd: reason => {
        if (TERMINAL.has(call.status)) return;
        if (call.status === 'preparing' && !call.stopRequested) {
          store.update(call, { error: reason });
          calls.finish(call, 'failed');
        } else void calls.stop(call.id, reason).catch(() => {});
      },
      onFailure: reason => {
        if (call.stopRequested || TERMINAL.has(call.status)) return;
        store.update(call, { error: reason });
        // A session can fail immediately after resolving prepare(), before
        // start() resumes. Mark it terminal so that continuation cannot dial.
        if (call.status === 'preparing') calls.finish(call, 'failed');
        else void calls.stop(call.id, 'Voice connection failed.').catch(() => {});
      },
    });
    calls.bridges.set(call.id, bridge);
    await bridge.prepare();
  } });
  const localTests = suppliedLocalTests ?? new LocalTests({ config, isPhoneActive: () => Boolean(store.active()) });
  const dashboard = express();
  dashboard.disable('x-powered-by');
  dashboard.use(localOnly(config.port));
  dashboard.use('/api/local-test/session', express.json({ limit: '96kb' }));
  dashboard.use(express.json({ limit: '32kb' }));
  dashboard.get('/api/status', (_req, res) => res.json({ ...setupStatus(config), activeCallId: store.active()?.id || null, localTestActive: localTests.active() }));
  dashboard.get('/api/local-test/config', (_req, res) => {
    const source = store.state.plans.at(-1) ?? {
      recipientName: 'Browser tester', phoneNumber: '+12025550100', callerName: 'Me', language: 'Japanese',
      goal: 'Run a short two-way audio test and check that speech is clear and understood.',
      context: '', constraints: 'Do not make bookings, payments, or other commitments.', maxDurationSeconds: null,
    };
    const { recipientName, phoneNumber, callerName, language, goal, context, constraints, maxDurationSeconds, voice = 'marin', openingMessage = '' } = source;
    res.json({ ready: Boolean(config.apiKey), model: 'gpt-live-1', voice,
      active: localTests.active(), phoneCallActive: Boolean(store.active()),
      brief: { recipientName, phoneNumber, callerName, language, voice, openingMessage, goal, context, constraints, maxDurationSeconds } });
  });
  dashboard.post('/api/local-test/session', async (req, res) => {
    const canceled = new AbortController();
    const onClose = () => { if (!res.writableEnded) canceled.abort(); };
    res.on('close', onClose);
    try { res.status(201).json(await localTests.start(req.body, { signal: canceled.signal })); }
    finally { res.off('close', onClose); }
  });
  dashboard.post('/api/local-test/:id/heartbeat', (req, res) => res.json(localTests.heartbeat(req.params.id)));
  dashboard.post('/api/local-test/:id/stop', (req, res) => res.json(localTests.stop(req.params.id)));
  dashboard.get('/api/settings', (_req, res) => res.json(publicSettings(config)));
  dashboard.post('/api/settings', (req, res) => {
    if (store.active() || localTests.active()) throw new AppError(409, 'End the active call or browser test before changing connection settings.');
    const patch = validateSettings(req.body);
    const nextConfig = { ...config, ...patch };
    const nextProvider = providerFactory(nextConfig);
    persistSettings(settingsPath, patch);
    Object.assign(config, patch);
    calls.provider = nextProvider;
    res.json({ ...publicSettings(config), status: setupStatus(config) });
  });
  dashboard.post('/api/plans', (req, res) => res.status(201).json({ plan: calls.plan(req.body) }));
  dashboard.post('/api/plans/:id/call', async (req, res) => {
    if (localTests.active()) throw new AppError(409, 'End the active browser test before placing a phone call.');
    res.json({ call: store.publicCall(await calls.start(req.params.id)) });
  });
  dashboard.get('/api/calls', (_req, res) => res.json({ calls: store.state.calls.slice(-100).reverse().map(c => {
    const { transcript, events, context, constraints, backendUsage, ...summary } = store.publicCall(c); return summary;
  }) }));
  dashboard.get('/api/calls/:id', (req, res) => {
    const call = store.call(req.params.id);
    if (!call) throw new AppError(404, 'Call not found.');
    res.json({ call: store.publicCall(call) });
  });
  dashboard.get('/api/calls/:id/audio', (req, res) => monitor.subscribe(req, res, req.params.id));
  dashboard.post('/api/calls/:id/stop', async (req, res) => {
    const call = await calls.stop(req.params.id);
    if (TERMINAL.has(call.status)) monitor.end(call.id);
    res.json({ call: store.publicCall(call) });
  });
  dashboard.use(express.static(path.join(root, 'public')));
  dashboard.use((error, _req, res, _next) => {
    if (error instanceof ZodError) return res.status(400).json({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    res.status(error.status || 500).json({ error: error instanceof AppError ? error.message : 'The request could not be completed.' });
  });

  const callbacks = express();
  callbacks.disable('x-powered-by');
  callbacks.use(express.urlencoded({ extended: false, limit: '16kb' }));
  callbacks.post('/twilio/status/:id', async (req, res) => {
    const signature = req.headers['x-twilio-signature'];
    if (!signature || !config.authToken || !twilio.validateRequest(config.authToken, signature, config.publicBaseUrl + req.originalUrl, req.body)) {
      return res.sendStatus(403);
    }
    if (req.body.AccountSid !== config.accountSid) return res.sendStatus(403);
    await calls.status(req.params.id, req.body);
    if (TERMINAL.has(store.call(req.params.id)?.status)) monitor.end(req.params.id);
    res.sendStatus(204);
  });
  callbacks.use((_req, res) => res.sendStatus(404));
  callbacks.use((_err, _req, res, _next) => res.sendStatus(500));
  const webhookServer = http.createServer(callbacks);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const attachedBridges = new WeakSet();
  webhookServer.on('upgrade', (req, socket, head) => {
    const match = /^\/media\/([a-f\d-]{36})$/.exec(req.url || '');
    const call = match && store.call(match[1]);
    const signature = req.headers['x-twilio-signature'];
    // Twilio signs the public wss:// URL, even when a tunnel terminates TLS.
    const streamUrl = config.publicBaseUrl.replace('https:', 'wss:') + req.url;
    const valid = signature && config.authToken && twilio.validateRequest(config.authToken, signature, streamUrl, {});
    const bridge = call && calls.bridges.get(call.id);
    if (!valid || !call || call.status === 'preparing' || TERMINAL.has(call.status) || call.stopRequested || !bridge || attachedBridges.has(bridge)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    // Reserve the one provider attachment before completing the upgrade. A
    // closed socket never allows a second stream to reuse the prepared session.
    attachedBridges.add(bridge);
    wss.handleUpgrade(req, socket, head, providerSocket => {
      if (!bridge.attachProvider(providerSocket)) providerSocket.close();
    });
  });
  return { dashboard, webhookServer, calls, wss, localTests, monitor };
}

async function main() {
  dotenv.config({ path: path.join(root, '.env.local'), quiet: true });
  const config = readConfig();
  const store = new Store(path.join(root, 'data'));
  const apps = createApps({ config, store, provider: createProvider(config) });
  // Acquire both listeners before recovery: a duplicate launch must never stop
  // the original instance's active call before discovering its occupied ports.
  const dashboardServer = apps.dashboard.listen(config.port, '127.0.0.1');
  try {
    await once(dashboardServer, 'listening');
    apps.webhookServer.listen(config.webhookPort, '127.0.0.1');
    await once(apps.webhookServer, 'listening');
  } catch (error) {
    dashboardServer.close(); apps.webhookServer.close(); apps.wss.close();
    throw error;
  }
  await apps.calls.recover();
  console.log(`Relay dashboard: http://localhost:${config.port}`);
  console.log(`Phone callbacks: http://127.0.0.1:${config.webhookPort} (tunnel this port only)`);
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    const active = store.active();
    if (active) await apps.calls.stop(active.id, 'Server shutting down.').catch(() => {});
    apps.localTests.dispose();
    apps.monitor.dispose();
    apps.calls.dispose();
    dashboardServer.close(); apps.webhookServer.close(); apps.wss.close();
    setTimeout(() => process.exit(0), 16000).unref();
  }
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Could not start Relay. Check configuration and the local data file.'); process.exitCode = 1; });
}
