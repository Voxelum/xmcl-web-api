# M1 account and identity v1

XMCL sessions use short-lived bearer tokens scoped to opaque account, session,
and family IDs. Tokens are never placed in URLs, renderer persistence, logs, or
events. OAuth callbacks require an exact deployment allowlist match and bind a
one-time transaction, state, nonce, and PKCE verifier. Public identity models
omit provider subjects and credentials.
