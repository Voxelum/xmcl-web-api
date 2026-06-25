// deno-lint-ignore-file no-explicit-any

/**
 * Deno implementation of the `/group/:id` realtime upgrade. Uses the native
 * `Deno.upgradeWebSocket` plus a `BroadcastChannel` so messages fan out across
 * Deno Deploy isolates.
 *
 * Called directly from the Deno entry's request interceptor (before the Hono
 * app) so the CORS middleware never touches the immutable 101 response.
 *
 * Wire protocol (unchanged): text frames are JSON `{ type, receiver, sender }`
 * relayed to peers (filtered by `receiver`); binary frames carry a 16-byte
 * client id, and frames longer than 16 bytes are pings answered with a PONG.
 */
export function upgradeGroupDeno(request: Request, group: string): Response {
  const { socket, response } = (Deno as any).upgradeWebSocket(request);
  const channel = new BroadcastChannel(group);

  let clientId = new URL(request.url).searchParams.get("client") || "";

  const setClientId = (id: string) => {
    clientId = id;
  };

  socket.onopen = () => {
    channel.addEventListener("message", ({ data }: MessageEvent) => {
      if (typeof data === "string") {
        try {
          const { receiver } = JSON.parse(data);
          if (clientId && receiver && receiver !== clientId) {
            return;
          }
        } catch (e) {
          console.warn("Group channel message parse error", e);
        }
      }
      socket.send(data);
    });
  };

  socket.onmessage = (ev: MessageEvent) => {
    const data = ev.data;
    if (typeof data === "string") {
      try {
        const { sender } = JSON.parse(data);
        if (!clientId && sender) {
          setClientId(sender);
        }
      } catch (e) {
        console.warn("Group message parse error", e);
      }
      channel.postMessage(data);
    } else {
      const handleData = (bytes: Uint8Array) => {
        if (!clientId) {
          const id = [...bytes.slice(0, 16)]
            .map((b) => ("00" + b.toString(16)).slice(-2))
            .join("")
            .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
          setClientId(id);
        }
        if (bytes.length > 16) {
          const extra = bytes.slice(16);
          const timestamp = new DataView(extra.buffer).getFloat64(0);
          socket.send(JSON.stringify({ type: "PONG", timestamp }));
          channel.postMessage(bytes.slice(0, 16));
        } else {
          channel.postMessage(bytes);
        }
      };
      if (data instanceof Blob) {
        data.arrayBuffer().then((b) => handleData(new Uint8Array(b)));
      } else if (data instanceof ArrayBuffer) {
        handleData(new Uint8Array(data));
      } else if (data instanceof Uint8Array) {
        handleData(data);
      } else {
        channel.postMessage(data);
      }
    }
  };

  socket.onclose = () => {
    channel.close();
  };

  socket.onerror = (e: any) => {
    console.error(`[${group}] [${clientId}] websocket error`, e?.message ?? e);
    try {
      socket.close(1011, e?.message ?? "error");
    } catch {
      // already closed
    }
  };

  return response;
}
