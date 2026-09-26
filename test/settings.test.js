import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import dotenv from 'dotenv';
import { Store } from '../src/store.js';
import { createApps } from '../src/server.js';
import { validateSettings, persistSettings } from '../src/settings.js';

const oldToken = 'a'.repeat(32);
const newToken = 'b'.repeat(32);
const accountSid = 'AC' + '1'.repeat(32);

async function fixture(t, options = {}) {
  // macOS temporary roots may themselves be aliases; our settings writer
  // deliberately accepts only a canonical directory without symlinks.
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'relay-settings-'));
  const settingsPath = path.join(directory, '.env.local');
  const config = {
    port: 3210, webhookPort: 3211, apiKey: 'fake-openai-secret', backendModel: 'example-model',
    accountSid: '', authToken: '', fromNumber: '', publicBaseUrl: '', ...options.config,
  };
  const store = new Store(path.join(directory, 'data'));
  const providers = [];
  const providerFactory = next => {
    const provider = { configuration: { ...next } };
    providers.push(provider);
    return provider;
  };
  const app = createApps({ config, store, provider: { original: true }, providerFactory, settingsPath });
  const server = app.dashboard.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.close(); app.wss.close(); app.calls.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function request(method, body, headers = {}, route = '/api/settings') {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: server.address().port, path: route, method,
        headers: { host: 'localhost:3210', 'content-type': 'application/json', ...headers },
      }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text), text, headers: res.headers }));
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  return { directory, settingsPath, config, store, providers, app, request };
}

test('settings API redacts credentials, supports staged setup, and hot applies a complete connection', async t => {
  const f = await fixture(t);
  const initial = await f.request('GET');
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body, { accountSid: '', fromNumber: '', publicBaseUrl: '', authTokenConfigured: false });
  assert.equal(initial.headers['cache-control'], 'no-store');
  const staged = await f.request('POST', { accountSid, fromNumber: '', publicBaseUrl: '', authToken: '' });
  assert.equal(staged.status, 200);
  assert.equal(staged.body.status.ready, false);
  assert.equal(staged.body.authTokenConfigured, false);
  const saved = await f.request('POST', { authToken: newToken, fromNumber: '+12025550123', publicBaseUrl: 'https://callback.example.test/' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.status.ready, true);
  assert.equal(saved.body.publicBaseUrl, 'https://callback.example.test');
  assert.equal(saved.body.authTokenConfigured, true);
  assert.equal(f.config.authToken, newToken);
  assert.equal(f.app.calls.provider, f.providers.at(-1));
  assert.equal(f.providers.at(-1).configuration.fromNumber, '+12025550123');
  for (const response of [initial, staged, saved, await f.request('GET')]) {
    assert.equal(response.text.includes(newToken), false);
    assert.equal(response.text.includes(f.config.apiKey), false);
    assert.equal(Object.hasOwn(response.body, 'authToken'), false);
    assert.equal(Object.hasOwn(response.body, 'apiKey'), false);
  }
  assert.equal(dotenv.parse(fs.readFileSync(f.settingsPath)).TWILIO_AUTH_TOKEN, newToken);
});

test('atomic settings persistence is private and preserves unrelated dotenv contents and blank tokens', async t => {
  const f = await fixture(t, { config: { accountSid, authToken: oldToken } });
  const unchanged = '# Keep this comment and non-Twilio configuration.\nOPENAI_API_KEY="fake-openai-secret"\nOPENAI_BACKEND_MODEL=example-model\nOTHER_VALUE="first line\nTWILIO_AUTH_TOKEN=not-an-assignment\nlast line"\n';
  fs.writeFileSync(f.settingsPath, unchanged + `export TWILIO_ACCOUNT_SID = "AC${'2'.repeat(32)}" # old account\nTWILIO_AUTH_TOKEN=${oldToken}\nTWILIO_PHONE_NUMBER=+12025550000\nTWILIO_PHONE_NUMBER=+12025550001\n`, { mode: 0o644 });
  const before = fs.statSync(f.settingsPath);
  const saved = await f.request('POST', { accountSid, fromNumber: '+886912345678', publicBaseUrl: 'https://calls.example.test', authToken: '  ' });
  assert.equal(saved.status, 200);
  const text = fs.readFileSync(f.settingsPath, 'utf8');
  assert.equal(text.startsWith(unchanged), true);
  assert.deepEqual(dotenv.parse(text), {
    OPENAI_API_KEY: 'fake-openai-secret', OPENAI_BACKEND_MODEL: 'example-model',
    OTHER_VALUE: 'first line\nTWILIO_AUTH_TOKEN=not-an-assignment\nlast line',
    TWILIO_ACCOUNT_SID: accountSid, TWILIO_AUTH_TOKEN: oldToken,
    TWILIO_PHONE_NUMBER: '+886912345678', PUBLIC_BASE_URL: 'https://calls.example.test',
  });
  assert.equal(f.config.authToken, oldToken);
  assert.equal(fs.statSync(f.settingsPath).mode & 0o777, 0o600);
  assert.notEqual(fs.statSync(f.settingsPath).ino, before.ino);
  assert.equal(fs.readdirSync(f.directory).some(name => name.endsWith('.tmp')), false);
  assert.equal(saved.text.includes(oldToken), false);
});

test('settings endpoints reject cross-origin access and never persist hostile requests', async t => {
  const f = await fixture(t);
  const cases = [
    { host: 'attacker.example' },
    { origin: 'https://attacker.example' },
    { origin: 'null' },
    { origin: 'http://localhost:3211' },
    { 'sec-fetch-site': 'cross-site' },
  ];
  for (const headers of cases) {
    assert.equal((await f.request('GET', undefined, headers)).status, 403);
    assert.equal((await f.request('POST', { authToken: newToken }, headers)).status, 403);
  }
  assert.equal((await f.request('POST', { authToken: newToken }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal(fs.existsSync(f.settingsPath), false);
  assert.equal(f.providers.length, 0);
});

test('empty assignments never consume the following callback or OpenAI configuration', async t => {
  const f = await fixture(t);
  const suffix = 'OPENAI_API_KEY=fake-adjacent-openai-value\nUNRELATED_EMPTY=\nAFTER_EMPTY=preserved\nQUOTED="value with # and spaces"\nMULTILINE="first\nTWILIO_AUTH_TOKEN=quoted-content\nlast"\n';
  fs.writeFileSync(f.settingsPath, 'TWILIO_AUTH_TOKEN=\nPUBLIC_BASE_URL=\n' + suffix, { mode: 0o600 });
  const saved = await f.request('POST', { authToken: newToken, publicBaseUrl: 'https://callbacks.example.test' });
  assert.equal(saved.status, 200);
  const written = fs.readFileSync(f.settingsPath, 'utf8');
  assert.equal(written.endsWith(suffix), true);
  const parsed = dotenv.parse(written);
  assert.equal(parsed.TWILIO_AUTH_TOKEN, newToken);
  assert.equal(parsed.PUBLIC_BASE_URL, 'https://callbacks.example.test');
  assert.equal(parsed.OPENAI_API_KEY, 'fake-adjacent-openai-value');
  assert.equal(parsed.UNRELATED_EMPTY, '');
  assert.equal(parsed.AFTER_EMPTY, 'preserved');
  assert.equal(parsed.QUOTED, 'value with # and spaces');
  assert.equal(parsed.MULTILINE, 'first\nTWILIO_AUTH_TOKEN=quoted-content\nlast');
});

test('invalid settings return fixed errors without reflecting credential values or changing config', async t => {
  const f = await fixture(t);
  const invalid = [
    { accountSid: newToken }, { authToken: 'secret-invalid-token' },
    { fromNumber: '03-1234-5678' }, { authToken: { value: newToken } },
    { publicBaseUrl: 'http://example.test' }, { publicBaseUrl: 'https://example.test/path' },
    { publicBaseUrl: 'https://example.test?token=' + newToken },
    { publicBaseUrl: `https://user:${newToken}@example.test` },
    { publicBaseUrl: 'https://example.test/#' }, { publicBaseUrl: 'https://example.test/?' },
    { publicBaseUrl: 'https://example.test/\\evil' }, { settingsPath: newToken },
    { ['field-' + newToken]: 'value' }, [], null,
  ];
  for (const body of invalid) {
    const response = await f.request('POST', body);
    assert.equal(response.status, 400);
    assert.equal(response.text.includes(newToken), false);
    assert.equal(response.text.includes('secret-invalid-token'), false);
  }
  assert.equal(f.config.authToken, '');
  assert.equal(f.providers.length, 0);
  assert.equal(fs.existsSync(f.settingsPath), false);
});

test('an active or uncertain call blocks settings changes before persistence or provider replacement', async t => {
  const f = await fixture(t, { config: { authToken: oldToken } });
  fs.writeFileSync(f.settingsPath, `TWILIO_AUTH_TOKEN=${oldToken}\n`, { mode: 0o600 });
  for (const status of ['preparing', 'dialing', 'ringing', 'in-progress', 'uncertain']) {
    f.store.state.calls = [{ id: 'active', status }];
    const response = await f.request('POST', { authToken: newToken });
    assert.equal(response.status, 409);
    assert.equal(response.text.includes(oldToken), false);
    assert.equal(response.text.includes(newToken), false);
  }
  assert.equal(f.config.authToken, oldToken);
  assert.equal(f.providers.length, 0);
  assert.equal(fs.readFileSync(f.settingsPath, 'utf8'), `TWILIO_AUTH_TOKEN=${oldToken}\n`);
});

test('settings persistence refuses file and parent symlinks without touching their targets', async t => {
  const f = await fixture(t, { config: { authToken: oldToken } });
  const target = path.join(f.directory, 'untouched.txt');
  fs.writeFileSync(target, 'unchanged');
  fs.symlinkSync(target, f.settingsPath);
  const response = await f.request('POST', { authToken: newToken });
  assert.equal(response.status, 500);
  assert.equal(response.text.includes(newToken), false);
  assert.equal(f.config.authToken, oldToken);
  assert.equal(f.app.calls.provider.original, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'unchanged');
  assert.equal(fs.lstatSync(f.settingsPath).isSymbolicLink(), true);
  const directoryLink = path.join(f.directory, 'alias');
  fs.symlinkSync(f.directory, directoryLink);
  assert.throws(() => persistSettings(path.join(directoryLink, 'other.env'), validateSettings({ authToken: newToken })), { status: 500 });
  assert.equal(fs.existsSync(path.join(f.directory, 'other.env')), false);
  assert.equal(fs.readdirSync(f.directory).some(name => name.endsWith('.tmp')), false);
});
