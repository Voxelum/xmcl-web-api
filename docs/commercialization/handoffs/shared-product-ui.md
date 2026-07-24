# Handoff: Shared Hosting Product UI

## Goal

Add shared-hosting subscription and service management to `xmcl-page` after the
production commercial composition is enabled.

## Existing API contract

Authenticated APIs already exist in commercial composition:

```text
GET  /v1/shared-hosting/plans
GET  /v1/shared-hosting/subscriptions
POST /v1/shared-hosting/subscriptions
POST /v1/shared-hosting/subscriptions/{subscriptionId}/cancel

GET  /v1/shared-hosting/services
POST /v1/shared-hosting/services
POST /v1/shared-hosting/services/{serviceId}/start
POST /v1/shared-hosting/services/{serviceId}/stop
```

Relevant Web API code:

- `src/routes/sharedHosting.ts`
- `src/routes/sharedHostingServices.ts`
- `contracts/m3-paypal-settlement/v1/openapi.yaml`

## Required UI

1. Plan cards:
   - Small: 4GiB, 2 shared CPU / burst 4, 32GiB data, $4/month + $0.06/hour.
   - Medium: 6GiB, 3 shared CPU / burst 6, 48GiB data, $6/month + $0.09/hour.
   - Large: 8GiB, 4 shared CPU / burst 8, 64GiB data, $8/month + $0.12/hour.
2. Subscription creation with clear upfront first-month base-fee confirmation.
3. Service creation from an active subscription.
4. Service lifecycle states:
   - `ready`
   - `queued` (show capacity wait, not an error)
   - `starting`
   - `running`
   - `stopping`
   - `failed`
   - `deleted`
5. Start/stop controls with idempotency-safe disabled/loading states.
6. Subscription `payment_due` and cancel-at-period-end states.
7. Persistent workspace size and last sync time, without exposing object prefix,
   node identity, Vultr Object Storage credentials, provider IDs, or internal assignments.

## Product requirements

- Explain that shared hosting is on-demand: cold starts may take minutes when a
  workspace must restore or a node must be provisioned.
- Never promise a fixed node/IP address.
- Do not expose raw Docker, Vultr, Object Storage, or scheduler diagnostics to ordinary
  users.
- Distinguish shared services from dedicated/archive servers in navigation and
  billing views.
- Do not ship controls until API production composition, real payment,
  scheduler transport, and node agent are enabled.

## Tests required

1. Anonymous users cannot see/manage private services.
2. `queued` is rendered as a waiting state, not a generic API failure.
3. Start/stop disables duplicate clicks while requests are in flight.
4. User-visible payload does not contain node ID, object prefix, provider
   resource ID, or credentials.
5. Plan prices and quotas match the API response, not duplicated hard-coded
   values.
