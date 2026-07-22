# `mot` preview deployment

Deploy the `mot` branch only to isolated preview resources. Do not reuse the
production MongoDB database, Cloudflare KV/Queue, Function App slot settings,
or custom hostname.

The current production composition intentionally does not include durable
commercial adapters. Keep `XMCL_COMMERCIAL_ENABLED` unset or set it to
`false` for every preview deployment. Setting it to `true` fails startup
instead of exposing incomplete commercial routes. Use `deno task local-demo`
for mock-backed commercial API testing.

## Common configuration

The following values are needed only by the route families you enable. Store
secrets in the platform secret store, never in a committed `.env`, deployment
command, or `wrangler.toml`.

| Setting | Preview value / notes |
| --- | --- |
| `MONGO_CONNECION_STRING` | Dedicated preview MongoDB user and database. The spelling is intentionally `CONNECION`. |
| `MONGODB_NAME` | e.g. `xmcl-api-preview-mot`; do not use the production database. |
| `GITHUB_PAT` | Fine-grained, read-only preview token for release/issue endpoints. |
| `AGNES_API_KEY`, `CURSEFORGE_KEY`, `MODRINTH_SECRET` | Preview-specific credentials where available; omit to disable the corresponding integration. |
| `RTC_SECRET`, `TURNS`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_APP_ID` | Preview-only RTC configuration, if RTC is required. |
| `XMCL_SESSION_SECRET` | New random preview secret, never copied from production. |
| `XMCL_*_CLIENT_ID`, `XMCL_*_CLIENT_SECRET` | Preview OAuth application credentials. |
| `XMCL_OAUTH_REDIRECT_URIS` | Exact comma-separated preview callback URLs only. |
| `XMCL_COMMERCIAL_ENABLED` | `false` or omitted. |

After each deployment, verify:

```powershell
Invoke-WebRequest https://<preview-host>/flights
Invoke-WebRequest https://<preview-host>/
```

For Azure Functions, prepend `/api` to those paths.

## Deno Deploy

1. In Deno Deploy, create a separate project such as
   `xmcl-web-api-mot-preview`.
2. Connect the same repository and configure the preview deployment to build
   the `mot` branch with entry point `index.ts`. Do not configure a production
   deployment for this project.
3. Add the settings above as project environment variables/secrets in the
   dashboard. Use a preview-only Mongo database and OAuth callback URL.
4. Trigger a deployment from the `mot` branch, then use the generated
   `*.deno.dev` URL for the checks above.

For a CLI-triggered preview, install `deployctl`, authenticate with a
project-scoped deployment token, and omit `--prod`:

```powershell
deno install -gArf jsr:@deno/deployctl
$env:DENO_DEPLOY_TOKEN = "<preview-project-token>"
deployctl deploy --project xmcl-web-api-mot-preview --token $env:DENO_DEPLOY_TOKEN index.ts
```

Manage preview secrets in the Deno Deploy dashboard rather than passing them
on the command line.

## Azure Functions deployment slot

This repository uses the Node.js v4 Functions worker and requires Node 20,
Azure Functions Core Tools, Azure CLI, and the root `package.json`,
`host.json`, `azure/index.js`, and runtime dependencies in the deployment
package.

1. Create a `mot` deployment slot on a non-production Function App. The App
   Service plan must support deployment slots.

```powershell
$rg = "<resource-group>"
$app = "<function-app>"
$slot = "mot"
az functionapp deployment slot create --resource-group $rg --name $app --slot $slot
```

2. Configure the slot's runtime and slot-sticky non-secret settings. Add
   secrets through Key Vault references or the Azure portal's **Deployment
   slot setting** UI.

```powershell
az functionapp config set --resource-group $rg --name $app --slot $slot `
  --linux-fx-version "Node|20"

az functionapp config appsettings set --resource-group $rg --name $app --slot $slot `
  --slot-settings FUNCTIONS_WORKER_RUNTIME=node FUNCTIONS_EXTENSION_VERSION=~4 `
  MONGODB_NAME=xmcl-api-preview-mot XMCL_COMMERCIAL_ENABLED=false
```

3. Build and publish from the checked-out `mot` branch:

```powershell
npm ci
npm run build:azure
func azure functionapp publish $app --slot $slot
```

If your release process requires ZIP deployment instead, build first and make
the ZIP root contain `host.json`, `package.json`, `azure/index.js`, and its
required `node_modules`, then deploy it:

```powershell
az functionapp deployment source config-zip --resource-group $rg --name $app `
  --slot $slot --src .\xmcl-web-api-mot.zip
```

The preview URL is normally
`https://<function-app>-mot.azurewebsites.net/api/<route>`.

## Cloudflare Workers

Use a distinct Worker name, Mongo database, KV namespace, queue, and route.
Bindings are not inherited by Wrangler environments, so do not add a partial
`[env.mot]` block to the production `wrangler.toml`. Instead create a separate
preview config:

```powershell
cd cloudflare
Copy-Item wrangler.preview.toml.example wrangler.mot.toml
```

1. Replace every `REPLACE_WITH_*` value in `wrangler.mot.toml`.
2. Create isolated resources:

```powershell
npx wrangler kv namespace create TRANSLATION_KV
npx wrangler queues create xmcl-translation-mot
```

Put the returned KV namespace ID and queue name in `wrangler.mot.toml`. The
Durable Object is isolated by the separate Worker name; retain the included
`mot-v1` migration.

3. Set preview-only secrets. Run each command from `cloudflare/`:

```powershell
npx wrangler secret put MONGO_CONNECION_STRING --config wrangler.mot.toml
npx wrangler secret put GITHUB_PAT --config wrangler.mot.toml
npx wrangler secret put XMCL_SESSION_SECRET --config wrangler.mot.toml
# Add only the remaining provider/OAuth secrets enabled for preview.
```

4. Type-check and deploy:

```powershell
npm ci
npm run typecheck
npx wrangler deploy --config wrangler.mot.toml
```

Use the generated `workers.dev` URL first. Add a dedicated preview DNS route
only after the smoke checks pass.

## Rollback and cleanup

- Deno Deploy: promote a prior preview deployment or remove the `mot` branch
  deployment in the project dashboard.
- Azure: redeploy the last known-good ZIP to the `mot` slot. Do not swap the
  slot into production as part of preview validation.
- Cloudflare: `npx wrangler rollback --config wrangler.mot.toml`, or deploy
  the previous commit with the same config.

Delete the preview Mongo database/user, OAuth redirect URL, Cloudflare KV
namespace/queue, slot, and preview project when `mot` is no longer needed.
