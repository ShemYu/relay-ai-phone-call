import { createCallMonitor } from './call-monitor.js';

const $ = (id) => document.getElementById(id);
const callMonitor = createCallMonitor({ root: $('call-monitor') });
window.addEventListener('pagehide', () => callMonitor.stop('stopped', 'Listening stopped. Press Listen to reconnect.'));
const activeStatuses = new Set(['preparing', 'queued', 'initiated', 'dialing', 'ringing', 'in-progress']);
const statusNames = { draft: 'Draft', preparing: 'Preparing', queued: 'Queued', initiated: 'Starting', dialing: 'Dialing', ringing: 'Ringing', 'in-progress': 'In conversation', completed: 'Call ended', busy: 'Busy', 'no-answer': 'No answer', canceled: 'Canceled', failed: 'Failed' };
let serviceStatus = null;
let plan = null;
let currentCall = null;
let calls = [];
let pollingTimer = null;
let refreshing = false;
let placingCall = false;
let transcriptSignature = '';
let refreshFailureCount = 0;
let settingsLoaded = false;
let savingSettings = false;
const previousCallStatuses = new Map();
const finalizationDeadlines = new Map();

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || `The request could not be completed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function displayError(message) {
  $('form-error').textContent = message || '';
  $('form-error').hidden = !message;
  if (message) $('form-error').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function setStep(step) {
  ['brief', 'review', 'call'].forEach((name, index) => {
    const item = $(`step-${name}`);
    item.classList.toggle('current', index === step);
    item.classList.toggle('complete', index < step);
    if (index === step) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  });
  $('step-count').textContent = `0${step + 1} / 03`;
}

function hasActiveCall() {
  return Boolean(serviceStatus?.activeCallId || serviceStatus?.localTestActive) || calls.some((call) => activeStatuses.has(call.status)) || activeStatuses.has(currentCall?.status);
}

function updateCallButton() {
  const activeCall = hasActiveCall();
  $('place-call-button').disabled = !plan || !serviceStatus?.ready || activeCall || placingCall || savingSettings;
  $('call-readiness').classList.toggle('warning', !serviceStatus?.ready || activeCall);
  $('call-readiness').textContent = serviceStatus?.localTestActive ? 'A browser voice test is active. End it before placing a phone call.' : activeCall ? 'A call is already active. End it before placing another call.' : serviceStatus?.ready ? 'Configuration is ready. Call placement checks OpenAI access, then uses your OpenAI and Twilio accounts.' : 'Your brief is ready to review. Finish the connection setup above before placing the call.';
  $('save-settings-button').disabled = !settingsLoaded || !serviceStatus || activeCall || placingCall || savingSettings;
  for (const input of $('settings-form').querySelectorAll('input')) input.disabled = !settingsLoaded || savingSettings;
  if (activeCall || placingCall) $('settings-message').textContent = 'Connection settings cannot be changed during a call or browser test.';
  else if ($('settings-message').textContent === 'Connection settings cannot be changed during a call or browser test.') $('settings-message').textContent = 'Settings apply to the next call.';
}

function renderSetup() {
  const ready = serviceStatus?.ready;
  $('connection-status').className = `connection-status ${ready ? 'ready' : 'error'}`;
  $('connection-label').textContent = ready ? 'Configured' : 'Setup needed';
  $('setup-title').textContent = ready ? 'Call setup is configured' : 'A few connections, then you’re ready';
  $('setup-description').textContent = ready ? 'OpenAI and Twilio are configured. Review your brief before placing a call.' : 'You can prepare and review a brief while call setup is incomplete.';
  $('setup-checks').replaceChildren(...(serviceStatus?.checks || []).map((check) => {
    const item = element('li', check.configured ? 'configured' : 'missing');
    const symbol = element('span', 'check-symbol', check.configured ? '✓' : '○');
    symbol.setAttribute('aria-hidden', 'true');
    item.append(symbol, element('span', '', `${check.label} — ${check.configured ? 'configured' : 'needed'}`));
    return item;
  }));
  updateCallButton();
}

async function refreshStatus() {
  serviceStatus = await api('/api/status');
  renderSetup();
}

function renderSettings(settings) {
  $('settings-account-sid').value = settings.accountSid || '';
  $('settings-from-number').value = settings.fromNumber || '';
  $('settings-public-url').value = settings.publicBaseUrl || '';
  $('settings-token-state').textContent = settings.authTokenConfigured ? 'saved on server' : 'not configured';
  // The API exposes only whether a token exists. Never populate the password field.
}

async function loadSettings() {
  try {
    const settings = await api('/api/settings');
    renderSettings(settings);
    settingsLoaded = true;
    $('settings-message').textContent = 'Settings apply to the next call.';
  } catch {
    $('settings-error').textContent = 'Connection settings could not be loaded. Reload the page to try again.';
    $('settings-error').hidden = false;
    $('settings-message').textContent = '';
  }
  updateCallButton();
}

$('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!settingsLoaded || !serviceStatus || hasActiveCall() || placingCall || savingSettings) return;
  const payload = {
    accountSid: $('settings-account-sid').value.trim(),
    fromNumber: $('settings-from-number').value.trim().replace(/[\s().-]/g, ''),
    publicBaseUrl: $('settings-public-url').value.trim(),
  };
  if ($('settings-auth-token').value.trim()) payload.authToken = $('settings-auth-token').value.trim();
  savingSettings = true;
  $('settings-error').hidden = true;
  $('settings-error').textContent = '';
  $('settings-message').textContent = 'Saving settings…';
  $('save-settings-button').textContent = 'Saving…';
  updateCallButton();
  try {
    const settings = await api('/api/settings', { method: 'POST', body: JSON.stringify(payload) });
    $('settings-auth-token').value = '';
    renderSettings(settings);
    if (settings.status) {
      serviceStatus = { ...serviceStatus, ...settings.status };
      renderSetup();
    }
    $('settings-message').textContent = 'Settings saved. Review the setup checklist before placing a call.';
  } catch (error) {
    // Never display a settings response verbatim: it could contain submitted credentials.
    $('settings-error').textContent = error.status === 409 ? 'A call or browser test is active. End it before saving connection settings.' : error.status === 400 ? 'Check the account SID, auth token, caller number, and HTTPS callback URL, then try again.' : 'Settings could not be saved. Check that the local service is running, then try again.';
    $('settings-error').hidden = false;
    $('settings-message').textContent = '';
  } finally {
    delete payload.authToken;
    savingSettings = false;
    $('save-settings-button').textContent = 'Save settings';
    updateCallButton();
  }
});

$('settings-form').addEventListener('input', () => {
  if (!savingSettings && !hasActiveCall()) $('settings-message').textContent = 'Unsaved changes. Settings apply to the next call.';
});

function draftFromForm() {
  const data = Object.fromEntries(new FormData($('brief-form')));
  for (const key of Object.keys(data)) data[key] = data[key].trim();
  data.phoneNumber = data.phoneNumber.replace(/[\s().-]/g, '');
  data.maxDurationSeconds = data.maxDurationSeconds === 'none' ? null : Number(data.maxDurationSeconds);
  return data;
}

function renderReview() {
  const rows = [
    ['Calling', `${plan.recipientName}\n${plan.phoneNumber}`],
    ['On behalf of', plan.callerName],
    ['Language', plan.language],
    ['Voice', { marin: 'Marin', gleam: 'Gleam · feminine', willow: 'Willow', quartz: 'Quartz' }[plan.voice || 'marin'] || plan.voice],
    ['The goal', plan.goal],
    ['Context', plan.context || 'No additional context.'],
    ['Boundaries', plan.constraints || 'No additional instructions. The assistant will stay within the goal you described.'],
    ['Time limit', plan.maxDurationSeconds === null ? 'No Relay time limit' : `${Number(plan.maxDurationSeconds) / 60} ${Number(plan.maxDurationSeconds) === 60 ? 'minute' : 'minutes'}`],
  ];
  $('review-details').replaceChildren(...rows.map(([label, value]) => {
    const row = element('div', 'review-detail');
    row.append(element('dt', '', label), element('dd', '', value));
    return row;
  }));
  $('opening-line').textContent = plan.openingLine || plan.openingMessage || 'Hello.';
  $('brief-form').hidden = true;
  $('review-panel').hidden = false;
  $('brief-title').textContent = 'Ready for a conversation';
  setStep(1);
  updateCallButton();
  $('review-panel').focus();
}

$('brief-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  displayError('');
  const draft = draftFromForm();
  if (!/^\+[1-9]\d{7,14}$/.test(draft.phoneNumber)) {
    displayError('Enter a valid international phone number starting with + and the country code.');
    $('phone-number').focus();
    return;
  }
  const button = $('review-button');
  button.disabled = true;
  button.textContent = 'Preparing brief…';
  try {
    const response = await api('/api/plans', { method: 'POST', body: JSON.stringify(draft) });
    if (!response.plan?.id) throw new Error('The service did not return a call brief. Please try again.');
    plan = { ...draft, ...response.plan };
    renderReview();
  } catch (error) { displayError(error.message); }
  finally { button.disabled = false; button.replaceChildren(document.createTextNode('Review call brief '), element('span', '', '→')); }
});

$('edit-button').addEventListener('click', () => {
  if (placingCall) return;
  displayError('');
  $('brief-form').hidden = false;
  $('review-panel').hidden = true;
  $('brief-title').textContent = 'Start with the brief';
  setStep(0);
  $('recipient-name').focus();
});

$('place-call-button').addEventListener('click', async () => {
  if (!plan || placingCall || $('place-call-button').disabled) return;
  placingCall = true;
  displayError('');
  $('edit-button').disabled = true;
  $('place-call-button').textContent = 'Placing call…';
  updateCallButton();
  try {
    const result = await api(`/api/plans/${encodeURIComponent(plan.id)}/call`, { method: 'POST', body: '{}' });
    if (!result.call?.id) throw new Error('The service did not return a call. Check recent calls before trying again.');
    currentCall = result.call;
    renderCall();
    setStep(2);
    await refreshCalls();
    schedulePolling();
    $('activity-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    displayError(error.message);
    await Promise.allSettled([refreshStatus(), refreshCalls()]);
  } finally {
    placingCall = false;
    $('edit-button').disabled = false;
    $('place-call-button').textContent = 'Place call';
    updateCallButton();
    schedulePolling();
  }
});

function formatDate(value, options = {}) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, options);
}

function formatElapsed(call) {
  const start = new Date(call.startedAt || call.createdAt).getTime();
  const end = call.endedAt ? new Date(call.endedAt).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} elapsed`;
}

function renderCall() {
  if (!currentCall) return;
  const call = currentCall;
  const active = activeStatuses.has(call.status);
  callMonitor.setCall({ id: call.id, active });
  if (!active && !finalizationDeadlines.has(call.id) && (activeStatuses.has(previousCallStatuses.get(call.id)) || !call.outcome || call.outcome.source === 'system')) {
    // Capture a short final transcript/outcome drain after the line disconnects.
    finalizationDeadlines.set(call.id, Date.now() + 10000);
  }
  previousCallStatuses.set(call.id, call.status);
  $('activity-empty').hidden = true;
  $('call-content').hidden = false;
  $('live-indicator').hidden = !active;
  $('call-recipient').textContent = call.recipientName || 'Phone call';
  $('call-number').textContent = call.phoneNumber || '';
  $('call-status').textContent = statusNames[call.status] || call.status || 'Preparing';
  $('call-status').className = `call-status${active ? ' active' : ['failed', 'busy', 'no-answer'].includes(call.status) ? ' failed' : ''}`;
  $('call-duration').textContent = formatElapsed(call);
  $('stop-call-button').hidden = !active;
  $('call-error').textContent = typeof call.error === 'string' ? call.error : call.error?.message || '';
  $('call-error').hidden = !call.error;
  const transcript = Array.isArray(call.transcript) ? call.transcript : [];
  $('transcript-count').textContent = transcript.length ? `${transcript.length} messages` : '';
  const signature = JSON.stringify([call.id, transcript]);
  if (signature !== transcriptSignature) {
    const pane = $('transcript');
    const nearBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80;
    pane.replaceChildren(...transcript.map((entry) => {
      const item = element('div', `transcript-entry ${entry.speaker === 'recipient' ? 'recipient' : 'assistant'}`);
      const heading = element('div', 'transcript-speaker', entry.speaker === 'recipient' ? call.recipientName || 'Recipient' : 'Relay assistant');
      if (entry.at) heading.append(element('time', '', formatDate(entry.at, { hour: '2-digit', minute: '2-digit' })));
      item.append(heading, element('p', '', entry.text || ''));
      return item;
    }));
    if (!transcript.length) pane.append(element('p', 'empty-transcript', active ? 'The transcript will appear when the conversation begins.' : 'No conversation transcript was received for this call.'));
    if (nearBottom) pane.scrollTop = pane.scrollHeight;
    transcriptSignature = signature;
  }
  $('call-events').replaceChildren(...(Array.isArray(call.events) ? call.events : []).map((event) => {
    const item = element('li');
    if (event.at) item.append(element('time', '', formatDate(event.at, { hour: '2-digit', minute: '2-digit' })));
    item.append(document.createTextNode(event.message || ''));
    return item;
  }));
  renderOutcome(call.outcome);
  updateCallButton();
}

function renderOutcome(outcome) {
  const panel = $('outcome');
  panel.hidden = !outcome;
  panel.replaceChildren();
  if (!outcome) return;
  const labels = { achieved: 'Goal reported reached', partial: 'Partial progress reported', 'not-achieved': 'Goal reported not reached', 'needs-user': 'Your review is needed' };
  panel.append(element('p', 'eyebrow', outcome.source === 'model' ? 'Model-reported outcome' : 'Call outcome'));
  panel.append(element('h3', '', labels[outcome.status] || 'Outcome unconfirmed'));
  if (outcome.summary) panel.append(element('p', '', outcome.summary));
  for (const [title, items] of [['Confirmed details', outcome.confirmedDetails], ['Next steps', outcome.nextSteps]]) {
    if (!Array.isArray(items) || !items.length) continue;
    const list = element('ul');
    list.append(...items.map((item) => element('li', '', typeof item === 'string' ? item : JSON.stringify(item))));
    panel.append(element('h4', '', title), list);
  }
}

function renderHistory() {
  $('history-count').textContent = String(calls.length);
  if (!calls.length) return;
  $('call-history').replaceChildren(...calls.slice(0, 12).map((call) => {
    const button = element('button', `history-item${currentCall?.id === call.id ? ' selected' : ''}`);
    button.type = 'button';
    button.setAttribute('aria-label', `View call to ${call.recipientName || call.phoneNumber}, ${statusNames[call.status] || call.status}`);
    const details = element('span');
    details.append(element('strong', '', call.recipientName || call.phoneNumber || 'Phone call'), element('small', '', formatDate(call.createdAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })));
    button.append(details, element('span', '', statusNames[call.status] || call.status || 'Preparing'));
    button.addEventListener('click', async () => {
      try {
        const { call: selectedCall } = await api(`/api/calls/${encodeURIComponent(call.id)}`);
        if (!selectedCall) throw new Error('This call could not be loaded.');
        currentCall = selectedCall;
        renderCall();
        renderHistory();
        schedulePolling();
      } catch (error) { displayError(error.message); }
    });
    return button;
  }));
}

async function refreshCalls() {
  const result = await api('/api/calls');
  calls = Array.isArray(result.calls) ? result.calls : [];
  renderHistory();
  updateCallButton();
}

function schedulePolling() {
  clearTimeout(pollingTimer);
  if (activeStatuses.has(currentCall?.status) || calls.some((call) => activeStatuses.has(call.status)) || serviceStatus?.activeCallId || serviceStatus?.localTestActive || Date.now() < (finalizationDeadlines.get(currentCall?.id) || 0)) {
    pollingTimer = setTimeout(poll, 2000);
  }
}

async function poll() {
  if (refreshing) return;
  refreshing = true;
  try {
    const tasks = [refreshCalls(), refreshStatus()];
    if (currentCall?.id) tasks.push(api(`/api/calls/${encodeURIComponent(currentCall.id)}`).then(({ call }) => { if (call) { currentCall = call; renderCall(); } }));
    const results = await Promise.allSettled(tasks);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    refreshFailureCount = 0;
  } catch {
    refreshFailureCount += 1;
    $('connection-label').textContent = 'Connection interrupted · retrying';
    $('connection-status').className = 'connection-status error';
    if (refreshFailureCount >= 3) {
      $('call-error').textContent = 'Live updates are unavailable. The call may still be active. Reconnect to check its status or end it in Twilio.';
      $('call-error').hidden = false;
    }
  } finally {
    refreshing = false;
    schedulePolling();
  }
}

$('stop-call-button').addEventListener('click', async () => {
  if (!currentCall?.id) return;
  const button = $('stop-call-button');
  button.disabled = true;
  button.textContent = 'Ending call…';
  try {
    const result = await api(`/api/calls/${encodeURIComponent(currentCall.id)}/stop`, { method: 'POST', body: '{}' });
    if (result.call) currentCall = result.call;
    else currentCall = (await api(`/api/calls/${encodeURIComponent(currentCall.id)}`)).call;
    renderCall();
    await Promise.allSettled([refreshCalls(), refreshStatus()]);
    schedulePolling();
  } catch (error) {
    $('call-error').textContent = `Could not confirm the call ended. ${error.message}`;
    $('call-error').hidden = false;
  } finally {
    button.disabled = false;
    button.replaceChildren(element('span', '', '■'), document.createTextNode(' End call'));
  }
});

async function initialize() {
  const results = await Promise.allSettled([refreshStatus(), refreshCalls(), loadSettings()]);
  if (results[0].status === 'rejected') {
    $('connection-label').textContent = 'Service unavailable';
    $('connection-status').className = 'connection-status error';
    $('setup-title').textContent = 'The local service is unavailable';
    $('setup-description').textContent = 'Start the project server, then reload this page.';
  }
  if (results[1].status === 'rejected') {
    $('call-history').replaceChildren(element('p', 'history-error', 'Recent calls could not be loaded. Reload to try again.'));
  }
  const activeId = serviceStatus?.activeCallId || calls.find((call) => activeStatuses.has(call.status))?.id;
  if (activeId) {
    try { currentCall = (await api(`/api/calls/${encodeURIComponent(activeId)}`)).call; renderCall(); }
    catch { displayError('An active call was found, but its details could not be loaded. Reload to reconnect.'); }
  }
  schedulePolling();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    Promise.allSettled([refreshStatus(), refreshCalls()]).then(schedulePolling);
  }
});

initialize();
