import type { ClientEvent } from "./types.js";

export function matchEvent<
  TEvent extends ClientEvent,
  THandlers extends { [K in TEvent["key"]]: (event: TEvent & { key: K }) => unknown },
>(event: TEvent, handlers: THandlers): ReturnType<THandlers[TEvent["key"]]> {
  const handler = handlers[event.key as TEvent["key"]];
  return (handler as (event: never) => unknown)(event as never) as ReturnType<
    THandlers[TEvent["key"]]
  >;
}
