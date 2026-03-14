export interface Schema<T extends Record<string, unknown> = Record<string, unknown>> {
  parse(data: unknown): T;
}

export type SchemaMap = Record<string, Schema>;
export type MaybePromise<T> = T | Promise<T>;

export interface WireFrame {
  key: string;
  name: string;
  cursor: string;
  ts: number;
  payload: Record<string, unknown>;
}

export interface HeartbeatFrame {
  type: "__heartbeat";
}

export interface ErrorFrame {
  type: "__error";
  message: string;
}

export type SystemFrame = HeartbeatFrame | ErrorFrame;
export type Frame = WireFrame | SystemFrame;

export interface ListenerAdapterContext {
  events: readonly string[];
  signal: AbortSignal;
  onEvent: (event: { name: string; payload: unknown }) => void;
}

export interface ListenerAdapter {
  start(ctx: ListenerAdapterContext): void | (() => MaybePromise<void>);
}

export interface ChannelOptions {
  events?: readonly string[];
  bufferSize?: number;
  reconnectWindowMs?: number;
}

export type ChannelState = "idle" | "active" | "draining" | "destroyed";

export interface Channel {
  readonly id: string;
  readonly state: ChannelState;
  readonly isDestroyed: boolean;
  stream(cursor?: string): Response;
  destroy(): void;
}

export interface ClientEvent<T extends Record<string, unknown> = Record<string, unknown>> {
  key: string;
  name: string;
  cursor: string;
  ts: number;
  data: T;
}

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  multiplier?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export interface ConnectOptions {
  signal?: AbortSignal;
  headers?: HeadersInit;
  body?: BodyInit | Record<string, unknown>;
  credentials?: RequestCredentials;
  retry?: RetryOptions;
  onConnect?: () => void;
  onDisconnect?: (error: unknown) => void;
}
