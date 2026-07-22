# M7 compliance and operations v1

M7 exposes independently authenticated MFA administrator endpoints. It publishes
and consumes the shared v1 administrator-operation events by reference; only
M3 handles cash adjustments and only M4 handles server suspension or restore.
Audit responses are sanitized and never include provider credentials, payment
details, worker tokens, or world content.
