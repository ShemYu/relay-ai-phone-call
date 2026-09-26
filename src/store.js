import fs from 'node:fs';
import path from 'node:path';

export const TERMINAL = new Set(['completed', 'busy', 'no-answer', 'canceled', 'failed']);

export class Store {
  constructor(directory) {
    this.file = path.join(directory, 'calls.json');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { plans: [], calls: [] };
  }
  save() {
    const temp = this.file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
  call(id) { return this.state.calls.find(c => c.id === id); }
  plan(id) { return this.state.plans.find(p => p.id === id); }
  active() { return this.state.calls.find(c => !TERMINAL.has(c.status)); }
  update(call, changes) { Object.assign(call, changes); this.save(); return call; }
  event(call, message) { call.events.push({ message, at: new Date().toISOString() }); this.save(); }
  publicCall(call) {
    if (!call) return null;
    const { streamToken, providerCallSid, accountSid, lastSequence, ...safe } = call;
    return safe;
  }
}
