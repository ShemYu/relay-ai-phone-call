import twilio from 'twilio';

export function createProvider(config, { clientFactory = twilio } = {}) {
  const client = config.accountSid && config.authToken
    ? clientFactory(config.accountSid, config.authToken, { autoRetry: false, timeout: 20000 }) : null;
  return {
    async create(call) {
      const response = new twilio.twiml.VoiceResponse();
      const stream = response.connect().stream({ url: config.publicBaseUrl.replace('https:', 'wss:') + `/media/${call.id}` });
      stream.parameter({ name: 'token', value: call.streamToken });
      // If the stream ends for any reason, end the telephone leg too.
      response.hangup();
      return client.calls.create({
        to: call.phoneNumber, from: config.fromNumber, twiml: response.toString(),
        statusCallback: `${config.publicBaseUrl}/twilio/status/${call.id}`,
        statusCallbackMethod: 'POST', statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        timeout: 30,
        ...(call.maxDurationSeconds === null ? {} : { timeLimit: call.maxDurationSeconds }),
      });
    },
    async end(sid) {
      if (!client) throw new Error('Phone provider is not configured.');
      return client.calls(sid).update({ status: 'completed' });
    },
  };
}

export async function checkOpenAI(config) {
  const response = await fetch('https://api.openai.com/v1/models/gpt-live-1', {
    headers: { Authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('OpenAI model access check failed.');
  await response.body?.cancel();
}
