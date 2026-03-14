import type { ListenerAdapter } from "../types.js";

export interface AsyncIterableAdapterOptions<T> {
  source: AsyncIterable<T>;
  map: (item: T) => { name: string; payload: unknown } | null | undefined;
}

export function createAsyncIterableAdapter<T>(
  opts: AsyncIterableAdapterOptions<T>,
): ListenerAdapter {
  return {
    start(ctx) {
      const { source, map } = opts;

      (async () => {
        try {
          for await (const item of source) {
            if (ctx.signal.aborted) break;
            const mapped = map(item);
            if (mapped != null) ctx.onEvent(mapped);
          }
        } catch {
          // Source errors terminate forwarding for this adapter instance.
          // We intentionally avoid rethrowing from this detached task.
        }
      })();
    },
  };
}

export interface ReadableStreamAdapterOptions<T> {
  source: ReadableStream<T>;
  map: (item: T) => { name: string; payload: unknown } | null | undefined;
}

export function createReadableStreamAdapter<T>(
  opts: ReadableStreamAdapterOptions<T>,
): ListenerAdapter {
  return {
    start(ctx) {
      const { source, map } = opts;
      const reader = source.getReader();

      (async () => {
        try {
          while (true) {
            if (ctx.signal.aborted) break;
            const { done, value } = await reader.read();
            if (done) break;
            const mapped = map(value);
            if (mapped != null) ctx.onEvent(mapped);
          }
        } catch {
          // Source errors terminate forwarding for this adapter instance.
          // We intentionally avoid rethrowing from this detached task.
        } finally {
          reader.releaseLock();
        }
      })();

      return () => {
        reader.cancel().catch(() => {});
      };
    },
  };
}
