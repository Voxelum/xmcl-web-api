import { Hono } from "hono";
import {
  isRecentBrowserOAuthPrincipal,
  issueAdminSession,
  verifiedAllowedAdminEmail,
} from "../adminSession.ts";
import { getAccountRuntime } from "../accountRuntime.ts";
import { getConfig } from "../config.ts";
import { authenticateXmclRequest } from "../middleware/xmclAuth.ts";
import type { AppEnv } from "../types.ts";

const adminSession = new Hono<AppEnv>();

adminSession.post("/v1/admin/session", async (c) => {
  const config = getConfig(c);
  if (!config.XMCL_ADMIN_SESSION_SECRET || !config.XMCL_ADMIN_EMAILS) {
    return c.json({ error: "admin_auth_unavailable" }, 503);
  }
  try {
    const principal = await authenticateXmclRequest(c);
    if (!principal || !isRecentBrowserOAuthPrincipal(principal)) {
      return c.json({ error: "admin_reauthentication_required" }, 401);
    }
    const account = await (await getAccountRuntime(c)).accounts.requireAccount(
      principal.accountId,
    );
    const allowedEmails = new Set(
      config.XMCL_ADMIN_EMAILS.split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    );
    if (!verifiedAllowedAdminEmail(account, allowedEmails)) {
      return c.json({ error: "admin_forbidden" }, 403);
    }
    return c.json(
      await issueAdminSession(
        config.XMCL_ADMIN_SESSION_SECRET,
        account.accountId,
      ),
    );
  } catch {
    return c.json({ error: "admin_authentication_required" }, 401);
  }
});

export default adminSession;
