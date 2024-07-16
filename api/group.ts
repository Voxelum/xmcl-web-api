import { Router, Status } from "oak";

export default new Router().get("/group/:id", (ctx) => {
  if (!ctx.isUpgradable) {
    ctx.throw(501);
  }

  if (ctx.request.headers.get("upgrade") !== "websocket") {
    ctx.throw(Status.NotImplemented);
  }

  const group = ctx.params.id;
  const channel = new BroadcastChannel(group);

  const socket = ctx.upgrade();
  console.log(`[${group}] Get join group request!`);

  let clientId = undefined as string | undefined;

  socket.onopen = () => {
    console.log(`[${group}] Websocket created!`);
    channel.addEventListener("message", ({ data }) => {
      if (typeof data === "string") {
        try {
          const { type, receiver, sender } = JSON.parse(data);

          if (clientId) {
            if (receiver && receiver !== clientId) {
              return;
            }
            console.log(`[${group}] [${clientId}] Get ${type} from channel. ${sender} -> ${receiver}`);
          } else {
            console.log(`[${group}] Get ${type} from channel. ${sender} -> ${receiver}`);
          }

        } catch (e) {
          console.warn(`Get message from group parsed with error`, e);
        }
      }
      socket.send(data);
    });
  };

  socket.onmessage = (ev) => {
    const data = ev.data;
    if (typeof data === "string") {
      try {
        const { type, receiver, sender } = JSON.parse(data);
        if (clientId === undefined) {
          clientId = sender;
        }
        console.log(`[${group}] [${clientId}] Broadcast ${type} from client. ${sender} -> ${receiver}`);
      } catch (e) {
        console.warn(`Get message from group parsed with error`, e);
      }
    } else {
      if (!clientId) {
        const getId = (data: Uint8Array) => {
          return [...data]
            .map((b) => ('00' + b.toString(16)).slice(-2))
            .join('')
            .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
        }
        if (data instanceof Blob) {
          // Blob to Uint8Array
          data.arrayBuffer().then(data => new Uint8Array(data))
            .then(getId).then(id => clientId = id);
        }
        if (data instanceof Uint8Array) {
          clientId = getId(data);
        }
      }
    }
    channel.postMessage(data);
  };

  socket.onerror = (e) => {
    console.error(`[${group}] [${clientId}] Websocket error`, e);
  }

  socket.onclose = () => {
    console.log(`[${group}] [${clientId}] Websocket closed`);
    channel.close();
  };
});
