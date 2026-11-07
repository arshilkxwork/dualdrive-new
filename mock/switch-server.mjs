// A stand-in for Switch's agent bridge and for GitHub, so the sandbox
// (docker compose up) runs DualDrive's real @keyholder with no accounts,
// tokens or network. Only what keyholder calls is here, in the shapes it
// reads. Nothing in it is a security boundary; it plays the parts that real
// Switch and GitHub play, so keyholder's own checks can be seen working.
//
//   node mock/switch-server.mjs        listens on PORT (default 8080)
//
// Switch, under /agents/<id>/:
//   GET  events             the event stream (server-sent events)
//   POST connection/beat    heartbeats
//   POST ops/<name>         read_context, post_message, connect_to_room and
//                           the ledger document ops
//
// GitHub, under /github/ (keyholder's GITHUB_API_URL): one open pull request,
// <repo>#1, whose only change is src/auth.js, and a green "test" check.
//
// The sandbox's own controls, under /sandbox/:
//   POST say          {sender_name, body}: someone posts in the room
//   GET  transcript   every message in the room, in order
//   GET  status       whether keyholder is connected, and the pull request
//
// The addressing policy. Real Switch lets a participant address @keyholder
// only if keyholder's policy names them, and answers anyone else itself
// (README, "Why Switch is load-bearing"). This mock does the same for the
// names in ADDRESSING_ALLOW: a mention from anyone else reaches keyholder
// as unaddressed, and the mock posts the refusal.

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8080);
const AGENT_ID = process.env.KEYHOLDER_AGENT_ID ?? 'keyholder-sandbox';
const API_KEY = process.env.KEYHOLDER_API_KEY ?? 'sandbox-key';
const ROOM_ID = process.env.DUALDRIVE_ROOM_ID ?? 'sandbox-room';
const HANDLE = process.env.KEYHOLDER_HANDLE ?? 'keyholder';
const REPO = process.env.GITHUB_REPOSITORY ?? 'sandbox/demo-service';
const ALLOW = (process.env.ADDRESSING_ALLOW ?? 'alice,bob').split(',').map((name) => name.trim().toLowerCase());

export const HEAD_SHA = '3f1c2a9d8e7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d';

const transcript = [];
const streams = new Set();
const documents = new Map();
let sequence = 0;
let connected = false;
const pull = {
  number: 1,
  state: 'open',
  merged: false,
  head: { sha: HEAD_SHA },
  base: { ref: 'main' },
  title: 'Hash passwords with scrypt and compare in constant time',
  html_url: `https://github.example/${REPO}/pull/1`,
  merge_commit_sha: null,
};

function participant(name) {
  return `@switch-${name.toLowerCase()}:sandbox`;
}

// Records a message and sends it down every open stream.
function publish(senderName, body, addressed) {
  const message = {
    id: `msg-${randomUUID()}`,
    kind: 'message',
    sender: participant(senderName),
    sender_name: senderName,
    body,
    timestamp: Date.now(),
  };
  transcript.push({ ...message, addressed });
  sequence += 1;
  const frame =
    `id: ${sequence}\nevent: message\n` +
    `data: ${JSON.stringify({
      type: 'message',
      room_id: ROOM_ID,
      sequence,
      payload: { message_id: message.id, sender: message.sender, sender_name: senderName, body, addressed },
    })}\n\n`;
  for (const stream of streams) {
    stream.write(frame);
  }
  return message;
}

function say(senderName, body) {
  const mentions = new RegExp(`(^|\\s)@${HANDLE}(?![\\w-])`, 'i').test(body);
  const allowed = ALLOW.includes(senderName.toLowerCase());
  publish(senderName, body, mentions && allowed);
  if (mentions && !allowed) {
    publish(
      'switch',
      `[addressing policy] ${senderName} may not address ${HANDLE}; only ${ALLOW.join(', ')} may. The mention was not delivered.`,
      false,
    );
  }
}

async function readJson(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 1_000_000) {
      throw new Error('request body too large');
    }
  }
  return text ? JSON.parse(text) : {};
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const ops = {
  read_context: () => ({ threads: transcript.map((entry) => ({ root: entry, replies: [] })) }),
  connect_to_room: (args) => {
    if (args.room_id !== ROOM_ID) {
      throw Object.assign(new Error(`no room ${args.room_id}`), { status: 404 });
    }
    connected = true;
    return { documents: [...documents.values()].map(({ id, name }) => ({ id, name })) };
  },
  post_message: (args) => ({ message_id: publish(HANDLE, String(args.body ?? ''), false).id }),
  create_room_document: (args) => {
    const id = `doc-${randomUUID()}`;
    documents.set(id, { id, name: args.name, content: String(args.content ?? '') });
    return { document_id: id };
  },
  load_internal_documents: (args) => (args.ids ?? []).map((id) => ({ id, content: documents.get(id)?.content ?? '' })),
  update_room_document: (args) => {
    const doc = documents.get(args.document_id);
    if (!doc) {
      throw Object.assign(new Error('no such document'), { status: 404 });
    }
    doc.content = String(args.content ?? '');
    return {};
  },
};

async function handleSwitch(req, res, rest) {
  if (req.headers.authorization !== `Bearer ${API_KEY}`) {
    return send(res, 401, { error: 'bad API key' });
  }
  const url = new URL(req.url, 'http://mock');
  if (req.method === 'GET' && rest === 'events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: connection_state\ndata: ${JSON.stringify({ generation: 1, heartbeat_interval_seconds: 5, rooms: [url.searchParams.get('rooms')] })}\n\n`);
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 15_000);
    streams.add(res);
    req.on('close', () => {
      clearInterval(keepalive);
      streams.delete(res);
    });
    return undefined;
  }
  if (req.method === 'POST' && rest === 'connection/beat') {
    await readJson(req);
    return send(res, 200, { ok: true });
  }
  const op = rest.match(/^ops\/([a-z_]+)$/)?.[1];
  if (req.method === 'POST' && op && ops[op]) {
    try {
      return send(res, 200, { result: ops[op](await readJson(req)) });
    } catch (error) {
      return send(res, error.status ?? 400, { error: error.message });
    }
  }
  return send(res, 404, { error: `no Switch route ${req.method} ${rest}` });
}

async function handleGitHub(req, res, rest) {
  const [owner, repo] = REPO.split('/');
  const prefix = `repos/${owner}/${repo}/`;
  if (!rest.toLowerCase().startsWith(prefix.toLowerCase())) {
    return send(res, 404, { message: 'Not Found' });
  }
  const path = rest.slice(prefix.length);
  if (req.method === 'GET' && path === 'pulls/1') {
    return send(res, 200, pull);
  }
  if (req.method === 'GET' && path === 'pulls/1/files') {
    return send(res, 200, [{ filename: 'src/auth.js', status: 'modified' }]);
  }
  if (req.method === 'GET' && path === `commits/${HEAD_SHA}/check-runs`) {
    return send(res, 200, { total_count: 1, check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] });
  }
  if (req.method === 'GET' && path === `commits/${HEAD_SHA}/status`) {
    return send(res, 200, { state: 'success', sha: HEAD_SHA, total_count: 0, statuses: [] });
  }
  if (req.method === 'PUT' && path === 'pulls/1/merge') {
    const body = await readJson(req);
    if (pull.merged) {
      return send(res, 405, { message: 'Pull Request is not mergeable' });
    }
    if (body.sha !== pull.head.sha) {
      return send(res, 409, { message: 'Head branch was modified. Review and try the merge again.' });
    }
    pull.merged = true;
    pull.state = 'closed';
    pull.merge_commit_sha = `9e${HEAD_SHA.slice(2, 38)}0001`;
    return send(res, 200, { sha: pull.merge_commit_sha, merged: true, message: 'Pull Request successfully merged' });
  }
  return send(res, 404, { message: 'Not Found' });
}

async function handleSandbox(req, res, rest) {
  if (req.method === 'POST' && rest === 'say') {
    const { sender_name: senderName, body } = await readJson(req);
    if (typeof senderName !== 'string' || typeof body !== 'string' || senderName === '') {
      return send(res, 400, { error: 'say takes {sender_name, body}' });
    }
    say(senderName, body);
    return send(res, 200, { ok: true });
  }
  if (req.method === 'GET' && rest === 'transcript') {
    return send(res, 200, transcript);
  }
  if (req.method === 'GET' && rest === 'status') {
    return send(res, 200, { connected, streams: streams.size, pull: { merged: pull.merged, merge_commit_sha: pull.merge_commit_sha } });
  }
  return send(res, 404, { error: 'no such sandbox route' });
}

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://mock').pathname.replace(/^\/+/, '');
  const agentPrefix = `agents/${encodeURIComponent(AGENT_ID)}/`;
  let handled;
  if (path === 'health') {
    handled = send(res, 200, { ok: true });
  } else if (path.startsWith(agentPrefix)) {
    handled = handleSwitch(req, res, path.slice(agentPrefix.length));
  } else if (path.startsWith('github/')) {
    handled = handleGitHub(req, res, path.slice('github/'.length));
  } else if (path.startsWith('sandbox/')) {
    handled = handleSandbox(req, res, path.slice('sandbox/'.length));
  } else {
    handled = send(res, 404, { error: 'not found' });
  }
  Promise.resolve(handled).catch((error) => {
    if (!res.headersSent) {
      send(res, 400, { error: error.message });
    }
  });
});

server.listen(PORT, () => {
  console.log(`[mock] Switch bridge and GitHub on :${PORT}; room ${ROOM_ID}, ${REPO}#1 at ${HEAD_SHA.slice(0, 7)}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => process.exit(0));
}
