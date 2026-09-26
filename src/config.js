export const E164 = /^\+[1-9]\d{7,14}$/;

export function readConfig(env = process.env) {
  const port = Number(env.PORT || 3210);
  const webhookPort = Number(env.WEBHOOK_PORT || 3211);
  if (![port, webhookPort].every(n => Number.isInteger(n) && n > 0 && n < 65536) || port === webhookPort) {
    throw new Error('PORT and WEBHOOK_PORT must be different valid port numbers.');
  }
  let publicBaseUrl = '';
  try {
    const url = new URL(env.PUBLIC_BASE_URL || '');
    if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/') {
      publicBaseUrl = url.origin;
    }
  } catch { /* Setup checklist reports the missing or invalid URL. */ }
  return {
    port, webhookPort, publicBaseUrl,
    apiKey: env.OPENAI_API_KEY || '',
    backendModel: env.OPENAI_BACKEND_MODEL || 'gpt-5.6-terra',
    accountSid: env.TWILIO_ACCOUNT_SID || '',
    authToken: env.TWILIO_AUTH_TOKEN || '',
    fromNumber: env.TWILIO_PHONE_NUMBER || '',
  };
}

export function setupStatus(config) {
  const checks = [
    { id: 'openai', label: 'OpenAI API key', configured: Boolean(config.apiKey) },
    { id: 'twilioAccount', label: 'Twilio account SID', configured: /^AC[a-f\d]{32}$/i.test(config.accountSid) },
    { id: 'twilioAuth', label: 'Twilio auth token', configured: Boolean(config.authToken) },
    { id: 'number', label: 'Twilio caller number', configured: E164.test(config.fromNumber) },
    { id: 'webhooks', label: 'Public HTTPS callback URL', configured: Boolean(config.publicBaseUrl) },
  ];
  return { model: 'gpt-live-1', provider: 'Twilio', ready: checks.every(c => c.configured), checks };
}
