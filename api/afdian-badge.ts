import { Hash, encode  } from "https://deno.land/x/checksum@1.2.0/mod.ts";
import { Router } from "oak";

interface AfdianResponse {
  data: {
    total_count: number;
  };
}

export default new Router().get("/afdian-badge", async (ctx) => {
  const token = Deno.env.get("AFDIAN_TOKEN");
  const body = {
    user_id: Deno.env.get("AFDIAN_USER_ID"),
    params: JSON.stringify({ page: 1 }),
    ts: Math.floor(Date.now() / 1000),
  };
  const sign = new Hash("md5").digest(
    encode(`${token}params${body.params}ts${body.ts}user_id${body.user_id}`),
  ).hex();
  const bodyContent = JSON.stringify({
    ...body,
    sign,
  });
  const response = await fetch("https://afdian.net/api/open/query-sponsor", {
    method: "POST",
    body: bodyContent,
    headers: {
      "Content-Type": "application/json",
    },
  });
  const content: AfdianResponse = await response.json();
  const fileContent = await Deno.readFile("./afdian.svg");
  const decoder = new TextDecoder("utf-8");
  const svg = decoder.decode(fileContent);

  ctx.response.body = {
    schemaVersion: 1,
    label: "爱发电",
    color: "946ce6",
    logoSvg: svg,
    message: `${content.data.total_count} 位天使`,
  };
});
