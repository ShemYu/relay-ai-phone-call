import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { E164 } from './config.js';
import { AppError } from './calls.js';

const ENV_KEYS = {
  accountSid: 'TWILIO_ACCOUNT_SID',
  authToken: 'TWILIO_AUTH_TOKEN',
  fromNumber: 'TWILIO_PHONE_NUMBER',
  publicBaseUrl: 'PUBLIC_BASE_URL',
};

export function publicSettings(config) {
  return {
    accountSid: config.accountSid || '',
    fromNumber: config.fromNumber || '',
    publicBaseUrl: config.publicBaseUrl || '',
    authTokenConfigured: Boolean(config.authToken),
  };
}

export function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !Object.hasOwn(ENV_KEYS, key))) {
    throw new AppError(400, 'Send only the supported Twilio settings fields.');
  }
  const patch = {};
  for (const [key, raw] of Object.entries(input)) {
    if (typeof raw !== 'string') throw new AppError(400, 'Settings values must be text.');
    const value = raw.trim();
    if (key === 'authToken' && !value) continue; // A blank password field preserves the secret.
    if (key === 'accountSid' && value && !/^AC[a-f\d]{32}$/i.test(value)) {
      throw new AppError(400, 'Enter a valid Twilio Account SID.');
    }
    if (key === 'authToken' && !/^[a-f\d]{32}$/i.test(value)) {
      throw new AppError(400, 'Enter a valid Twilio Auth Token.');
    }
    if (key === 'fromNumber' && value && !E164.test(value)) {
      throw new AppError(400, 'Enter the Twilio caller number in international format.');
    }
    if (key === 'publicBaseUrl' && value) {
      let url;
      try { url = new URL(value); } catch { /* The fixed error below never reflects input. */ }
      if (!/^https:\/\/[^/?#\\\s]+\/?$/i.test(value) || !url || url.protocol !== 'https:'
          || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new AppError(400, 'Enter an HTTPS callback origin without a path, query, or credentials.');
      }
      patch[key] = url.origin;
    } else patch[key] = value;
  }
  return patch;
}

function checkedFile(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe settings file.');
    return stat;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function replaceAssignments(source, updates) {
  // Match dotenv's quoted/multiline assignment grammar, leaving all unrelated
  // assignments and comments byte-for-byte intact. Values written here are
  // validated numbers, hex identifiers, or an HTTPS origin, so need no quoting.
  const assignment = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg;
  const seen = new Set();
  let result = source.replace(assignment, (match, key) => {
    if (!Object.hasOwn(updates, key)) return match;
    seen.add(key);
    const leading = match.match(/^\s*/)[0];
    const trailing = match.match(/\s*$/)[0];
    return `${leading}${key}=${updates[key]}${trailing}`;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (seen.has(key)) continue;
    if (result && !result.endsWith('\n')) result += '\n';
    result += `${key}=${value}\n`;
  }
  return result;
}

export function persistSettings(settingsPath, patch) {
  if (!Object.keys(patch).length) return;
  const file = path.resolve(settingsPath);
  const directory = path.dirname(file);
  let temp;
  let descriptor;
  try {
    // The path is server-owned, never supplied by a browser. Reject symlinks in
    // the file and its parent path, and never follow a swapped file on open.
    if (fs.realpathSync(directory) !== directory) throw new Error('Unsafe settings directory.');
    const original = checkedFile(file);
    let source = '';
    if (original) {
      descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || opened.ino !== original.ino || opened.dev !== original.dev) throw new Error('Settings changed.');
      source = fs.readFileSync(descriptor, 'utf8');
      fs.closeSync(descriptor);
      descriptor = undefined;
    }
    const updates = Object.fromEntries(Object.entries(patch).map(([key, value]) => [ENV_KEYS[key], value]));
    const content = replaceAssignments(source, updates);
    temp = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
    descriptor = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    const current = checkedFile(file);
    if (Boolean(current) !== Boolean(original)
        || (current && (current.ino !== original.ino || current.dev !== original.dev
          || current.mtimeMs !== original.mtimeMs || current.size !== original.size))) throw new Error('Settings changed.');
    fs.renameSync(temp, file);
    temp = undefined;
  } catch {
    throw new AppError(500, 'The local settings file could not be saved. Check its location and permissions.');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (temp) { try { fs.unlinkSync(temp); } catch { /* No secret paths or content are logged. */ } }
  }
}
