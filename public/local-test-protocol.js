// Pure helpers for the browser test. No phone API, storage, or network access.
export function validateLocalOutcome(value) {
  const statuses = ['achieved', 'partial', 'not-achieved', 'needs-user'];
  const validList = (items) => Array.isArray(items) && items.length <= 20 && items.every((item) => typeof item === 'string' && item.length <= 1000);
  if (!value || typeof value !== 'object' || Array.isArray(value) || !statuses.includes(value.status)
    || typeof value.summary !== 'string' || !value.summary.length || value.summary.length > 3000
    || !validList(value.confirmedDetails) || !validList(value.nextSteps)) return null;
  return { status: value.status, summary: value.summary, confirmedDetails: [...value.confirmedDetails], nextSteps: [...value.nextSteps] };
}

export function createLocalToolHandler({ send, onOutcome, onEnd, onError }) {
  const responses = new Map();
  const currentResponse = new Map();
  const calls = new Map();
  let endRequested = false;

  function execute(item) {
    let args;
    try {
      if (typeof item.arguments !== 'string' || item.arguments.length > 24000) throw new Error();
      args = JSON.parse(item.arguments);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error();
    } catch { return { output: { error: 'Invalid function arguments.' } }; }
    if (item.name === 'report_call_outcome') {
      const outcome = validateLocalOutcome(args);
      if (!outcome) return { output: { error: 'Invalid outcome. Supply status, summary, confirmedDetails, and nextSteps.' } };
      onOutcome(outcome);
      return { output: { saved: true, attribution: 'model-reported; saved only in this browser test' } };
    }
    if (item.name === 'end_call') {
      if (Object.keys(args).length) return { output: { error: 'end_call accepts an empty object.' } };
      return { end: true, output: { accepted: true, message: 'The voice test will end after this result. Do not speak again.' } };
    }
    return { output: { error: 'Unknown function.' } };
  }

  return function handle(envelope) {
    const event = envelope?.event;
    if (!event || typeof event.type !== 'string') return;
    if (event.type === 'response.failed' || event.type === 'response.incomplete') {
      onError('The reasoning backend did not complete its work.');
      return;
    }
    if (!['response.created', 'response.output_item.done', 'response.completed'].includes(event.type)) return;
    const delegation = envelope.delegation_id ?? 'session';
    if (event.type === 'response.created' && event.response?.id) currentResponse.set(delegation, event.response.id);
    const responseId = event.response?.id ?? event.response_id ?? currentResponse.get(delegation);
    if (!responseId) { onError('A backend event arrived without a response identifier.'); return; }
    const key = `${delegation}:${responseId}`;
    if (!responses.has(key)) responses.set(key, { calls: new Map(), completed: false, continued: false });
    const record = responses.get(key);
    if (event.type === 'response.output_item.done' && event.item?.type === 'function_call' && event.item.status === 'completed') {
      const item = event.item;
      if (typeof item.call_id !== 'string' || !item.call_id) { onError('A backend function call was missing its identifier.'); return; }
      if (!calls.has(item.call_id)) calls.set(item.call_id, { ...execute(item), submitted: false });
      record.calls.set(item.call_id, calls.get(item.call_id));
    }
    if (event.type === 'response.completed') record.completed = true;
    if (!record.completed || !record.calls.size || record.continued) return;
    let shouldEnd = false;
    let submittedAny = false;
    for (const [callId, work] of record.calls) {
      if (work.submitted) continue;
      if (!send({ type: 'response.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(work.output) } })) {
        onError('The backend function result could not be delivered.'); return;
      }
      work.submitted = true;
      submittedAny = true;
      shouldEnd ||= work.end;
    }
    record.continued = true;
    if (submittedAny && !send({ type: 'response.create' })) { onError('The backend response could not be continued.'); return; }
    if (shouldEnd && !endRequested) { endRequested = true; onEnd(); }
  };
}

export function readTransportStats(report, previous = null) {
  const rows = [];
  report.forEach((row) => rows.push(row));
  const inbound = rows.find((row) => row.type === 'inbound-rtp' && (row.kind === 'audio' || row.mediaType === 'audio'));
  const transport = inbound?.transportId ? report.get(inbound.transportId) : null;
  const pair = transport?.selectedCandidatePairId ? report.get(transport.selectedCandidatePairId) : null;
  const rttMs = Number.isFinite(pair?.currentRoundTripTime) && pair.currentRoundTripTime >= 0 ? pair.currentRoundTripTime * 1000 : null;
  const jitterMs = Number.isFinite(inbound?.jitter) && inbound.jitter >= 0 ? inbound.jitter * 1000 : null;
  let lossPercent = null;
  if (inbound && previous?.id === inbound.id && Number.isFinite(inbound.packetsLost) && Number.isFinite(inbound.packetsReceived)) {
    const lost = inbound.packetsLost - previous.packetsLost;
    const received = inbound.packetsReceived - previous.packetsReceived;
    if (Number.isFinite(lost) && Number.isFinite(received) && lost >= 0 && received >= 0 && lost + received > 0) lossPercent = lost / (lost + received) * 100;
  }
  return { rttMs, jitterMs, lossPercent, previous: inbound ? { id: inbound.id, packetsLost: inbound.packetsLost, packetsReceived: inbound.packetsReceived } : null };
}
