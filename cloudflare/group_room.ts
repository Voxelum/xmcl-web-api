// deno-lint-ignore-file no-explicit-any
import type {
  CfWebSocket,
  DurableObjectNamespace,
  DurableObjectState,
  ResponseInitWithWebSocket,
} from "./cf_types.ts";

export type GroupRoomNamespace = DurableObjectNamespace;

interface SocketMeta {
  clientId: string;
}

/**
 * One Durable Object instance per group id, addressed via
 * `GROUP_ROOM.idFromName(group)`. Backs `/group/:id` realtime messaging and
 * replaces the Deno Deploy `BroadcastChannel(group)` fan-out: every socket for
 * a group connects to the same instance and we relay to the other sockets.
 *
 * Wire protocol (shared with the Deno realtime implementation):
 *  - Text frames: JSON `{ type, receiver, sender }`. The first `sender` seen on
 *    a socket sets its client id. A frame with `receiver` is delivered only to
 *    the socket whose client id matches (sockets without an id yet receive all).
 *  - Binary frames: first 16 bytes are the sender's client id (UUID). A frame
 *    longer than 16 bytes is a ping: reply `{ type:'PONG', timestamp }` (float64
 *    read at byte 16) to the sender and relay just the 16-byte id to the room.
 *    A 16-byte frame is relayed as-is.
 *
 * Uses the classic `accept()` + `addEventListener` WebSocket API (not the
 * hibernation API) so the same code runs under `denoflare serve` and on pushed
 * Cloudflare. Sockets are held in memory; the instance stays alive while any
 * socket is connected.
 */
export class GroupRoom {
  private readonly sockets = new Map<CfWebSocket, SocketMeta>();

  constructor(_state: DurableObjectState, _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }

    const url = new URL(request.url);
    const clientId = url.searchParams.get("client") || "";

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();
    const meta: SocketMeta = { clientId };
    this.sockets.set(server, meta);

    server.addEventListener("message", (event) => {
      try {
        this.onMessage(server, meta, event.data);
      } catch (e) {
        console.error("group message error", e);
      }
    });
    const cleanup = () => this.sockets.delete(server);
    server.addEventListener("close", cleanup);
    server.addEventListener("error", cleanup);

    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInitWithWebSocket);
  }

  private onMessage(
    sender: CfWebSocket,
    meta: SocketMeta,
    data: string | ArrayBuffer,
  ): void {
    if (typeof data === "string") {
      let receiver: string | undefined;
      try {
        const parsed = JSON.parse(data) as { receiver?: string; sender?: string };
        receiver = parsed.receiver || undefined;
        if (!meta.clientId && parsed.sender) {
          meta.clientId = parsed.sender;
        }
      } catch {
        // Non-JSON text is relayed verbatim, like the Deno service.
      }
      this.broadcast(sender, data, receiver);
      return;
    }

    const bytes = new Uint8Array(data);
    if (!meta.clientId && bytes.length >= 16) {
      meta.clientId = bytesToUuid(bytes.subarray(0, 16));
    }

    if (bytes.length > 16) {
      const extra = bytes.slice(16);
      const timestamp = new DataView(extra.buffer).getFloat64(0);
      sender.send(JSON.stringify({ type: "PONG", timestamp }));
      this.broadcast(sender, bytes.slice(0, 16));
    } else {
      this.broadcast(sender, bytes);
    }
  }

  private broadcast(
    sender: CfWebSocket,
    data: string | Uint8Array,
    receiver?: string,
  ): void {
    for (const [socket, meta] of this.sockets) {
      if (socket === sender) continue;
      if (receiver && meta.clientId && meta.clientId !== receiver) continue;
      try {
        socket.send(data);
      } catch {
        this.sockets.delete(socket);
      }
    }
  }
}

function bytesToUuid(bytes: Uint8Array): string {
  return [...bytes]
    .map((b) => ("00" + b.toString(16)).slice(-2))
    .join("")
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
}
