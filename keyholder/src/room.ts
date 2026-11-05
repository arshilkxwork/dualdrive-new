import type { RoomPort } from './gate.ts';
import type { SwitchClient } from './switch.ts';

export const LEDGER_NAME = 'dualdrive-ledger';

interface RoomDocument {
  id: string;
  name?: string;
}

// Posts to the room and keeps the ledger: a room-scoped document only this
// agent can edit, since Switch lets an agent change only documents it made.
export class Room implements RoomPort {
  private ledgerId: string | null = null;
  private ledger = '';
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly client: SwitchClient,
    private readonly roomId: string,
  ) {}

  async post(body: string): Promise<void> {
    await this.client.op('post_message', { body });
  }

  // Claims the room for this connection and returns its documents.
  async connect(): Promise<RoomDocument[]> {
    const context = await this.client.op<{ documents?: RoomDocument[] }>('connect_to_room', {
      room_id: this.roomId,
      include_general_instructions: false,
    });
    return context.documents ?? [];
  }

  // Finds the ledger from an earlier run before creating one: document names
  // are unique within a room, so a second create would fail.
  async openLedger(documents: RoomDocument[]): Promise<void> {
    let existing = documents.find((doc) => doc.name === LEDGER_NAME);
    if (!existing) {
      try {
        const created = await this.client.op<{ document_id: string }>('create_room_document', {
          name: LEDGER_NAME,
          description: 'Every approval, refusal and merge DualDrive recorded in this room.',
          instructions: 'Written by @keyholder only. Read it to see what was approved, by whom, at which commit.',
          content: '# DualDrive ledger\n\n',
        });
        this.ledgerId = created.document_id;
        this.ledger = '# DualDrive ledger\n\n';
        return;
      } catch (error) {
        // Most likely created in the moment since the listing. Look again.
        existing = (await this.connect()).find((doc) => doc.name === LEDGER_NAME);
        if (!existing) {
          console.warn(`[keyholder] ledger disabled: ${(error as Error).message}`);
          return;
        }
      }
    }
    this.ledgerId = existing.id;
    const [loaded] = await this.client.op<Array<{ content?: string }>>('load_internal_documents', { ids: [existing.id] });
    this.ledger = loaded?.content ?? '';
  }

  record(line: string): Promise<void> {
    this.writes = this.writes.then(() => this.append(line));
    return this.writes;
  }

  private async append(line: string): Promise<void> {
    if (!this.ledgerId) {
      return;
    }
    const next = `${this.ledger}- ${new Date().toISOString()} ${line}\n`;
    try {
      await this.client.op('update_room_document', { document_id: this.ledgerId, content: next });
      this.ledger = next;
    } catch (error) {
      console.warn(`[keyholder] couldn't write the ledger: ${(error as Error).message}`);
    }
  }
}
