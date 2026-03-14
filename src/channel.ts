import type { WireFrame, ChannelOptions, ChannelState, Channel as ChannelHandle } from "./types.js";
import { Registry } from "./registry.js";

const encoder = new TextEncoder();
const STREAM_HEADERS = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "no-cache",
  "X-Accel-Buffering": "no",
};

function encodeFrame(frame: WireFrame | { type: string; message?: string }): Uint8Array {
  return encoder.encode(JSON.stringify(frame) + "\n");
}

export class ChannelImpl implements ChannelHandle {
  readonly id: string;
  private _state: ChannelState = "idle";
  private readonly eventPatterns: readonly string[] | null;
  private readonly bufferSize: number;
  private readonly reconnectWindowMs: number;
  private readonly registry: Registry;
  private readonly destroyHook: () => void;

  private buffer: WireFrame[] = [];
  private cursorCounter = 0;

  private consumers = new Set<ReadableStreamDefaultController<Uint8Array>>();

  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(id: string, registry: Registry, destroyHook: () => void, options?: ChannelOptions) {
    this.id = id;
    this.registry = registry;
    this.destroyHook = destroyHook;
    this.eventPatterns = options?.events ?? null;
    this.bufferSize = options?.bufferSize ?? 200;
    this.reconnectWindowMs = options?.reconnectWindowMs ?? 30_000;
  }

  get state(): ChannelState {
    return this._state;
  }

  get isDestroyed(): boolean {
    return this._state === "destroyed";
  }

  stream(cursor?: string): Response {
    return new Response(this.createBodyStream(cursor), {
      headers: STREAM_HEADERS,
    });
  }

  private createBodyStream(cursor?: string): ReadableStream<Uint8Array> {
    if (this.isDestroyed) {
      const id = this.id;
      return new ReadableStream({
        start(controller) {
          controller.enqueue(
            encodeFrame({ type: "__error", message: `Channel "${id}" is destroyed` }),
          );
          controller.close();
        },
      });
    }

    this.cancelDrain();

    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start: (ctrl) => {
        controller = ctrl;
        this.consumers.add(controller);
        this.transition("active");

        const sinceSeq = parseInMemoryCursor(cursor);
        if (sinceSeq !== null) {
          for (const frame of this.buffer) {
            const frameSeq = parseInMemoryCursor(frame.cursor);
            if (frameSeq !== null && frameSeq > sinceSeq) {
              controller.enqueue(encodeFrame(frame));
            }
          }
        }
      },
      cancel: () => {
        this.consumers.delete(controller);
        if (this.consumers.size === 0 && !this.isDestroyed) {
          this.startDrain();
        }
      },
    });

    return stream;
  }

  destroy(): void {
    if (this.isDestroyed) return;
    this.cancelDrain();
    for (const ctrl of this.consumers) {
      try {
        ctrl.close();
      } catch {
        // already closed
      }
    }
    this.consumers.clear();
    this.buffer = [];
    this._state = "destroyed";
    this.destroyHook();
  }

  accepts(eventName: string): boolean {
    if (this.isDestroyed) return false;
    if (!this.eventPatterns) return true;
    return this.registry.matchesAny(eventName, this.eventPatterns);
  }

  push(name: string, key: string, payload: Record<string, unknown>, ts: number): void {
    if (this.isDestroyed) return;

    this.cursorCounter++;
    const frame: WireFrame = {
      key,
      name,
      cursor: String(this.cursorCounter),
      ts,
      payload,
    };

    this.buffer.push(frame);
    if (this.buffer.length > this.bufferSize) {
      this.buffer.shift();
    }

    const encoded = encodeFrame(frame);
    for (const ctrl of this.consumers) {
      try {
        ctrl.enqueue(encoded);
      } catch {
        // consumer may have been closed
      }
    }
  }

  sendHeartbeat(): void {
    if (this.isDestroyed) return;
    const encoded = encodeFrame({ type: "__heartbeat" });
    for (const ctrl of this.consumers) {
      try {
        ctrl.enqueue(encoded);
      } catch {
        // ignore
      }
    }
  }

  sendError(message: string): void {
    if (this.isDestroyed) return;
    const encoded = encodeFrame({ type: "__error", message });
    for (const ctrl of this.consumers) {
      try {
        ctrl.enqueue(encoded);
      } catch {
        // ignore
      }
    }
  }

  private transition(target: ChannelState): void {
    if (this._state === "destroyed") return;
    this._state = target;
  }

  private startDrain(): void {
    this.transition("draining");
    this.drainTimer = setTimeout(() => {
      if (this.consumers.size === 0) {
        this.destroy();
      }
    }, this.reconnectWindowMs);
  }

  private cancelDrain(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
  }
}

function parseInMemoryCursor(cursor?: string): number | null {
  if (cursor === undefined) return null;
  const parsed = Number(cursor);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return null;
  return parsed;
}
