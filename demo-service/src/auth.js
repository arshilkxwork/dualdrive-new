import { createHmac, randomBytes } from 'node:crypto';

const TOKEN_TTL_MS = 60 * 60 * 1000;

// A fresh signing key per process: tokens don't survive a restart, which is
// fine for a demo and keeps a hard-coded secret out of the repo.
const signingKey = randomBytes(32);

// Passwords are kept and compared in plain text. This is the weakness the
// demo asks the agents to fix.
const users = new Map();

export function addUser(username, password) {
  users.set(username, password);
}

export function login(username, password, now = Date.now()) {
  const stored = users.get(username);
  if (stored === undefined || stored !== password) {
    return null;
  }
  return issueToken(username, now);
}

export function verifyToken(token, now = Date.now()) {
  if (typeof token !== 'string') {
    return null;
  }
  const [payload, signature] = token.split('.');
  if (!payload || !signature || sign(payload) !== signature) {
    return null;
  }
  const { sub, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (typeof exp !== 'number' || now >= exp) {
    return null;
  }
  return sub;
}

function issueToken(username, now) {
  const payload = Buffer.from(JSON.stringify({ sub: username, exp: now + TOKEN_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function sign(payload) {
  return createHmac('sha256', signingKey).update(payload).digest('base64url');
}
