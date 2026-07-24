import assert from "node:assert/strict";
import { Hono } from "hono";
import type { Db } from "../db.ts";
import type { AppEnv } from "../types.ts";
import { createDbMiddleware } from "./db.ts";

Deno.test({
  name: "database middleware caches a factory result per request only",
  async fn() {
    let calls = 0;
    const db = { collection: () => ({}) } as unknown as Db;
    const app = new Hono<AppEnv>();
    app.use(
      "*",
      createDbMiddleware(async () => {
        calls += 1;
        return db;
      }, () => ({})),
    );
    app.get("/", async (c) => {
      assert.equal(await c.var.getDb(), db);
      assert.equal(await c.var.getDb(), db);
      return c.text("ok");
    });

    assert.equal((await app.request("/")).status, 200);
    assert.equal(calls, 1);
    assert.equal((await app.request("/")).status, 200);
    assert.equal(calls, 2);
  },
});
