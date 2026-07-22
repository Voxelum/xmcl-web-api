# M4 Vultr server control v1

M4 is the sole writer of server resources, tasks, leases, and provider
reconciliation state. Public responses exclude provider resource identifiers,
credentials, tokens, and raw provider error bodies.

This version consumes shared v1 authorization and administrator-operation
contracts. M4 binds an active lease to M3 authorization, M5 alone records
canonical `server_time`, M4 force-stops after the shared 300-second timeout,
and it consumes only `server_suspend` and `server_restore` commands.
