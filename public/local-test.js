import { createLocalToolHandler, readTransportStats } from './local-test-protocol.js';

const $ = (id) => document.getElementById(id);
const pendingCreations = new Set();
let config = null;
let activeRun = null;
let lastRun = null;
let offlineCheck = null;
let recordingUrl = null;
let leaving = false;
let availabilityTimer = null;
let availabilityFailed = false;

function serverBusy() { return Boolean(config?.active || config?.phoneCallActive); }

function scheduleAvailabilityCheck() {
  clearTimeout(availabilityTimer);
  if (!leaving && !activeRun && (serverBusy() || availabilityFailed)) availabilityTimer = setTimeout(refreshAvailability, 3000);
}

function renderAvailability() {
  if (activeRun || offlineCheck || !config) return;
  if (serverBusy()) stage('blocked', 'Another session is active', 'End the active phone call or browser test first. This page will check again automatically.');
  else if ($('session-stage').dataset.state === 'blocked') stage('idle', config.ready ? 'Ready when you are' : 'OpenAI setup needed', config.ready ? 'Your edited brief is preserved. Start whenever you are ready.' : 'Configure OpenAI in the Relay project before starting a voice test.');
}

async function refreshAvailability() {
  if (activeRun || leaving || !config) return;
  try {
    const latest = await jsonRequest('/api/local-test/config');
    config = { ...config, ready: latest.ready, active: latest.active, phoneCallActive: latest.phoneCallActive };
    availabilityFailed = false;
    renderAvailability();
  } catch {
    availabilityFailed = true;
    stage('blocked', 'Checking session availability', 'The local service could not be reached. Retrying automatically; your brief is preserved.');
  }
  updateControls();
  scheduleAvailabilityCheck();
}

function node(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function stage(state, title, detail) {
  $('session-stage').dataset.state = state;
  $('session-status').textContent = title;
  $('session-detail').textContent = detail;
}

function showError(message = '') {
  $('page-error').textContent = message;
  $('page-error').hidden = !message;
}

function supportsMicrophone() {
  return Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia);
}

function updateControls() {
  const busy = Boolean(activeRun || offlineCheck || pendingCreations.size);
  $('start-test').disabled = !config?.ready || serverBusy() || availabilityFailed || busy || !supportsMicrophone() || !window.RTCPeerConnection;
  $('start-test').textContent = lastRun?.finished ? 'Start new voice test' : 'Start voice test';
  $('brief-fields').disabled = !config?.brief || busy;
  $('end-test').disabled = !activeRun || activeRun.closing;
  $('end-test').textContent = activeRun && !activeRun.started ? 'Cancel start' : activeRun?.closing ? 'Finishing…' : 'End test';
  $('mute-test').disabled = !activeRun?.started || activeRun.closing;
  $('mute-test').textContent = activeRun?.muted ? 'Unmute microphone' : 'Mute microphone';
  $('record-mic').disabled = busy || !supportsMicrophone() || !window.MediaRecorder;
  $('stop-recording').disabled = !offlineCheck;
  $('download-log').disabled = !lastRun?.transcript.length && !lastRun?.events.length;
}

async function jsonRequest(path, body, options = {}) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...options,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(typeof result.error === 'string' ? result.error : 'The local voice service could not complete the request.');
    error.status = response.status;
    throw error;
  }
  return result;
}

function elapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function eventLog(run, message) {
  const entry = { at: new Date().toISOString(), message };
  run.events.push(entry);
  if (lastRun !== run || leaving) return;
  if (run.events.length === 1) $('test-events').replaceChildren();
  const time = new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  $('test-events').append(node('li', '', `${time} · ${message}`));
  while ($('test-events').children.length > 100) $('test-events').firstElementChild.remove();
  updateControls();
}

function appendTranscript(run, event) {
  if (typeof event.delta !== 'string') return;
  const speaker = event.type === 'session.input_transcript.delta' ? 'recipient' : 'assistant';
  // Store every fragment verbatim. A fragment is not a completed turn.
  run.transcript.push({ speaker, delta: event.delta, startMs: event.start_ms, endMs: event.end_ms, eventId: event.event_id });
  if (lastRun !== run || leaving) return;
  const pane = $('voice-transcript');
  const follow = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 90;
  if (run.transcript.length === 1) pane.replaceChildren();
  if (!run.lastFragment || run.lastFragment.speaker !== speaker) {
    const item = node('article', `voice-fragment ${speaker}`);
    const header = node('header');
    header.append(node('span', '', speaker === 'recipient' ? 'You · playing the recipient' : 'Relay assistant'));
    const text = document.createTextNode('');
    const paragraph = node('p');
    paragraph.append(text);
    item.append(header, paragraph);
    pane.append(item);
    run.lastFragment = { speaker, text };
  }
  run.lastFragment.text.appendData(event.delta);
  if (follow) pane.scrollTop = pane.scrollHeight;
  updateControls();
}

function renderOutcome(run, outcome) {
  run.outcome = { ...outcome, source: 'model' };
  const panel = $('test-outcome');
  panel.hidden = false;
  const labels = { achieved: 'Goal reported reached', partial: 'Partial progress reported', 'not-achieved': 'Goal reported not reached', 'needs-user': 'Your review is needed' };
  panel.replaceChildren(node('p', 'eyebrow', 'MODEL-REPORTED TEST OUTCOME'), node('h3', '', labels[outcome.status]), node('p', '', outcome.summary));
  for (const [title, items] of [['Reported details', outcome.confirmedDetails], ['Next steps', outcome.nextSteps]]) {
    if (!items.length) continue;
    const list = node('ul');
    list.append(...items.map((item) => node('li', '', item)));
    panel.append(node('h4', '', title), list);
  }
  panel.append(node('p', '', 'This practice conversation does not confirm a real-world booking or action.'));
  eventLog(run, 'The model reported an outcome, held only in this browser test.');
}

function sendEvent(run, event) {
  if (run.finished || run.channel?.readyState !== 'open') return false;
  try {
    run.channel.send(JSON.stringify({ ...event, event_id: crypto.randomUUID() }));
    return true;
  } catch { return false; }
}

function stopMicrophone(run) {
  run.stream?.getTracks().forEach((track) => track.stop());
}

function notifyStop(run, keepalive = false) {
  if (!run.id || run.stopRequested) return Promise.resolve();
  run.stopRequested = true;
  return jsonRequest(`/api/local-test/${encodeURIComponent(run.id)}/stop`, {}, { keepalive }).catch(() => {
    // The server's lease watchdog is the fallback if the page or network disappears.
    if (!leaving && lastRun === run) eventLog(run, 'Server cleanup could not be acknowledged. The session lease watchdog is the fallback for an abandoned connection.');
  });
}

function finishRun(run, title, detail) {
  if (run.finished) return;
  run.finished = true;
  run.endedAt = new Date().toISOString();
  for (const name of ['startupTimer', 'closeTimer', 'durationTimer', 'disconnectTimer', 'statsTimer', 'heartbeatTimer', 'elapsedTimer']) clearTimeout(run[name]);
  run.cancelIce?.();
  stopMicrophone(run);
  run.remoteStream?.getTracks().forEach((track) => track.stop());
  run.channel?.close();
  run.peer?.close();
  if (activeRun === run) {
    activeRun = null;
    $('assistant-audio').pause();
    $('assistant-audio').srcObject = null;
    $('play-assistant').hidden = true;
    $('microphone-status').textContent = 'Microphone off';
    $('stat-peer').textContent = 'Closed';
    stage(run.failure ? 'error' : 'ended', title, detail);
  }
  if (run.startedAt) $('session-elapsed').textContent = elapsed(Date.now() - run.startedAt);
  if (lastRun === run) {
    const seconds = Number.isFinite(run.usage?.seconds) ? ` (${run.usage.seconds.toFixed(1)} voice seconds)` : '';
    $('usage-status').textContent = run.finalized ? `Final voice usage received${seconds}. Backend model usage is additional.` : run.id ? 'Final voice usage is unconfirmed on this page. Server cleanup was requested.' : 'No OpenAI session was confirmed on this page.';
  }
  notifyStop(run);
  updateControls();
  scheduleAvailabilityCheck();
}

function beginClose(run, detail = 'Finishing the conversation and waiting for final usage.', failure = false) {
  if (run.finished || run.closing) return;
  run.closing = true;
  run.failure ||= failure;
  clearTimeout(run.startupTimer);
  clearTimeout(run.durationTimer);
  if (!run.started) {
    run.cancelled = true;
    eventLog(run, 'The start was canceled. Any session returned late will be closed.');
    finishRun(run, failure ? 'Could not connect' : 'Start canceled', pendingCreations.has(run) ? 'Microphone off. Waiting for the local server to finish the canceled request.' : detail);
    return;
  }
  // Keep tracks and the peer alive to receive final output, but silence input.
  run.stream?.getAudioTracks().forEach((track) => { track.enabled = false; });
  $('microphone-status').textContent = 'Microphone muted';
  stage('closing', 'Finishing the conversation', detail);
  eventLog(run, 'Graceful session close requested; waiting up to 15 seconds for session.closed.');
  updateControls();
  if (!run.serverCloseSent && !sendEvent(run, { type: 'session.close' })) {
    finishRun(run, 'Test ended', 'The event connection was unavailable. Final usage was not confirmed here.');
    return;
  }
  run.closeTimer = setTimeout(() => finishRun(run, 'Test ended', 'The final session event did not arrive within 15 seconds. Server cleanup was requested.'), 15000);
}

function failRun(run, message) {
  if (run.finished) return;
  showError(message);
  eventLog(run, message);
  beginClose(run, message, true);
}

function handleMessage(run, data) {
  if (run.finished) return;
  let event;
  try { event = JSON.parse(data); }
  catch { failRun(run, 'The voice service returned an unreadable session event.'); return; }
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
    failRun(run, 'The voice service returned an invalid session event.'); return;
  }
  if (event.event_id) {
    if (run.eventIds.has(event.event_id)) return;
    run.eventIds.add(event.event_id);
    if (run.eventIds.size > 20000) run.eventIds.delete(run.eventIds.values().next().value);
  }
  if (event.type === 'session.closed') {
    run.finalized = true;
    run.usage = event.usage ?? run.usage;
    eventLog(run, 'session.closed received; final voice usage confirmed.');
    finishRun(run, 'Conversation ended', 'The voice session has closed. Your transcript stays here until you start again or leave this page.');
    return;
  }
  if (event.type === 'session.usage.updated') { run.usage = event.usage; return; }
  if (event.type === 'session.input_transcript.delta' || event.type === 'session.output_transcript.delta') { appendTranscript(run, event); return; }
  if (event.type === 'session.started') {
    if (run.started || run.closing) return;
    if (typeof event.session?.id !== 'string') { failRun(run, 'The voice session did not provide an identifier.'); return; }
    run.started = true;
    run.startedAt = Date.now();
    run.openaiSessionId = event.session.id;
    clearTimeout(run.startupTimer);
    stage('live', 'You’re in the conversation', 'Play the recipient. You can interrupt the assistant naturally.');
    $('microphone-status').textContent = 'Microphone on';
    $('usage-status').textContent = 'OpenAI session running. Final voice usage is available when the session closes.';
    eventLog(run, 'GPT-Live session started over native WebRTC audio.');
    if (!run.openingSent) {
      run.openingSent = true;
      if (!sendEvent(run, { type: 'session.instructions.append', delegation_id: null, content: run.openingInstruction })) {
        failRun(run, 'The opening instruction could not be delivered.'); return;
      }
    }
    if (Number.isFinite(run.brief.maxDurationSeconds)) run.durationTimer = setTimeout(() => beginClose(run, 'The selected Relay time limit was reached.'), run.brief.maxDurationSeconds * 1000);
    run.elapsedTimer = setInterval(() => { $('session-elapsed').textContent = elapsed(Date.now() - run.startedAt); }, 1000);
    updateControls();
  } else if (event.type === 'response.event') {
    if (event.event?.type === 'response.completed' && event.event.response?.usage) run.backendUsage.push({ responseId: event.event.response.id, usage: event.event.response.usage });
    if (!run.closing) run.handleTools(event);
  } else if (event.type === 'error') {
    failRun(run, 'The voice service rejected a session operation. End this test, check OpenAI access and account limits, then try again.');
  }
}

async function heartbeat(run) {
  if (run.finished || !run.id || run.heartbeatBusy) return;
  run.heartbeatBusy = true;
  try {
    const reply = await jsonRequest(`/api/local-test/${encodeURIComponent(run.id)}/heartbeat`, {});
    if (run.finished) return;
    run.serverCloseSent = Boolean(reply.closeSent);
    if (reply.usage) run.usage = reply.usage;
    if (reply.finalized) {
      run.finalized = true;
      eventLog(run, 'The server confirmed final session usage.');
      finishRun(run, 'Conversation ended', 'The server confirmed that the voice session has closed.');
    } else if (reply.error) failRun(run, 'The session controller reported an error. The voice test is being closed.');
    else if (reply.active === false || reply.closing) beginClose(run, 'The server is ending the voice test. Waiting for final session usage.');
  } catch {
    if (!run.finished) failRun(run, 'The local session controller is unavailable. Closing the voice test to avoid an unattended session.');
  } finally { run.heartbeatBusy = false; }
}

async function sampleStats(run) {
  if (run.finished || !run.peer || run.statsBusy) return;
  run.statsBusy = true;
  try {
    const report = await run.peer.getStats();
    if (run.finished || activeRun !== run) return;
    const measured = readTransportStats(report, run.previousStats);
    run.previousStats = measured.previous;
    const sample = { at: new Date().toISOString(), rttMs: measured.rttMs, jitterMs: measured.jitterMs, lossPercent: measured.lossPercent };
    run.stats.push(sample);
    $('stat-rtt').textContent = measured.rttMs === null ? '—' : `${Math.round(measured.rttMs)} ms`;
    $('stat-jitter').textContent = measured.jitterMs === null ? '—' : `${measured.jitterMs.toFixed(1)} ms`;
    $('stat-loss').textContent = measured.lossPercent === null ? '—' : `${measured.lossPercent.toFixed(1)}%`;
    $('stat-peer').textContent = run.peer.connectionState;
  } catch {
    if (!run.finished) for (const id of ['stat-rtt', 'stat-jitter', 'stat-loss']) $(id).textContent = '—';
  } finally { run.statsBusy = false; }
}

function waitForIce(run) {
  const peer = run.peer;
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      peer.removeEventListener('icegatheringstatechange', changed);
      run.cancelIce = null;
      if (error) reject(error); else resolve();
    };
    const changed = () => { if (peer.iceGatheringState === 'complete') finish(); };
    const timer = setTimeout(() => finish(new Error('Network candidate gathering did not finish within 10 seconds.')), 10000);
    run.cancelIce = () => finish(new Error('Start canceled.'));
    peer.addEventListener('icegatheringstatechange', changed);
    changed();
  });
}

function readBrief() {
  const fields = Object.fromEntries(new FormData($('test-brief')));
  for (const key of Object.keys(fields)) fields[key] = fields[key].trim();
  fields.maxDurationSeconds = fields.maxDurationSeconds === 'none' ? null : Number(fields.maxDurationSeconds);
  return fields;
}

function resetView(run) {
  $('voice-transcript').replaceChildren(node('p', 'voice-empty', 'Waiting for the conversation to begin.'));
  $('test-events').replaceChildren();
  $('test-outcome').hidden = true;
  $('test-outcome').replaceChildren();
  $('session-elapsed').textContent = '0:00';
  $('play-assistant').hidden = true;
  $('playback-hint').textContent = 'The assistant’s voice will play here after the connection is ready.';
  $('usage-status').textContent = 'Waiting for microphone permission. No OpenAI session created yet.';
  for (const id of ['stat-rtt', 'stat-jitter', 'stat-loss']) $(id).textContent = '—';
  $('stat-peer').textContent = 'Not started';
  eventLog(run, 'Voice-test start requested by the user.');
}

async function startTest(event) {
  event.preventDefault();
  if (activeRun || offlineCheck || pendingCreations.size || !config?.ready || serverBusy() || availabilityFailed) return;
  const run = {
    brief: readBrief(), createdAt: new Date().toISOString(), id: null, peer: null, channel: null,
    stream: null, started: false, closing: false, finished: false, cancelled: false,
    finalized: false, openingSent: false, muted: false, transcript: [], events: [], stats: [],
    backendUsage: [], eventIds: new Set(), previousStats: null,
  };
  activeRun = run;
  lastRun = run;
  showError();
  resetView(run);
  stage('permission', 'Allow your microphone', 'Audio starts only after the browser grants microphone access.');
  updateControls();
  run.handleTools = createLocalToolHandler({
    send: (message) => sendEvent(run, message),
    onOutcome: (outcome) => renderOutcome(run, outcome),
    onEnd: () => beginClose(run, 'The assistant ended the test after returning its tool result.'),
    onError: (message) => failRun(run, message),
  });
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    if (run.finished || run.cancelled || activeRun !== run || leaving) { stream.getTracks().forEach((track) => track.stop()); return; }
    run.stream = stream;
    $('microphone-status').textContent = 'Microphone on · connecting';
    stage('connecting', 'Connecting your voice', 'Opening a native WebRTC audio connection to OpenAI.');
    run.peer = new RTCPeerConnection();
    for (const track of stream.getAudioTracks()) {
      run.peer.addTrack(track, stream);
      track.addEventListener('ended', () => {
        if (!run.finished && !run.closing && stream.getAudioTracks().every((item) => item.readyState === 'ended')) failRun(run, 'The microphone became unavailable.');
      });
    }
    run.peer.addEventListener('track', ({ track }) => {
      if (run.finished) return;
      run.remoteStream ??= new MediaStream();
      run.remoteStream.addTrack(track);
      $('assistant-audio').srcObject = run.remoteStream;
      $('assistant-audio').play().catch(() => {
        if (run.finished) return;
        $('play-assistant').hidden = false;
        $('playback-hint').textContent = 'The browser paused automatic playback. Press Play assistant audio to listen.';
      });
    });
    run.peer.addEventListener('connectionstatechange', () => {
      if (run.finished) return;
      const state = run.peer.connectionState;
      $('stat-peer').textContent = state;
      eventLog(run, `Peer connection: ${state}.`);
      clearTimeout(run.disconnectTimer);
      if (state === 'failed') failRun(run, 'The WebRTC audio connection failed.');
      else if (state === 'disconnected') run.disconnectTimer = setTimeout(() => failRun(run, 'The WebRTC audio connection did not recover within 10 seconds.'), 10000);
    });
    // The event channel must exist before the SDP offer is created.
    run.channel = run.peer.createDataChannel('oai-events');
    run.channel.addEventListener('message', ({ data }) => handleMessage(run, data));
    run.channel.addEventListener('error', () => failRun(run, 'The voice event channel encountered an error.'));
    run.channel.addEventListener('close', () => {
      if (run.finished) return;
      eventLog(run, 'The event channel closed before session.closed was received.');
      finishRun(run, 'Connection ended', 'Final voice usage was not confirmed here. Server cleanup was requested.');
    });
    const offer = await run.peer.createOffer();
    if (run.finished) return;
    await run.peer.setLocalDescription(offer);
    if (run.finished) return;
    await waitForIce(run);
    if (run.finished || leaving) return;
    const sdp = run.peer.localDescription?.sdp;
    if (!sdp) throw new Error('The browser could not prepare an audio connection offer.');
    pendingCreations.add(run);
    updateControls();
    $('usage-status').textContent = 'Requesting an OpenAI session. Usage may begin when the service creates it.';
    // Do not abort this request on cancellation: its late response gives us the
    // server-owned identifier needed to explicitly close any created session.
    const reply = await jsonRequest('/api/local-test/session', { sdp, brief: run.brief });
    run.id = typeof reply.id === 'string' ? reply.id : null;
    if (run.id) config.active = true;
    if (run.finished || run.cancelled || activeRun !== run || leaving) {
      await notifyStop(run, leaving);
      if (!leaving && lastRun === run) {
        stage('ended', 'Start canceled', 'Microphone off. Cleanup of the canceled session has been requested.');
        if (run.id) $('usage-status').textContent = 'A session was created after cancellation. Cleanup was requested; final usage is not confirmed on this page.';
      }
      scheduleAvailabilityCheck();
      return;
    }
    if (!run.id || reply.transport?.type !== 'webrtc' || typeof reply.transport.sdp !== 'string' || typeof reply.openingInstruction !== 'string' || !reply.openingInstruction) throw new Error('The local service returned an incomplete voice session.');
    run.openingInstruction = reply.openingInstruction;
    run.openaiSessionId = reply.session?.id;
    eventLog(run, 'The server created a separate browser voice session.');
    run.heartbeatTimer = setInterval(() => heartbeat(run), 5000);
    heartbeat(run);
    run.startupTimer = setTimeout(() => failRun(run, 'The voice session did not become ready within 30 seconds.'), 30000);
    run.statsTimer = setInterval(() => sampleStats(run), 1000);
    await run.peer.setRemoteDescription({ type: 'answer', sdp: reply.transport.sdp });
    // HTTP session creation already starts GPT-Live. Never send session.start.
  } catch (error) {
    if (run.finished) return;
    const message = error.name === 'NotAllowedError' ? 'Microphone access was not granted. Allow it in your browser, then start a new test.' : error.name === 'NotFoundError' ? 'No microphone was found. Connect one, then start a new test.' : error.name === 'NotReadableError' ? 'The microphone could not be opened. Check whether another app is using it.' : error.message || 'The voice test could not start.';
    failRun(run, message);
    if (error.status === 409) refreshAvailability();
  } finally {
    pendingCreations.delete(run);
    updateControls();
  }
}

$('test-brief').addEventListener('submit', startTest);
$('end-test').addEventListener('click', () => { if (activeRun) beginClose(activeRun); });
$('test-voice').addEventListener('change', updateVoiceLabel);

function updateVoiceLabel() {
  $('voice-name').textContent = $('test-voice').selectedOptions[0]?.textContent || 'Marin';
}

$('mute-test').addEventListener('click', () => {
  if (!activeRun?.started || activeRun.closing) return;
  activeRun.muted = !activeRun.muted;
  activeRun.stream.getAudioTracks().forEach((track) => { track.enabled = !activeRun.muted; });
  $('microphone-status').textContent = activeRun.muted ? 'Microphone muted' : 'Microphone on';
  updateControls();
});
$('play-assistant').addEventListener('click', async () => {
  try { await $('assistant-audio').play(); $('play-assistant').hidden = true; $('playback-hint').textContent = 'Assistant audio is playing through your selected output device.'; }
  catch { $('playback-hint').textContent = 'Playback could not start. Check your browser’s audio permissions and output device.'; }
});

$('download-log').addEventListener('click', () => {
  if (!lastRun) return;
  const { phoneNumber, ...brief } = lastRun.brief;
  const record = { type: 'relay-browser-voice-test', model: config.model, voice: lastRun.brief.voice || config.voice || 'marin', createdAt: lastRun.createdAt, endedAt: lastRun.endedAt, sessionId: lastRun.openaiSessionId, brief, transcript: lastRun.transcript, outcome: lastRun.outcome ?? null, events: lastRun.events, transportSamples: lastRun.stats, finalUsageConfirmed: lastRun.finalized, voiceUsage: lastRun.usage ?? null, backendUsage: lastRun.backendUsage };
  const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }));
  const link = node('a');
  link.href = url;
  link.download = `relay-voice-test-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

function clearRecording() {
  $('mic-playback').pause();
  $('mic-playback').removeAttribute('src');
  $('mic-playback').load();
  $('mic-playback').hidden = true;
  $('clear-recording').hidden = true;
  if (recordingUrl) URL.revokeObjectURL(recordingUrl);
  recordingUrl = null;
}

function stopOfflineCheck(discard = false) {
  const check = offlineCheck;
  if (!check) return;
  check.discard ||= discard;
  clearTimeout(check.timer);
  if (check.recorder?.state === 'recording') check.recorder.stop();
  check.stream?.getTracks().forEach((track) => track.stop());
  if (!check.recorder) {
    check.discard = true;
    offlineCheck = null;
    $('mic-check-status').textContent = 'Microphone check canceled.';
    updateControls();
  }
}

$('record-mic').addEventListener('click', async () => {
  if (activeRun || pendingCreations.size || offlineCheck) return;
  clearRecording();
  const check = { chunks: [], discard: false };
  offlineCheck = check;
  $('mic-check-status').textContent = 'Waiting for microphone permission. Nothing is sent over the network.';
  updateControls();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    if (offlineCheck !== check || check.discard || leaving) { stream.getTracks().forEach((track) => track.stop()); return; }
    check.stream = stream;
    check.recorder = new MediaRecorder(stream);
    check.recorder.addEventListener('dataavailable', ({ data }) => { if (data.size) check.chunks.push(data); });
    check.recorder.addEventListener('stop', () => {
      clearTimeout(check.timer);
      stream.getTracks().forEach((track) => track.stop());
      if (offlineCheck === check) offlineCheck = null;
      if (!check.discard && !leaving && check.chunks.length) {
        recordingUrl = URL.createObjectURL(new Blob(check.chunks, { type: check.recorder.mimeType }));
        $('mic-playback').src = recordingUrl;
        $('mic-playback').hidden = false;
        $('clear-recording').hidden = false;
        $('mic-check-status').textContent = 'Recording complete. Microphone off. Press play to listen locally.';
      } else if (!leaving) $('mic-check-status').textContent = 'Microphone off. No recording was kept.';
      check.chunks.length = 0;
      updateControls();
    });
    check.recorder.addEventListener('error', () => { stopOfflineCheck(true); $('mic-check-status').textContent = 'The microphone recording could not be completed.'; });
    check.recorder.start();
    $('mic-check-status').textContent = 'Recording locally… it will stop automatically after five seconds.';
    check.timer = setTimeout(() => stopOfflineCheck(), 5000);
  } catch {
    check.stream?.getTracks().forEach((track) => track.stop());
    if (offlineCheck === check) offlineCheck = null;
    $('mic-check-status').textContent = 'The microphone check could not start. Check the browser’s microphone permission.';
    updateControls();
  }
});
$('stop-recording').addEventListener('click', () => stopOfflineCheck());
$('clear-recording').addEventListener('click', () => { clearRecording(); $('mic-check-status').textContent = 'Recording cleared. Microphone off.'; });

window.addEventListener('pagehide', () => {
  leaving = true;
  clearTimeout(availabilityTimer);
  stopOfflineCheck(true);
  clearRecording();
  if (activeRun) {
    const run = activeRun;
    if (!run.closing) sendEvent(run, { type: 'session.close' });
    notifyStop(run, true);
    finishRun(run, 'Test ended', 'This page was closed.');
  }
});
window.addEventListener('pageshow', () => { leaving = false; scheduleAvailabilityCheck(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAvailability(); });

async function initialize() {
  try {
    config = await jsonRequest('/api/local-test/config');
    if (!config.brief || typeof config.brief.phoneNumber !== 'string') throw new Error('The local voice test did not receive a complete brief.');
    const mapping = { recipientName: 'test-recipient', callerName: 'test-caller', language: 'test-language', goal: 'test-goal', context: 'test-context', constraints: 'test-constraints', phoneNumber: 'test-phone', openingMessage: 'test-opening-message' };
    for (const [field, id] of Object.entries(mapping)) $(id).value = config.brief[field] || '';
    $('test-opening-options').open = Boolean(config.brief.openingMessage?.trim());
    const voice = config.brief.voice || config.voice || 'marin';
    $('test-voice').value = [...$('test-voice').options].some((option) => option.value === voice) ? voice : 'marin';
    const limit = config.brief.maxDurationSeconds === null ? 'none' : String(config.brief.maxDurationSeconds ?? 300);
    if (![...$('test-duration').options].some((option) => option.value === limit)) {
      const option = node('option', '', `${Number(limit) / 60} minutes`);
      option.value = limit;
      $('test-duration').append(option);
    }
    $('test-duration').value = limit;
    $('voice-model').textContent = config.model || 'gpt-live-1';
    updateVoiceLabel();
    stage('idle', config.ready ? 'Ready when you are' : 'OpenAI setup needed', config.ready ? 'Review the brief, then start. The assistant will open the conversation.' : 'Configure OpenAI in the Relay project before starting a voice test. The offline microphone check is still available.');
    renderAvailability();
    if (!supportsMicrophone() || !window.RTCPeerConnection) {
      showError('This browser does not expose the required microphone and WebRTC features. Open the local page in a browser that supports them.');
    }
    if (!window.MediaRecorder) $('mic-check-status').textContent = 'This browser does not support local audio recording.';
  } catch (error) {
    config = null;
    stage('error', 'Voice test unavailable', 'Check that the local Relay server is running, then reload this page.');
    showError(error.message);
  }
  updateControls();
  scheduleAvailabilityCheck();
}

initialize();
