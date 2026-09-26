import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from '../src/provider.js';

test('no Relay time limit omits the provider cutoff while keeping callback and hangup behavior', async () => {
  const requests = [];
  const provider = createProvider({
    accountSid: 'test-account', authToken: 'test-token',
    fromNumber: '+12025550100', publicBaseUrl: 'https://relay.example',
  }, { clientFactory: () => ({ calls: { create: async options => {
    requests.push(options);
    return { sid: 'test-call' };
  } } }) });
  const call = { id: 'test', phoneNumber: '+12025550101', streamToken: 'test-stream-token' };
  await provider.create({ ...call, maxDurationSeconds: null });
  await provider.create({ ...call, maxDurationSeconds: 60 });
  assert.equal(Object.hasOwn(requests[0], 'timeLimit'), false);
  assert.equal(requests[1].timeLimit, 60);
  for (const request of requests) {
    assert.equal(request.timeout, 30, 'ringing timeout is independent of conversation length');
    assert.equal(request.statusCallback, 'https://relay.example/twilio/status/test');
    assert.match(request.twiml, /<Hangup\s*\/>/);
  }
});
