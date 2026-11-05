// A small client for Switch's agent protocol: the event stream (server-sent
// events down), the heartbeat, and operations (HTTP up). It follows
// docs/official/internals/agent-protocol.md in the Switch repo.

export interface Frame {
  event: string;
  id: string | null;
  data: Record<string, unknown>;
}

export class SwitchError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class SwitchClient {
  constructor(
    private readonly bridgeUrl: string,
    private readonly agentId: string,
    private readonly apiKey: string,
    readonly connectionId: string,
  ) {}

  private url(path: string): string {
    return `${this.bridgeUrl}/agents/${encodeURIComponent(this.agentId)}${path}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, ...extra };
  }

  // Operations take their arguments as the request body, unwrapped. The
  // connection id header binds the call to the room this connection claimed.
  async op<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(this.url(`/ops/${name}`), {
      method: 'POST',
      headers: this.headers({
        'Content-Type': 'application/json',
        'X-Switch-Connection-Id': this.connectionId,
      }),
      body: JSON.stringify(args),
    });
    if (!response.ok) {
      throw new SwitchError(`${name} failed with ${response.status}: ${await response.text()}`, response.status);
    }
    const payload = (await response.json()) as { result: T };
    return payload.result;
  }

  // 404 and 409 both mean the stream has to be reopened.
  async beat(generation: number | null): Promise<number> {
    const response = await fetch(this.url('/connection/beat'), {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ connection_id: this.connectionId, generation }),
    });
    return response.status;
  }

  async *stream(roomId: string, lastEventId: string | null, signal: AbortSignal): AsyncGenerator<Frame> {
    const query = new URLSearchParams({
      connection_id: this.connectionId,
      scope: 'single',
      // Every message in the room, not only ones that address @keyholder:
      // the auditor's verdicts never mention it.
      filter: 'all',
      start_from: 'head',
      rooms: roomId,
      client: 'dualdrive-keyholder',
    });
    const headers = this.headers({ Accept: 'text/event-stream' });
    if (lastEventId) {
      headers['Last-Event-ID'] = lastEventId;
    }
    const response = await fetch(this.url(`/events?${query}`), { headers, signal });
    if (!response.ok || !response.body) {
      throw new SwitchError(`opening the event stream failed with ${response.status}: ${await response.text()}`, response.status);
    }
    yield* parseSse(response.body);
  }
}

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<Frame> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, '\n');
    let end: number;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const frame = parseBlock(block);
      if (frame) {
        yield frame;
      }
    }
  }
}

function parseBlock(block: string): Frame | null {
  let event = 'message';
  let id: string | null = null;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    // Lines starting with ":" are comments; Switch sends one as a keepalive.
    if (line === '' || line.startsWith(':')) {
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') {
      event = value;
    } else if (field === 'id') {
      id = value;
    } else if (field === 'data') {
      data.push(value);
    }
  }
  if (data.length === 0) {
    return null;
  }
  return { event, id, data: JSON.parse(data.join('\n')) as Record<string, unknown> };
}
