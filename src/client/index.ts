import type { SchemaMap, ClientEvent, ConnectOptions, RetryOptions } from "../types.js";

const DEFAULT_RETRY: Required<
  Pick<RetryOptions, "maxAttempts" | "initialDelayMs" | "maxDelayMs" | "multiplier">
> = {
  maxAttempts: 5,
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  multiplier: 2,
};

export function streamEvents(
  schemas: SchemaMap,
  url: string,
  options?: ConnectOptions,
): AsyncIterable<ClientEvent> {
  return {
    [Symbol.asyncIterator]() {
      return connectIterator(schemas, url, options);
    },
  };
}

async function* connectIterator(
  schemas: SchemaMap,
  url: string,
  options?: ConnectOptions,
): AsyncGenerator<ClientEvent> {
  const retry = { ...DEFAULT_RETRY, ...options?.retry };
  const userSignal = options?.signal;

  let lastCursor: string | undefined;
  let attempt = 0;

  while (true) {
    if (userSignal?.aborted) return;

    let fetchUrl = url;
    if (lastCursor !== undefined) {
      fetchUrl = setCursorParam(url, lastCursor);
    }

    let body: BodyInit | undefined;
    const headers = new Headers(options?.headers);

    if (options?.body !== undefined) {
      if (
        typeof options.body === "object" &&
        options.body !== null &&
        !(options.body instanceof ArrayBuffer) &&
        !(options.body instanceof Uint8Array) &&
        !(options.body instanceof ReadableStream) &&
        !(options.body instanceof Blob) &&
        !(options.body instanceof FormData) &&
        !(options.body instanceof URLSearchParams) &&
        typeof options.body !== "string"
      ) {
        body = JSON.stringify(options.body);
        if (!headers.has("Content-Type")) {
          headers.set("Content-Type", "application/json");
        }
      } else {
        body = options.body as BodyInit;
      }
    }

    try {
      const response = await fetch(fetchUrl, {
        method: "POST",
        headers,
        body,
        credentials: options?.credentials,
        signal: userSignal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error("Response body is null");
      }

      options?.onConnect?.();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let partial = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            partial += decoder.decode();
            break;
          }

          partial += decoder.decode(value, { stream: true });
          const lines = partial.split("\n");
          partial = lines.pop()!;

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            const event = parseClientEventLine(trimmed, schemas);
            if (!event) continue;

            lastCursor = event.cursor;
            attempt = 0;
            yield event;
          }
        }

        const trailing = partial.trim();
        if (trailing) {
          const event = parseClientEventLine(trailing, schemas);
          if (event) {
            lastCursor = event.cursor;
            attempt = 0;
            yield event;
          }
        }
      } finally {
        reader.releaseLock();
      }

      continue;
    } catch (err) {
      if (userSignal?.aborted) return;
      options?.onDisconnect?.(err);

      attempt++;
      if (attempt > retry.maxAttempts) return;
      if (retry.shouldRetry && !retry.shouldRetry(err, attempt)) return;

      const delay = Math.min(
        retry.initialDelayMs * Math.pow(retry.multiplier, attempt - 1),
        retry.maxDelayMs,
      );
      retry.onRetry?.(err, attempt, delay);

      await sleep(delay, userSignal);
      continue;
    }
  }
}

function parseClientEventLine(line: string, schemas: SchemaMap): ClientEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  if ("type" in parsed) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const key = record.key;
  const name = record.name;
  const cursor = record.cursor;
  const ts = record.ts;

  if (typeof key !== "string" || typeof name !== "string") {
    return null;
  }

  if (typeof cursor !== "string" || cursor.length === 0) {
    return null;
  }

  if (typeof ts !== "number" || !Number.isFinite(ts)) {
    return null;
  }

  const schema = findSchema(schemas, key);
  if (!schema) {
    return null;
  }

  let data: Record<string, unknown>;
  try {
    data = schema.parse(record.payload);
  } catch {
    return null;
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }

  return { key, name, cursor, ts, data };
}

function findSchema(schemas: SchemaMap, key: string) {
  return schemas[key] ?? null;
}

function setCursorParam(url: string, cursor: string): string {
  const [withoutHash, hash = ""] = url.split("#", 2);
  const [path, query = ""] = withoutHash.split("?", 2);
  const params = new URLSearchParams(query);
  params.set("cursor", cursor);
  const nextQuery = params.toString();
  return `${path}${nextQuery ? `?${nextQuery}` : ""}${hash ? `#${hash}` : ""}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
