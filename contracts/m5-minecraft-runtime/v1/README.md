# M5 Minecraft runtime worker API v1

M5 owns worker credentials, heartbeat and runtime observations, and is the only
producer of `server_time`. It maps raw worker usage to shared v1 canonical
usage using the active lease as `sourceId`, with ordered non-overlapping
intervals. M3 settlement may require a stop; M5 emits the shared stopped event,
while M4 owns the 300-second escalation and lease closure.
