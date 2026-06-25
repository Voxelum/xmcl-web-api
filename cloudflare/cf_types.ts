// deno-lint-ignore-file no-explicit-any
// Minimal Cloudflare Workers runtime types we use. denoflare provides fuller
// definitions, but declaring just what we need keeps this self-contained and
// checkable with `deno check`.

export interface DurableObjectId {
  toString(): string;
}

export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface DurableObjectState {
  readonly id: DurableObjectId;
  waitUntil?(promise: Promise<unknown>): void;
}

/** Cloudflare's server-side WebSocket (superset of the DOM WebSocket). */
export interface CfWebSocket {
  accept(): void;
  send(message: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "message",
    listener: (event: { data: string | ArrayBuffer }) => void,
  ): void;
  addEventListener(type: "close" | "error", listener: () => void): void;
}

export interface CfWebSocketPair {
  0: CfWebSocket;
  1: CfWebSocket;
}

export interface ResponseInitWithWebSocket extends ResponseInit {
  webSocket?: CfWebSocket;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  // deno-lint-ignore no-explicit-any
  props: any;
}

export interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
}

export interface Message<T> {
  readonly body: T;
  ack(): void;
  retry(): void;
}

export interface MessageBatch<T> {
  readonly queue: string;
  readonly messages: Message<T>[];
}

declare global {
  // Provided by the Cloudflare runtime (and denoflare's shim).
  const WebSocketPair: { new (): CfWebSocketPair };
}
