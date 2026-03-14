import type { ListenerAdapter } from "../types.js";

interface EventEmitterLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface EventEmitterAdapterOptions {
  emitter: EventEmitterLike;
  eventName: string;
  extract?: (...args: unknown[]) => { name: string; payload: unknown };
}

export function createEventEmitterAdapter(opts: EventEmitterAdapterOptions): ListenerAdapter {
  return {
    start(ctx) {
      const { emitter, eventName, extract } = opts;

      const removeListener = emitter.off?.bind(emitter) ?? emitter.removeListener?.bind(emitter);
      if (!removeListener) {
        throw new Error("Emitter must implement .off() or .removeListener() for cleanup");
      }

      const handler = (...args: unknown[]) => {
        if (extract) {
          let mapped: { name: string; payload: unknown };
          try {
            mapped = extract(...args);
          } catch {
            return;
          }
          ctx.onEvent(mapped);
        } else {
          const data = args[0] as { name: string; payload: unknown };
          ctx.onEvent(data);
        }
      };

      emitter.on(eventName, handler);

      ctx.signal.addEventListener(
        "abort",
        () => {
          removeListener(eventName, handler);
        },
        { once: true },
      );
    },
  };
}
