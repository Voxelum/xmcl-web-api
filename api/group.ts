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
  
  let clientId = ctx.request.url.searchParams.get('client') || '';

  console.log(`[${group}] [${clientId}] Get join group request!`);

  function setClientId(id: string) {
    clientId = id;
    console.log(`[${group}] [${clientId}] Set client id`);
  }

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
          }
          console.log(`[${group}] [${clientId}] Get ${type} from channel. ${sender} -> ${receiver}`);

        } catch (e) {
          console.warn(`Get message from group parsed with error`, e);
        }
      }
      socket.send(data);
    });
  };

  channel.onmessageerror = (ev) => {
    console.log(`[${group}] [${clientId}] Channel error`, ev);
  }

  socket.onmessage = (ev) => {
    const data = ev.data;
    if (typeof data === "string") {
      try {
        const { type, receiver, sender } = JSON.parse(data);
        if (clientId === undefined) {
          setClientId(sender);
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
            .then(getId).then(setClientId);
        }
        if (data instanceof Uint8Array) {
          setClientId(getId(data));
        }
      }
    }
    channel.postMessage(data);
  };

  socket.onerror = (e) => {
    console.error(`[${group}] [${clientId}] Websocket error`, e);
    socket.close(1, 'message' in e ? e.message : 'Unknown error');
  }

  socket.onclose = () => {
    console.log(`[${group}] [${clientId}] Websocket closed`);
    channel.close();
  };
});
