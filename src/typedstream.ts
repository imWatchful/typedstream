import type { SchemaMap, ListenerAdapter, ChannelOptions, Channel, MaybePromise } from "./types.js";
import { Registry } from "./registry.js";
import { ChannelImpl } from "./channel.js";

export interface ListenOptions {
  signal?: AbortSignal;
  events?: readonly string[];
}

export interface TypedStream<TSchemas = {}> {
  register<TAdded extends SchemaMap>(schemas: TAdded): TypedStream<TSchemas & TAdded>;
  listen(adapter: ListenerAdapter, options?: ListenOptions): Promise<() => Promise<void>>;
  channel(id: string, options?: ChannelOptions): Channel;
}

export function createTypedStream(): TypedStream {
  const registry = new Registry();
  const channels = new Map<string, ChannelImpl>();
  const facades = new Map<string, Channel>();

  function register<TAdded extends SchemaMap>(schemas: TAdded): TypedStream<TAdded> {
    registry.register(schemas);
    return self as unknown as TypedStream<TAdded>;
  }

  async function listen(
    adapter: ListenerAdapter,
    options?: ListenOptions,
  ): Promise<() => Promise<void>> {
    const ac = new AbortController();
    const outerSignal = options?.signal;
    const forwardAbort = () => ac.abort();

    if (outerSignal) {
      if (outerSignal.aborted) {
        ac.abort();
      } else {
        outerSignal.addEventListener("abort", forwardAbort, { once: true });
      }
    }

    const adapterEvents: readonly string[] = options?.events ?? registry.patterns;

    const onEvent = (event: { name: string; payload: unknown }): void => {
      const resolved = registry.resolve(event.name);
      if (!resolved) return;

      let validated: Record<string, unknown>;
      try {
        validated = resolved.schema.parse(event.payload);
      } catch {
        return;
      }

      if (typeof validated !== "object" || validated === null || Array.isArray(validated)) {
        return;
      }

      const ts = Date.now();

      for (const ch of channels.values()) {
        if (ch.accepts(event.name)) {
          ch.push(event.name, resolved.key, validated, ts);
        }
      }
    };

    let teardown: void | (() => MaybePromise<void>);
    try {
      teardown = adapter.start({
        events: adapterEvents,
        signal: ac.signal,
        onEvent,
      });
    } catch (error) {
      if (outerSignal) {
        outerSignal.removeEventListener("abort", forwardAbort);
      }
      ac.abort();
      throw error;
    }

    return async () => {
      if (outerSignal) {
        outerSignal.removeEventListener("abort", forwardAbort);
      }
      ac.abort();
      if (typeof teardown === "function") {
        await (teardown as () => MaybePromise<void>)();
      }
    };
  }

  function channel(id: string, options?: ChannelOptions): Channel {
    const existingImpl = channels.get(id);
    if (existingImpl && !existingImpl.isDestroyed) {
      return facades.get(id)!;
    }

    const impl = new ChannelImpl(
      id,
      registry,
      () => {
        channels.delete(id);
        facades.delete(id);
      },
      options,
    );
    channels.set(id, impl);

    const facade: Channel = {
      get id() {
        return impl.id;
      },
      get state() {
        return impl.state;
      },
      get isDestroyed() {
        return impl.isDestroyed;
      },
      stream(cursor?: string) {
        return impl.stream(cursor);
      },
      destroy() {
        impl.destroy();
      },
    };
    facades.set(id, facade);

    return facade;
  }

  const self: TypedStream = { register, listen, channel };
  return self;
}
