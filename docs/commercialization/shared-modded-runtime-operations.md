# Shared modded runtime compiler deployment

The shared-hosting modded path is intentionally fail-closed. It is not enabled
by the existing public shared-hosting gate until all dependencies below are
installed.

## Local instance bundles

The launcher can import `sourceFormat: "xmcl_server_bundle"` through the same
account/service-owned modpack-import flow. It starts from an already-working
local modded **client** instance. Its `.xmcl-server-bundle` is a versioned
deterministic archive containing `bundle.json`, selected server-relevant
instance content (including mods, config, KubeJS, scripts, and opted-in
server-relevant resources), loader/version metadata, and hashes with explicit
content intent in `resolved/artifacts.json`; it contains no local server
executable or classpath.
The compiler independently assembles a dedicated-server runtime. The API
records the expected SHA-256 and size before issuing one short-lived exact PUT;
it does not accept a browser-supplied object key.

Completion re-reads that exact object, validates ZIP safety, every manifest
path/hash, and an exact reviewed toolchain tuple (canonical Minecraft version,
loader kind/version, Java component/major, and runtime-catalog SHA). `26.2`
with Fabric `0.19.3` and Java 25 is a reviewed tuple. Version identifiers are
bounded canonical numeric IDs only; paths, whitespace/control characters, URLs,
commands, and non-catalog versions reject. It freezes only a compiler input grant for the service-owned
archive key and one immutable `If-None-Match: *` content PUT. Local Java
paths, JVM arguments, Docker choices, URLs, `server.sh`/`server.bat`, worlds,
and account/private data are not executable input. World migration remains a
separate explicit operation after deployment creation.

## Required external deployment

1. Deploy an egress-isolated compiler worker. It needs a non-root ephemeral
   workspace, resource/PID limits, no Docker socket or host mounts, approved
   HTTPS artifact origins only, bounded redirects/sizes/timeouts, and network
   removal after acquisition.
2. Install a `SharedModdedCompiler` adapter that authenticates the compiler
   callback (mTLS or an equivalent server-side identity) and a
   `SharedModdedArchiveStore` backed by immutable imported archives. Do not
   substitute legacy dedicated-worker staging.
3. Inject `CompilerGrantAuthority` using the server-only S3 signer. Compiler
   grants provide only the frozen import GET and exact immutable content PUT;
   they cannot list/delete, read worlds, or act as node grants.
4. Inject the same `SharedModdedRuntimeService` as
   `SharedRuntimeContentGrantAuthority` into `SharedNodeTransportService`.
   This authorizes a node restore GET only for the currently selected,
   published deployment.
5. Publish the generic runtime image from
   [`Voxelum/xmcl-shared-minecraft-runtime`](https://github.com/Voxelum/xmcl-shared-minecraft-runtime)
   with the same reviewed `runtime-catalog.lock.json` revision compiled into the
   control plane and node agent, then configure the agent with its immutable
   GHCR digest. The catalog currently contains Java 8/16/17/21/25.
6. Connect the server-side EULA/terms acceptance policy to
   `eulaAccepted`. The runtime launcher rejects starts without that trusted
   command field; user content cannot set it.

## Compiler protocol

`SharedModdedRuntimeService` freezes a canonical input manifest and calls a
`SharedModdedCompiler`. The compiler receives the service/account/deployment
identity, manifest digest, exact output key, validated config/data hashes,
resolved provider artifacts and hashes, and compiler request ID. It returns a
descriptor plus content archive descriptor only after the immutable PUT is
verified. Unknown compatibility, artifact hosts, digest mismatches, and
descriptors containing paths/arguments outside the fixed contract fail.
The descriptor must include the official `java.component`, `java.major`, and
`runtimeCatalog.sha256`; the control plane accepts only its compiled reviewed
catalog revision and a component/major requirement with a bundled runtime.
When the runtime-image catalog changes, regenerate the compact control-plane
catalog configuration from that reviewed lock and deploy it with the matching
immutable image digest; user uploads and compiler callbacks cannot select a
catalog URL or revision.

The compiler callback endpoints are deliberately separate from account routes:

```text
POST /v1/internal/shared-runtime-compiler/deployments/:id/grants
POST /v1/internal/shared-runtime-compiler/deployments/:id/published
POST /v1/internal/shared-runtime-compiler/deployments/:id/failed
```

Platform middleware must authenticate the compiler and set
`sharedModdedCompilerPrincipal`; without it both endpoints reject requests.
The compiler may also report a structured `compile_failed` callback. This
durably marks only that deployment failed; it cannot alter selected content or
the current world revision.

## Release acceptance

Exercise Java 8 Forge, Java 16 Forge/Fabric, Java 17 Fabric, Java 21
NeoForge/Fabric, and a current Java 25 official-requirement fixture
through import, compile, publish, start, local health, external connect,
stop/sync, and restart on another node. Verify the customer container has no
outbound network and no storage credentials throughout.
