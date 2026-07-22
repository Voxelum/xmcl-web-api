# M4 server control publication proposal v1

This proposal is owned by M4 and is submitted to the shared contract owner for
publication. It does not modify `contracts/`.

It consumes `contracts/shared/v1` read-only:

- D1/D4 storage policy/accounting remain M2/M6-owned; M4 only requests M6
  deletion confirmation.
- D2 authorizes `server_time`; M4 binds each active lease to its authorization.
- D3 canonical usage is produced by M5, never M4.
- D5 uses shared `runtime.stopped.v1`; M4 force-stops after 300 seconds.
- D6 consumes `server_suspend`/`server_restore` and publishes an M4 completion.

Public responses never include Vultr tokens, provider resource IDs, raw provider
bodies, authorization IDs, or worker credentials.

