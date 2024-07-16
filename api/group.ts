import { Router, Status } from "oak";

export default new Router().get("/group/:id", (ctx) => {
  if (!ctx.isUpgradable) {
    ctx.throw(501);
  }

  if (ctx.request.headers.get("upgrade") !== "websocket") {
    ctx.throw(Status.NotImplemented);
  }

  const group = ctx.params.id;
  const clientId = ctx.request.url.searchParams.get("client-id");
  const channel = new BroadcastChannel(group);

  const socket = ctx.upgrade();
  console.log(`Get join group request ${group}!`);

  socket.onopen = () => {
    console.log(`Websocket created ${group}!`);
    channel.addEventListener("message", ({ data }) => {
      if (typeof data === "string") {
        try {
          const { type, receiver, sender } = JSON.parse(data);

          if (receiver && clientId && receiver !== clientId) {
            return;
          }

          console.log(`[${group}] Get ${type} from channel. ${sender} -> ${receiver}`);

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
        console.log(`[${group}] Broadcast ${type} from client. ${sender} -> ${receiver}`);
      } catch (e) {
        console.warn(`Get message from group parsed with error`, e);
      }
    }
    channel.postMessage(data);
  };

  socket.onclose = () => {
    console.log(`Websocket closed ${group}!`);
    channel.close();
  };
});
