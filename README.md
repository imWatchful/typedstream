# @typedstream/core

TypedStream streams **validated backend events to clients over HTTP** using NDJSON.

It provides a simple abstraction for building streaming APIs with:

- schema-validated payloads
- event filtering
- reconnect with replay via cursors
- a typed async iterator client API

TypedStream is useful for:

- AI token streaming
- live logs
- job progress updates
- CI pipelines
- real-time dashboards

## Why?

SSE is a common way to stream data over HTTP, but the setup often introduces unnecessary friction and boilerplate,
especially when building typed event systems.

TypedStream was created to provide a cleaner way to build and consume streaming APIs.

Instead of manually parsing streams and routing event types, the client receives a typed async iterable:

```ts
for await (const event of stream) {
	console.log(event.data);
}
```

This allows streaming APIs to be consumed with the same ergonomics as any other async data source while still using plain HTTP.

## Install

```bash
npm install @typedstream/core
```

```ts
import { createTypedStream } from "@typedstream/core";
import { streamEvents } from "@typedstream/core/client";
import { createEventEmitterAdapter } from "@typedstream/core/adapters/eventemitter";
```

**Runtime requirements**

- Node.js `>=18`
- ESM only

## What The Stream Looks Like

TypedStream sends **NDJSON frames** over HTTP.

Example stream:

```json
{"key":"ai.*.token","name":"ai.req-1.token","cursor":"1","ts":1710000000000,"payload":{"token":"Hello"}}
{"key":"ai.*.token","name":"ai.req-1.token","cursor":"2","ts":1710000000100,"payload":{"token":" world"}}
{"key":"ai.*.done","name":"ai.req-1.done","cursor":"3","ts":1710000000200,"payload":{}}
```

Each frame contains:

| field | description |
| --- | --- |
| `key` | matched schema pattern |
| `name` | emitted event name |
| `cursor` | replay position |
| `ts` | timestamp |
| `payload` | validated event data |

## Example: Streaming AI Tokens

### Server

```ts
import { createServer } from "node:http";
import { Readable } from "node:stream";
import EventEmitter from "node:events";

import { createTypedStream } from "@typedstream/core";
import { createEventEmitterAdapter } from "@typedstream/core/adapters/eventemitter";

const EVENTS = {
	BUS_MESSAGE: "message",
	AI_TOKEN: (id: string) => `ai.${id}.token`,
	AI_DONE: (id: string) => `ai.${id}.done`,
	AI_FILTER: (id: string) => `ai.${id}.*`,
} as const;

const tokenSchema = {
	parse(data: unknown) {
		if (typeof data !== "object" || data === null) {
			throw new Error("Invalid payload");
		}

		const record = data as Record<string, unknown>;

		if (typeof record.token !== "string") {
			throw new Error("Missing token");
		}

		return record;
	},
};

const ts = createTypedStream().register({
	"ai.*.token": tokenSchema,
});

const emitter = new EventEmitter();

const stop = await ts.listen(
	createEventEmitterAdapter({
		emitter,
		eventName: EVENTS.BUS_MESSAGE,
	}),
);

const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://localhost");

	const id = url.searchParams.get("id");

	if (req.method !== "POST" || url.pathname !== "/streams/ai" || !id) {
		res.statusCode = 404;
		res.end();
		return;
	}

	const cursor = url.searchParams.get("cursor") ?? undefined;

	const channel = ts.channel(`ai:${id}`, {
		events: [EVENTS.AI_FILTER(id)],
	});

	const response = channel.stream(cursor);

	res.writeHead(response.status, Object.fromEntries(response.headers));

	Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);

	req.on("close", () => {
		response.body?.cancel().catch(() => {});
	});
});

server.listen(3000);
```

### Client

```ts
import { streamEvents } from "@typedstream/core/client";

const tokenSchema = {
	parse(data: unknown) {
		if (typeof data !== "object" || data === null) {
			throw new Error("Invalid payload");
		}

		return data as { token: string };
	},
};

const stream = streamEvents(
	{
		"ai.*.token": tokenSchema,
	},
	"http://localhost:3000/streams/ai?id=req-1",
);

for await (const event of stream) {
	process.stdout.write(event.data.token);
}
```

## Core Concepts

### Event Patterns

Events are matched using simple string patterns.

```ts
"ci.run.*.*"
```

Example matches:

```text
ci.run.123.log
ci.run.456.status
```

### Channels

Channels define which events a consumer receives.

```ts
const channel = ts.channel("ci:123", {
	events: ["ci.run.123.*"],
});
```

Each channel maintains its own **replay buffer**.

### Replay With Cursors

Clients reconnect automatically using the last received cursor:

```text
POST /streams/ci?cursor=42
```

TypedStream will replay buffered events when possible.

## API Reference

### `createTypedStream()`

Creates the stream instance.

```ts
const ts = createTypedStream();
```

Methods:

- `register(schemas)` add or replace schema patterns
- `listen(adapter, options?)` start ingesting events
- `channel(id, options?)` access or create a channel

### `listen(adapter, options?)`

Starts ingestion from an event source.

Options:

- `signal` abort listener
- `events` explicit patterns passed to adapter

If omitted, the adapter receives the currently registered patterns.

Returns:

```text
Promise<stop>
```

### `channel(id, options?)`

Creates a channel handle.

Options:

| option | description |
| --- | --- |
| `events` | event pattern filter |
| `bufferSize` | replay buffer size (default `200`) |
| `reconnectWindowMs` | channel destroy delay after last consumer (default `30000`) |

Streaming:

```ts
channel.stream(cursor?)
```

Returns an HTTP `Response`.

Headers:

```text
Content-Type: application/x-ndjson; charset=utf-8
Cache-Control: no-cache
X-Accel-Buffering: no
```

## Client

### `streamEvents(schemas, url, options?)`

Creates an async iterable for a TypedStream endpoint.

Behavior:

- sends `POST`
- reconnects automatically
- resumes with `?cursor=<lastCursor>`
- validates payloads using schemas

Usage:

```ts
for await (const event of stream) {
	console.log(event.cursor, event.name, event.data);
}
```

Invalid frames are skipped:

- invalid JSON
- unknown schema keys
- payloads failing schema parse

## Adapters

Adapters connect external event sources to TypedStream.

### `createEventEmitterAdapter`

```ts
createEventEmitterAdapter({
	emitter,
	eventName,
});
```

Default event shape:

```text
{ name, payload }
```

Custom extraction can be provided with `extract(...args)`.

### `createAsyncIterableAdapter`

Maps iterable items to events.

```ts
map(item) => { name, payload }
```

Return `null` to skip an item.

### `createReadableStreamAdapter`

Maps stream chunks to events.

## Utility

### `matchEvent(event, handlers)`

Exhaustive dispatch by event key.

```ts
matchEvent(event, {
	"ci.run.*.*": (event) => {
		void event;
	},
});
```

## Deployment Notes

TypedStream works in multi-instance deployments when using a **shared external event source**, such as:

- Redis
- Kafka
- NATS
- Postgres `LISTEN/NOTIFY`

Use **sticky sessions at the load balancer** so reconnects reach the same instance while replay buffers remain valid.

In-process emitters are **single-instance only**.

(A Redis-backed adapter for better distributed support is planned under `@typedstream/redis`.)

## Contributing

Contributions are welcome.

## License

MIT © [Watchful](https://gamid.dev)
