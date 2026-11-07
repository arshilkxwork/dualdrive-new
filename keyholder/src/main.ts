import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { Backoff, describeNetworkError } from './backoff.ts';
import { loadConfig } from './config.ts';
import { Gate, type GateState } from './gate.ts';
import { createGitHub } from './github.ts';
import { readMessage, type MessagePayload } from './inbox.ts';
import { RepoRouter, repoKey, unknownRepoReply } from './repos.ts';
import { Room } from './room.ts';
import { restoreRepoState } from './state.ts';
import { SwitchClient, type Frame } from './switch.ts';

interface Persisted {
  connectionId?: string;
  // GITHUB_REPOSITORY's approvals and verdicts, approvals where they have
  // always been.
  approvals?: GateState['approvals'];
  verdicts?: GateState['verdicts'];
  // EXTRA_REPOSITORIES' state, by lowercase "owner/repo". restoreRepoState
  // reads both shapes it has had.
  repos?: Record<string, unknown>;
}

interface ContextEntry {
  id: string;
  kind: string;
  sender: string;
  sender_name: string;
  body: string;
  timestamp: number;
}

const config = loadConfig();

function readPersisted(): Persisted {
  if (!existsSync(config.stateFile)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(config.stateFile, 'utf8')) as Persisted;
  } catch {
    console.warn(`[keyholder] couldn't parse state file at ${config.stateFile}; starting clean`);
    return {};
  }
}

const persisted = readPersisted();
// One connection id for the life of this install: reopening with the same id
// is how a dropped stream resumes instead of starting a new connection.
const connectionId = persisted.connectionId ?? randomUUID();
const state: GateState = { approvals: persisted.approvals ?? {}, verdicts: persisted.verdicts ?? {} };
const extraStates = new Map<string, GateState>();
const save = () => {
  const repos = Object.fromEntries([...extraStates].map(([key, extra]) => [key, { approvals: extra.approvals, verdicts: extra.verdicts }]));
  const tmp = `${config.stateFile}.${process.pid}.tmp`;
  const body = { connectionId, approvals: state.approvals, verdicts: state.verdicts, repos };
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
  renameSync(tmp, config.stateFile);
};

const client = new SwitchClient(config.bridgeUrl, config.agentId, config.apiKey, connectionId);
const room = new Room(client, config.roomId);
const gates = new RepoRouter(config.repositories, (target, isDefault) => {
  let gateState = state;
  if (!isDefault) {
    const key = repoKey(target.name);
    gateState = restoreRepoState(persisted.repos?.[key]);
    extraStates.set(key, gateState);
  }
  const own = config.repoSettings.get(repoKey(target.name));
  const github = createGitHub(config.githubToken, target.owner, target.repo, config.githubApiUrl, own?.mergeMethod ?? config.mergeMethod);
  return new Gate(github, room, gateState, {
    sensitivePaths: own?.sensitivePaths ?? config.sensitivePaths,
    baseBranch: own?.baseBranch ?? config.baseBranch,
    requiredChecks: own?.requiredChecks ?? config.requiredChecks,
    ciPollMs: 3000,
    ciTimeoutMs: config.ciTimeoutMs,
    requireCi: own?.requireCi ?? config.requireCi,
    onStateChange: save,
    repoLabel: isDefault ? undefined : target.name,
  });
});
save();

const seen = new Set<string>();
function firstTime(id: string | undefined): boolean {
  if (!id) {
    return true;
  }
  if (seen.has(id)) {
    return false;
  }
  seen.add(id);
  if (seen.size > 5000) {
    seen.delete(seen.values().next().value as string);
  }
  return true;
}

function handleMessage(payload: MessagePayload, live: boolean): void {
  if (!firstTime(payload.message_id)) {
    return;
  }
  const from = `${payload.sender_name ?? ''} (${payload.sender ?? ''})`;
  for (const action of readMessage(payload, live, config)) {
    switch (action.kind) {
      case 'verdict': {
        const parsed = action.verdict;
        const pr = parsed.kind === 'valid' ? parsed.verdict.pr : parsed.pr;
        const repo = parsed.kind === 'valid' ? parsed.verdict.repo : parsed.repo;
        const gate = gates.route(repo);
        if (!gate) {
          // Nothing to record it against. The auditor isn't answered: its
          // verdicts are read, never replied to.
          console.warn(`[keyholder] ignored a verdict for ${repo}#${pr} from ${from}: not a governed repo`);
          break;
        }
        gate.recordVerdict(parsed);
        console.log(`[keyholder] ${parsed.kind} verdict for ${repo ?? ''}#${pr} from ${from}`);
        break;
      }
      case 'approve':
      case 'revoke': {
        const gate = gates.route(action.repo);
        if (!gate) {
          void room.post(unknownRepoReply(action.repo ?? '', gates.names())).catch(logError);
          break;
        }
        console.log(`[keyholder] ${action.kind} for ${action.repo ?? ''}#${action.pr} from ${from}`);
        const done = action.kind === 'approve' ? gate.handleApproval(action.pr, action.reviewer) : gate.handleRevoke(action.pr, action.reviewer);
        void done.catch(logError);
        break;
      }
      case 'reply':
        console.log(`[keyholder] replying to ${from}`);
        void room.post(action.body).catch(logError);
        break;
    }
  }
}

// Picks up anything posted before this connection opened, such as a verdict
// from before keyholder started. The stream can't do this: its cursor only
// moves forward, and read_context is what reads history.
async function catchUp(): Promise<void> {
  const context = await client.op<{ threads: Array<{ root: ContextEntry; replies: ContextEntry[] }> }>('read_context', {
    limit: 200,
  });
  const entries = context.threads
    .flatMap((thread) => [thread.root, ...thread.replies])
    .filter((entry) => entry.kind === 'message')
    .sort((a, b) => a.timestamp - b.timestamp);
  for (const entry of entries) {
    handleMessage({ message_id: entry.id, sender: entry.sender, sender_name: entry.sender_name, body: entry.body }, false);
  }
}

function logError(error: unknown): void {
  console.error(`[keyholder] ${describeNetworkError(error)}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(): Promise<never> {
  let lastEventId: string | null = null;
  let ledgerOpen = false;
  const backoff = new Backoff();
  for (;;) {
    const controller = new AbortController();
    let beat: NodeJS.Timeout | undefined;
    try {
      for await (const frame of client.stream(config.roomId, lastEventId, controller.signal)) {
        if (frame.id) {
          lastEventId = frame.id;
        }
        await handleFrame(frame);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        logError(error);
      }
    } finally {
      clearInterval(beat);
      controller.abort();
    }
    const wait = backoff.next();
    console.log(`[keyholder] stream closed, reopening in ${wait / 1000}s`);
    await sleep(wait);

    async function handleFrame(frame: Frame): Promise<void> {
      switch (frame.event) {
        case 'connection_state': {
          const generation = typeof frame.data.generation === 'number' ? frame.data.generation : null;
          const seconds = typeof frame.data.heartbeat_interval_seconds === 'number' ? frame.data.heartbeat_interval_seconds : 2;
          clearInterval(beat);
          beat = setInterval(() => {
            client
              .beat(generation)
              .then((status) => {
                if (status === 404 || status === 409) {
                  controller.abort();
                }
              })
              .catch(logError);
          }, seconds * 1000);
          const documents = await room.connect();
          if (!ledgerOpen) {
            await room.openLedger(documents);
            ledgerOpen = true;
          }
          await catchUp();
          // Only now is the connection known to work. A stream that opens
          // and fails straight away keeps backing off.
          backoff.reset();
          console.log(`[keyholder] watching room ${config.roomId} as @${config.handle}`);
          break;
        }
        case 'message':
          if (frame.data.room_id === config.roomId) {
            handleMessage(frame.data.payload as MessagePayload, true);
          }
          break;
        case 'gap':
          console.warn(`[keyholder] gap in the stream (${String(frame.data.reason)}), re-reading the room`);
          await catchUp();
          break;
        case 'evicted':
          console.warn(`[keyholder] evicted: ${String(frame.data.reason)}. Is another keyholder running with the same state file?`);
          controller.abort();
          break;
      }
    }
  }
}

void run();
