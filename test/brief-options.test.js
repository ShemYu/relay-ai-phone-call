import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { briefSchema, buildSession, openingLine } from '../src/brief.js';
import { browserSession } from '../src/local-test.js';
import { Calls } from '../src/calls.js';
import { Store } from '../src/store.js';

const legacyBrief = {
  recipientName: 'Test recipient', phoneNumber: '+12025550123', callerName: 'Alex',
  language: 'Japanese', goal: 'Ask about the opening hours tomorrow.',
  context: 'Only confirm the opening hours.', constraints: 'Do not make a reservation.', maxDurationSeconds: null,
};

test('legacy briefs retain Marin and the language-appropriate default opening', () => {
  const parsed = briefSchema.parse(legacyBrief);
  assert.equal(parsed.voice, 'marin');
  assert.equal(parsed.openingMessage, '');
  assert.equal(buildSession(legacyBrief, 'test-backend').audio.output.voice, 'marin');
  assert.equal(openingLine(parsed), openingLine(legacyBrief));
  assert.equal(openingLine(parsed), 'もしもし。');
  assert.equal(openingLine({ ...parsed, language: 'Mandarin Chinese (Taiwan)' }), '喂，你好。');
  assert.equal(openingLine({ ...parsed, language: 'English' }), 'Hello.');
});

test('every supported per-brief voice is identical in telephone and browser sessions', () => {
  for (const voice of ['marin', 'gleam', 'willow', 'quartz']) {
    const brief = { ...legacyBrief, voice, openingMessage: 'もしもし、明日の営業時間を教えていただけますか？' };
    const phone = buildSession(brief, 'test-backend');
    const browser = browserSession(brief, 'test-backend');
    assert.equal(phone.audio.output.voice, voice);
    assert.equal(browser.audio.output.voice, voice);
    assert.equal(phone.delegation.responses.model, 'test-backend');
    assert.ok(phone.delegation.responses.instructions.includes(`"voice":"${voice}"`));
    const expectedBrowser = structuredClone(phone);
    delete expectedBrowser.audio.format;
    assert.deepEqual(browser, expectedBrowser);
    assert.deepEqual(phone.audio.format, { type: 'audio/pcmu', rate: 8000 });
  }
});

test('reviewed plans preserve the selected voice and show the exact trimmed custom opening without dialing', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-brief-options-'));
  const store = new Store(directory);
  let providerRequests = 0;
  const calls = new Calls({ store, config: {}, provider: { create() { providerRequests++; throw new Error('Unexpected phone request.'); } } });
  t.after(() => { calls.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  const custom = '欸，猜猜我是誰？';
  const plan = calls.plan({ ...legacyBrief, callerName: 'Alex', language: 'Mandarin Chinese (Taiwan)', voice: 'willow',
    goal: 'Play a light guessing game and reveal the caller only after the recipient guesses correctly.', openingMessage: `  ${custom}\n` });
  assert.equal(plan.voice, 'willow');
  assert.equal(plan.openingMessage, custom);
  assert.equal(plan.openingLine, custom);
  assert.equal(store.plan(plan.id).openingLine, custom);
  assert.equal(JSON.parse(fs.readFileSync(store.file, 'utf8')).plans[0].openingMessage, custom);
  assert.equal(providerRequests, 0);
  assert.equal(store.state.calls.length, 0);
});

test('an empty custom opening keeps the default greeting instead of creating silence', () => {
  const expected = openingLine(legacyBrief);
  for (const openingMessage of ['', '  \n\t  ']) {
    const parsed = briefSchema.parse({ ...legacyBrief, openingMessage });
    assert.equal(parsed.openingMessage, '');
    assert.equal(openingLine(parsed), expected);
  }
});

test('unsupported voices are rejected rather than silently substituted', () => {
  for (const voice of ['alloy', 'MARIN', '', 'unknown', null, 123]) {
    assert.throws(() => briefSchema.parse({ ...legacyBrief, voice }));
    assert.throws(() => buildSession({ ...legacyBrief, voice }, 'test-backend'));
  }
});

test('custom openings accept the maximum length after trimming and reject oversized or nontext values', () => {
  const maximum = 'x'.repeat(500);
  assert.equal(briefSchema.parse({ ...legacyBrief, openingMessage: ` ${maximum} ` }).openingMessage, maximum);
  for (const openingMessage of ['x'.repeat(501), null, 123]) {
    assert.throws(() => briefSchema.parse({ ...legacyBrief, openingMessage }));
  }
});

test('new brief fields do not admit runtime tokens, transcripts, or credentials into model context', () => {
  const runtime = {
    streamToken: 'private-stream-token-marker', providerCallSid: 'private-call-id-marker',
    accountSid: 'private-account-id-marker', apiKey: 'private-api-key-marker',
    authToken: 'private-auth-token-marker', openingLine: 'unreviewed-runtime-opening-marker',
    transcript: [{ text: 'private-transcript-marker' }], voiceUsage: { marker: 'private-usage-marker' },
  };
  const input = { ...legacyBrief, voice: 'quartz', openingMessage: 'Reviewed custom opening.', ...runtime };
  const parsed = briefSchema.parse(input);
  for (const key of Object.keys(runtime)) assert.equal(Object.hasOwn(parsed, key), false);
  assert.equal(parsed.voice, 'quartz');
  assert.equal(parsed.openingMessage, 'Reviewed custom opening.');
  for (const session of [buildSession(input, 'test-backend'), browserSession(input, 'test-backend')]) {
    const serialized = JSON.stringify(session);
    for (const marker of ['private-stream-token-marker', 'private-call-id-marker', 'private-account-id-marker',
      'private-api-key-marker', 'private-auth-token-marker', 'unreviewed-runtime-opening-marker',
      'private-transcript-marker', 'private-usage-marker']) assert.equal(serialized.includes(marker), false);
  }
});
