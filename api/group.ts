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
  console.log(`Get join group request ${group}!`);

  socket.onopen = () => {
    console.log(`Websocket created ${group}!`);
    channel.addEventListener("message", ({ data }) => {
      if (typeof data === "string") {
        console.log(`Get message from group ${group} ${data}`);
      }
      socket.send(data);
    });
  };

  socket.onmessage = (ev) => {
    const data = ev.data;
    if (typeof data === "string") {
      console.log(`Get message from client side & send to channel ${group}`);
      console.log(data);
    }
    channel.postMessage(data);
  };

  socket.onclose = () => {
    console.log(`Websocket closed ${group}!`);
    channel.close();
  };
});
