# Shared modded runtime compiler deployment

The shared-hosting modded path is intentionally fail-closed. It is not enabled
by the existing public shared-hosting gate until all dependencies below are
installed.

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
```

Platform middleware must authenticate the compiler and set
`sharedModdedCompilerPrincipal`; without it both endpoints reject requests.

## Release acceptance

Exercise Java 8 Forge, Java 16 Forge/Fabric, Java 17 Fabric, Java 21
NeoForge/Fabric, and a current Java 25 official-requirement fixture
through import, compile, publish, start, local health, external connect,
stop/sync, and restart on another node. Verify the customer container has no
outbound network and no storage credentials throughout.
