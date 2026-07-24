import {
  createLocalDemoApp,
  DEMO_LEASE_ID,
  DEMO_SERVER_ID,
  LOCAL_DEMO_CREDENTIALS,
  LOCAL_DEMO_PROFILE,
} from "../src/localDemo.ts";
import { signWorkerRequest } from "../src/lib/workerAuth.ts";

const configuredBaseUrl = Deno.env.get("DEMO_BASE_URL");
let server: Deno.HttpServer | undefined;
let baseUrl = configuredBaseUrl?.replace(/\/$/, "");

if (!baseUrl) {
  const { app } = await createLocalDemoApp();
  server = Deno.serve({ hostname: "127.0.0.1", port: 0 }, app.fetch);
  const address = server.addr as Deno.NetAddr;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function request(
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  return { response, body };
}

function headers(token: string = LOCAL_DEMO_CREDENTIALS.userAccessToken) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

async function expect(
  label: string,
  expectedStatus: number,
  path: string,
  init: RequestInit = {},
) {
  const result = await request(path, init);
  if (result.response.status !== expectedStatus) {
    throw new Error(
      `${label}: expected ${expectedStatus}, got ${result.response.status}: ${
        JSON.stringify(result.body)
      }`,
    );
  }
  return result.body as Record<string, unknown>;
}

try {
  const profile = await expect("profile", 200, "/__local-demo");
  if (profile.profile !== LOCAL_DEMO_PROFILE) {
    throw new Error("The supplied DEMO_BASE_URL is not a local demo server");
  }
  const archive = profile.modpackArchive as {
    sha256: string;
    sizeBytes: number;
  };

  await expect("route index", 200, "/");
  await expect("public flights", 200, "/flights?version=1.0.0&locale=en-US");
  await expect("account authentication failure", 401, "/v1/account");
  await expect("account", 200, "/v1/account", { headers: headers() });
  await expect("backup policy", 200, "/v1/backup-storage-policy", {
    headers: headers(),
  });
  await expect("session refresh", 200, "/v1/sessions/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: LOCAL_DEMO_CREDENTIALS.userSessionId,
      refreshToken: LOCAL_DEMO_CREDENTIALS.userRefreshToken,
    }),
  });

  await expect("billing balance", 200, "/v1/billing/balance", {
    headers: headers(),
  });
  await expect("billing rates", 200, "/v1/billing/rates", {
    headers: headers(),
  });
  const sharedPlans = await expect(
    "shared hosting plans",
    200,
    "/v1/shared-hosting/plans",
    { headers: headers() },
  );
  if (!Array.isArray(sharedPlans) || sharedPlans.length !== 3) {
    throw new Error("Shared hosting catalog is unavailable in local demo");
  }
  const sharedSubscription = await expect(
    "shared hosting subscription",
    201,
    "/v1/shared-hosting/subscriptions",
    {
      method: "POST",
      headers: { ...headers(), "idempotency-key": "smoke-shared-subscription" },
      body: JSON.stringify({ planId: "shared-small" }),
    },
  );
  const sharedService = await expect(
    "shared hosting service",
    201,
    "/v1/shared-hosting/services",
    {
      method: "POST",
      headers: { ...headers(), "idempotency-key": "smoke-shared-service" },
      body: JSON.stringify({
        subscriptionId: sharedSubscription.subscriptionId,
      }),
    },
  );
  await expect(
    "shared hosting start",
    202,
    `/v1/shared-hosting/services/${sharedService.serviceId}/start`,
    {
      method: "POST",
      headers: { ...headers(), "idempotency-key": "smoke-shared-start" },
    },
  );
  const order = await expect(
    "PayPal mock order",
    201,
    "/v1/billing/paypal/orders",
    {
      method: "POST",
      headers: { ...headers(), "idempotency-key": "smoke-paypal-order" },
      body: JSON.stringify({ amountMinor: 100 }),
    },
  );
  await expect("PayPal idempotent retry", 201, "/v1/billing/paypal/orders", {
    method: "POST",
    headers: { ...headers(), "idempotency-key": "smoke-paypal-order" },
    body: JSON.stringify({ amountMinor: 100 }),
  });
  await expect(
    "PayPal mock capture",
    200,
    `/v1/billing/paypal/orders/${order.orderId}/capture`,
    { method: "POST", headers: headers(), body: "{}" },
  );
  await expect("PayPal mock webhook", 202, "/v1/webhooks/paypal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "smoke-paypal-webhook",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        supplementary_data: {
          related_ids: { order_id: `paypal_${order.orderId}` },
        },
      },
    }),
  });

  const expiresAt = "2099-01-01T00:00:00.000Z";
  const authorizationInput = {
    accountId: "demo-user",
    resource: "ai_request",
    sourceId: "smoke-usage",
    expectedQuantity: 1,
    unit: "request",
    settlementIntervalSeconds: 60,
    rateVersion: 7,
    idempotencyKey: "smoke-usage-authorize",
    expiresAt,
  };
  const usageAuthorization = await expect(
    "usage authorization",
    200,
    "/v1/internal/usage/authorize",
    {
      method: "POST",
      headers: {
        ...headers(LOCAL_DEMO_CREDENTIALS.serviceAccessToken),
        "idempotency-key": authorizationInput.idempotencyKey,
      },
      body: JSON.stringify(authorizationInput),
    },
  );
  await expect(
    "usage authorization retry",
    200,
    "/v1/internal/usage/authorize",
    {
      method: "POST",
      headers: {
        ...headers(LOCAL_DEMO_CREDENTIALS.serviceAccessToken),
        "idempotency-key": authorizationInput.idempotencyKey,
      },
      body: JSON.stringify(authorizationInput),
    },
  );
  await expect("usage settlement", 200, "/v1/internal/usage/settle", {
    method: "POST",
    headers: {
      ...headers(LOCAL_DEMO_CREDENTIALS.serviceAccessToken),
      "idempotency-key": "smoke-usage-settlement",
    },
    body: JSON.stringify({
      eventType: "usage.recorded.v1",
      eventId: "smoke-usage-event",
      schemaVersion: 1,
      accountId: "demo-user",
      authorizationId: usageAuthorization.authorizationId,
      resource: "ai_request",
      sourceId: "smoke-usage",
      quantity: 1,
      unit: "request",
      rateVersion: 7,
      intervalStart: "2026-07-22T00:00:00.000Z",
      intervalEnd: "2026-07-22T00:00:01.000Z",
      occurredAt: "2026-07-22T00:00:01.000Z",
      idempotencyKey: "smoke-usage-settlement",
    }),
  });

  const serverRequest = {
    method: "POST",
    headers: {
      ...headers(),
      "idempotency-key": "smoke-server-create",
      "x-request-id": "smoke-server-create",
    },
    body: JSON.stringify({ plan: "vc2-2c-4gb" }),
  };
  await expect("server create", 202, "/v1/servers", serverRequest);
  await expect("server idempotent retry", 202, "/v1/servers", serverRequest);
  await expect("server idempotency conflict", 409, "/v1/servers", {
    ...serverRequest,
    body: JSON.stringify({ plan: "vc2-4c-8gb" }),
  });
  await expect("server list", 200, "/v1/servers", { headers: headers() });

  const backupPath = "/v1/backup-sources/client_world/smoke-world/backups";
  const backupRequest = {
    method: "POST",
    headers: { ...headers(), "idempotency-key": "smoke-backup-create" },
    body: JSON.stringify({
      worldId: "smoke-world",
      format: "linear",
      formatVersion: 1,
      contentLength: 128,
      sha256: "a".repeat(64),
      contentType: "application/vnd.xmcl.linear",
      compression: "xmcl_linear",
      explicitManual: true,
    }),
  };
  const backup = await expect(
    "world backup create",
    202,
    backupPath,
    backupRequest,
  );
  await expect("world backup retry", 202, backupPath, backupRequest);
  await expect(
    "world backup upload grant",
    200,
    `/v1/world-backups/${backup.backupId}/upload-url`,
    {
      method: "POST",
      headers: { ...headers(), "idempotency-key": "smoke-backup-upload" },
    },
  );
  await expect(
    "world backup complete",
    202,
    `/v1/world-backups/${backup.backupId}/complete`,
    {
      method: "POST",
      headers: { ...headers(), "idempotency-key": "smoke-backup-complete" },
    },
  );
  await expect("world backup list", 200, backupPath, { headers: headers() });

  await expect("AI models", 200, "/v1/ai/models", { headers: headers() });
  const aiRequest = {
    method: "POST",
    headers: {
      ...headers(),
      "idempotency-key": "smoke-ai",
      "x-request-id": "smoke-ai",
    },
    body: JSON.stringify({ input: "The local demo launcher stopped." }),
  };
  await expect("AI invoke", 200, "/v1/ai/troubleshoot", aiRequest);
  await expect("AI idempotent retry", 200, "/v1/ai/troubleshoot", aiRequest);
  await expect("AI usage projection excluded", 503, "/v1/ai/usage", {
    headers: headers(),
  });

  const registerPath = `/v1/internal/servers/${DEMO_SERVER_ID}/worker/register`;
  const registerBody = JSON.stringify({
    leaseId: DEMO_LEASE_ID,
    workerId: "smoke-worker",
  });
  const timestamp = String(Date.now());
  const registerNonce = "smoke-worker-register";
  const workerRegistration = await expect(
    "worker registration",
    201,
    registerPath,
    {
      method: "POST",
      headers: {
        authorization:
          `Worker-Bootstrap ${LOCAL_DEMO_CREDENTIALS.workerBootstrapCredential}`,
        "content-type": "application/json",
        "x-worker-timestamp": timestamp,
        "x-worker-nonce": registerNonce,
        "x-worker-signature": await signWorkerRequest(
          LOCAL_DEMO_CREDENTIALS.workerBootstrapCredential,
          {
            method: "POST",
            path: registerPath,
            body: registerBody,
            timestamp,
            nonce: registerNonce,
          },
        ),
      },
      body: registerBody,
    },
  );
  const heartbeatPath =
    `/v1/internal/servers/${DEMO_SERVER_ID}/worker/heartbeat`;
  const heartbeatBody = JSON.stringify({
    eventId: "smoke-worker-heartbeat",
    serverId: DEMO_SERVER_ID,
    leaseId: DEMO_LEASE_ID,
    status: "running",
    observedAt: new Date().toISOString(),
  });
  const heartbeatNonce = "smoke-worker-heartbeat";
  await expect("worker heartbeat", 200, heartbeatPath, {
    method: "POST",
    headers: {
      authorization: `Worker ${workerRegistration.token}`,
      "content-type": "application/json",
      "x-worker-timestamp": timestamp,
      "x-worker-nonce": heartbeatNonce,
      "x-worker-signature": await signWorkerRequest(
        workerRegistration.token as string,
        {
          method: "POST",
          path: heartbeatPath,
          body: heartbeatBody,
          timestamp,
          nonce: heartbeatNonce,
        },
      ),
    },
    body: heartbeatBody,
  });

  const modpackImport = await expect(
    "modpack import",
    201,
    `/v1/servers/${DEMO_SERVER_ID}/modpack-imports`,
    {
      method: "POST",
      headers: { ...headers(), "idempotency-key": "smoke-modpack-import" },
      body: JSON.stringify({
        sourceFormat: "mrpack",
        expectedSha256: archive.sha256,
        expectedSizeBytes: archive.sizeBytes,
      }),
    },
  );
  await expect(
    "modpack upload grant",
    200,
    `/v1/modpack-imports/${modpackImport.importId}/upload-url`,
    {
      method: "POST",
      headers: { ...headers(), "idempotency-key": "smoke-modpack-upload" },
    },
  );
  await expect(
    "modpack validation",
    202,
    `/v1/modpack-imports/${modpackImport.importId}/complete`,
    {
      method: "POST",
      headers: { ...headers(), "idempotency-key": "smoke-modpack-complete" },
    },
  );
  const deploymentTask = await expect(
    "modpack deployment",
    202,
    `/v1/servers/${DEMO_SERVER_ID}/modpack-deployments`,
    {
      method: "POST",
      headers: { ...headers(), "idempotency-key": "smoke-modpack-deployment" },
      body: JSON.stringify({ importId: modpackImport.importId }),
    },
  );
  const deployments = await expect(
    "modpack deployments",
    200,
    `/v1/servers/${DEMO_SERVER_ID}/modpack-deployments`,
    { headers: headers() },
  );
  const deployment = (deployments.items as Array<Record<string, unknown>>)[0];
  await expect(
    "modpack preview",
    202,
    `/v1/modpack-deployments/${deployment.deploymentId}/preview`,
    {
      method: "POST",
      headers: { ...headers(), "idempotency-key": "smoke-modpack-preview" },
    },
  );
  const previewed = await expect(
    "modpack deployment details",
    200,
    `/v1/modpack-deployments/${deployment.deploymentId}`,
    { headers: headers() },
  );
  await expect(
    "modpack apply",
    202,
    `/v1/modpack-deployments/${deployment.deploymentId}/apply`,
    {
      method: "POST",
      headers: { ...headers(), "idempotency-key": "smoke-modpack-apply" },
      body: JSON.stringify({ manifestSha256: previewed.manifestSha256 }),
    },
  );
  if (!deploymentTask.taskId) {
    throw new Error("modpack deployment task was not returned");
  }

  await expect("admin metrics", 200, "/v1/admin/metrics", {
    headers: {
      authorization: `Bearer ${LOCAL_DEMO_CREDENTIALS.adminAccessToken}`,
    },
  });
  await expect(
    "admin operation",
    202,
    `/v1/admin/servers/${DEMO_SERVER_ID}/suspend`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${LOCAL_DEMO_CREDENTIALS.adminAccessToken}`,
        "content-type": "application/json",
        "idempotency-key": "smoke-admin-suspend",
      },
      body: JSON.stringify({ reason: "Smoke test", ticketId: "smoke-ticket" }),
    },
  );

  console.log(`Local demo smoke test passed against ${baseUrl}`);
} finally {
  await server?.shutdown();
}
