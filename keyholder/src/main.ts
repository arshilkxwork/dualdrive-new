import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from './config.ts';
import { Gate, type GateState } from './gate.ts';
import { createGitHub } from './github.ts';
import { readMessage, type MessagePayload } from './inbox.ts';
import { Room } from './room.ts';
import { SwitchClient, type Frame } from './switch.ts';

interface Persisted {
  connectionId?: string;
  approvals?: GateState['approvals'];
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
  return JSON.parse(readFileSync(config.stateFile, 'utf8')) as Persisted;
}

const persisted = readPersisted();
// One connection id for the life of this install: reopening with the same id
// is how a dropped stream resumes instead of starting a new connection.
const connectionId = persisted.connectionId ?? randomUUID();
const state: GateState = { approvals: persisted.approvals ?? {} };
const save = () => writeFileSync(config.stateFile, `${JSON.stringify({ connectionId, approvals: state.approvals }, null, 2)}\n`);
save();

const client = new SwitchClient(config.bridgeUrl, config.agentId, config.apiKey, connectionId);
const room = new Room(client, config.roomId);
const gate = new Gate(createGitHub(config.githubToken, config.owner, config.repo), room, state, {
  ciPollMs: 3000,
  ciTimeoutMs: 30000,
  onStateChange: save,
});

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
        gate.recordVerdict(action.verdict);
        const pr = action.verdict.kind === 'valid' ? action.verdict.verdict.pr : action.verdict.pr;
        console.log(`[keyholder] ${action.verdict.kind} verdict for #${pr} from ${from}`);
        break;
      }
      case 'approve':
        console.log(`[keyholder] approval for #${action.pr} from ${from}`);
        void gate.handleApproval(action.pr, action.reviewer).catch(logError);
        break;
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
  console.error(`[keyholder] ${error instanceof Error ? error.message : String(error)}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(): Promise<never> {
  let lastEventId: string | null = null;
  let ledgerOpen = false;
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
    console.log('[keyholder] stream closed, reopening');
    await sleep(2000);

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
