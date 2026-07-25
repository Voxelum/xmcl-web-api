# Multiplayer v2 client and UX handoff

## Purpose

Implement the launcher side of Cloudflare multiplayer v2. The desired user
experience is invite-based joining with automatic direct WebRTC negotiation and
transparent TURN fallback. Users must not need to understand WebSocket, ICE,
NAT, port forwarding, or relay servers.

This handoff targets the Host-star protocol implemented by the web API. It does
not describe the legacy `/group/:id` full-mesh discovery protocol.

## Product model

The player sharing the world is the **Host**. Every Guest creates exactly one
WebRTC connection to the Host:

```text
Guest A ─┐
Guest B ─┼── WebRTC ── Host / Minecraft LAN server
Guest C ─┘
```

Guests never discover, signal, or connect to one another. The Host already owns
the Minecraft server endpoint, so routing Guest game traffic through another
Guest has no product benefit.

Cloudflare is the control plane:

- HTTP authenticates room creation, admission, and closure.
- One Durable Object owns each room.
- The Host keeps one hibernating control WebSocket.
- A Guest WebSocket exists only during WebRTC negotiation.
- Game traffic uses direct WebRTC where possible and Cloudflare TURN otherwise.
- Game traffic never passes through the Durable Object.

## Public API

All HTTP requests require a valid XMCL session with `account:read`.

### Create a room

```http
POST /v2/multiplayer/rooms
Authorization: Bearer <xmcl-session>
Content-Type: application/json

{
  "displayName": "Steve",
  "maxPeers": 8
}
```

The response contains:

- `roomId`;
- `socketUrl`;
- a five-minute, single-use Host `ticket`;
- `peerId`;
- ticket `expiresAt`.

The Host must connect the control WebSocket immediately. A created room is not
joinable until that socket reaches `host-ready`.

### Join or restore a room connection

```http
POST /v2/multiplayer/rooms/:roomId/join
Authorization: Bearer <xmcl-session>
Content-Type: application/json

{
  "displayName": "Alex"
}
```

The service returns a Guest ticket for normal players. If the authenticated
account owns the room, it returns a Host ticket; this is how the Host restores
its control socket after an interruption.

### Connect signaling

```text
GET /v2/multiplayer/rooms/:roomId/socket?ticket=<ticket>
Upgrade: websocket
```

Tickets are single-use. Every retry must call the join endpoint for a fresh
ticket.

### Close a room

```http
DELETE /v2/multiplayer/rooms/:roomId
Authorization: Bearer <xmcl-session>
```

Only the owning account can close the room.

## Host client state machine

```text
idle
  → creating-room
  → connecting-control
  → ready
  ↔ restoring-control
  → closing
  → closed
```

### `creating-room`

1. Call the create endpoint.
2. Store `roomId` only for the lifetime of the sharing session.
3. Do not display a shareable invitation as ready yet.
4. Proceed immediately to `connecting-control`.

### `connecting-control`

1. Open the returned WebSocket with the Host ticket.
2. Wait for:

```json
{
  "type": "host-ready",
  "self": {},
  "guests": [],
  "revision": 1
}
```

3. Only after `host-ready`, enable copy-invite and display the room as joinable.

### `ready`

The Host control WebSocket remains open. Do not send periodic application-level
identity broadcasts or heartbeats. Cloudflare WebSocket Hibernation keeps the
connection available without continuously running the Durable Object.

On `join-request`:

1. Create one `RTCPeerConnection` for that `guest.peerId`.
2. Obtain Cloudflare STUN/TURN configuration from the existing RTC API.
3. Create the game DataChannel.
4. Create and set the local offer.
5. Send the offer as a targeted `signal` message.
6. Forward trickle ICE candidates as targeted `signal` messages.
7. Apply the Guest answer and candidates received from `signal`.

Example Host signal:

```json
{
  "type": "signal",
  "receiver": "<guest-peer-id>",
  "payload": {
    "description": {
      "type": "offer",
      "sdp": "..."
    }
  }
}
```

The service derives `sender` from the authenticated socket attachment. The
client must never supply or trust a caller-provided sender identity.

On `guest-connected`, mark that Guest as connected in the UI.

When a Guest DataChannel or peer connection reaches a terminal failed/closed
state, send:

```json
{
  "type": "guest-left",
  "peerId": "<guest-peer-id>"
}
```

For a Host-initiated removal, send:

```json
{
  "type": "kick",
  "peerId": "<guest-peer-id>"
}
```

The Host owns the authoritative connected-player projection after signaling
completes because Guest signaling sockets are intentionally closed.

### `restoring-control`

A control WebSocket interruption does not immediately destroy established
WebRTC connections.

1. Keep all healthy WebRTC connections alive.
2. Call the join endpoint using the Host's authenticated account.
3. Open a new control WebSocket with the returned Host ticket.
4. Reconcile the `guests` array from the new `host-ready` snapshot with local
   peer connections.
5. Send `guest-left` for stale entries that no longer have a local WebRTC
   connection.

The server allows 30 seconds for this restoration. Retry quickly with short
jittered delays, for example 0 ms, 500 ms, 1 s, 2 s, and 4 s. Stop when the room
is reported closed or the grace period expires.

### `closing`

When the Host stops sharing:

1. Call the delete endpoint.
2. Close all Guest WebRTC connections.
3. Close the control socket.
4. Clear room state and invitations locally.

Do not rely on closing the control WebSocket alone; an accidental network
interruption receives a reconnect grace period.

## Guest client state machine

```text
idle
  → validating-room
  → contacting-host
  → negotiating
  → connected
  ↔ reconnecting
  → failed | left
```

### `validating-room`

1. Normalize the pasted invitation or room ID.
2. Call the join endpoint.
3. Map API errors to user-facing states:

| API result | Client meaning |
| --- | --- |
| `401` | XMCL session expired; authenticate again |
| `404` | Room does not exist or has expired |
| `409 Host unavailable` | Host is temporarily reconnecting |
| `409 Room full` | No Guest slot is available |
| `410` | Room is closed |

### `contacting-host`

Open a temporary WebSocket with the Guest ticket. Wait for:

```json
{
  "type": "negotiation-started",
  "self": {},
  "hostPeerId": "...",
  "revision": 2
}
```

Then wait for the Host's offer. A Guest must not create connections to any peer
other than `hostPeerId`.

### `negotiating`

1. Create one `RTCPeerConnection`.
2. Apply the Host offer.
3. Create and set the local answer.
4. Send the answer and trickle ICE using `signal`.
5. Ignore any signal whose server-supplied sender is not `hostPeerId`.
6. Wait for the peer connection and DataChannel to become usable.
7. Send:

```json
{
  "type": "rtc-ready"
}
```

The service replies with `rtc-ready` and closes the Guest WebSocket normally.
Treat close code `1000` after that acknowledgement as successful signaling, not
as leaving the room.

### `connected`

Keep only:

- the WebRTC peer connection to the Host;
- the game DataChannel;
- local UI/session metadata.

Do not reopen or poll the signaling WebSocket while WebRTC remains healthy.

If the DataChannel closes or WebRTC remains `failed`:

1. Dispose of the old peer connection.
2. Return to `reconnecting`.
3. Call join for a new ticket.
4. Repeat temporary signaling.

## ICE and TURN behavior

Use normal ICE gathering with host, server-reflexive, and relay candidates.
Do not disable TURN while trying to prefer direct connectivity; ICE candidate
selection already prefers better paths.

Recommended experience thresholds:

| Elapsed time | User-visible behavior |
| ---: | --- |
| 0-3 seconds | Establishing a direct connection |
| 3-8 seconds | Continue ICE negotiation without changing UI severity |
| About 8 seconds | Show that a relay may be used if direct connectivity is unavailable |
| 15 seconds | Fail the attempt and offer retry |

These are UX thresholds, not instructions to discard valid ICE candidates.
Actual timers should respect browser/runtime ICE state.

Expose connection path after connection:

- **Direct** when the selected candidate pair does not use a relay candidate.
- **Relay** when either selected candidate is `relay`.

Use `RTCPeerConnection.getStats()` to identify the selected candidate pair,
round-trip time, bytes sent/received, and relay usage.

## User experience

### Host room view

The primary UI should contain:

```text
Multiplayer room
Invite: ABCD-EFGH                       [Copy] [Invite]

Ready for players
3 / 8 players

Alex       Connected · Direct · 42 ms  [Remove]
Steve      Connected · Relay · 96 ms   [Remove]

                                            [Stop sharing]
```

Required Host states:

- **Starting room...**
- **Ready for players**
- **Reconnecting room control...**
- **Room closed**

Disable invitation actions until `host-ready`. During control restoration,
keep connected Guests visible and avoid claiming that their game connection is
lost.

### Guest joining view

Progress copy should describe intent rather than implementation:

1. **Checking room...**
2. **Contacting the host...**
3. **Establishing a direct connection...**
4. **Your network requires a relay; connecting...**
5. **Connected to Steve's world**

Do not expose SDP, ICE, NAT, TURN, Durable Objects, or WebSocket terminology in
the normal flow.

Recommended errors:

| Condition | Title | Message | Actions |
| --- | --- | --- | --- |
| Missing/expired room | Room unavailable | This room may have closed or expired. | Back |
| Host reconnecting | Waiting for host | The host is reconnecting. Try again shortly. | Retry, Back |
| Full room | Room is full | The host has no available player slots. | Back |
| Negotiation timeout | Could not connect | Check your network and ask the host to keep the room open. | Retry, Back |
| Host closed room | Host ended sharing | This multiplayer room is no longer available. | Back |
| Authentication expired | Sign in again | Your XMCL session expired before joining. | Sign in, Back |

Relay mode is not an error. Display it as connection information after success,
not as a warning that discourages the player.

## Invitation format

The API currently returns a UUID `roomId`. The first client implementation may
copy a deep link containing that ID, but the visible experience should not
require manually transcribing a UUID.

Preferred forms:

```text
xmcl://multiplayer/join/<room-id>
https://xmcl.app/multiplayer/join/<room-id>
```

The launcher should accept:

- its own deep link;
- the web invitation URL;
- a raw room ID as a compatibility/debug input.

A short human-readable invite code requires a separate collision-safe lookup
design and is not part of this API change.

## Local state and cleanup

Do not persist admission tickets. They are bearer credentials, expire after
five minutes, and are single-use.

Persisting a room ID is unnecessary unless crash recovery is intentionally
implemented. At minimum, clear all multiplayer state when:

- the Host closes the room;
- the server reports the room closed or missing;
- the launcher account changes;
- the game instance exits;
- the user explicitly leaves.

Never log:

- XMCL session tokens;
- admission tickets;
- full SDP bodies;
- TURN credentials.

## Telemetry

Collect privacy-preserving aggregates needed to validate cost and experience:

- room creations;
- join attempts and outcomes;
- time from join submission to WebRTC connected;
- direct versus TURN-selected candidate pair;
- ICE failure category;
- Host control reconnection count and success;
- Guest WebRTC reconnection count and success;
- connected player-minutes;
- TURN bytes and relayed player-minutes where available.

Do not collect room IDs, account IDs, IP addresses, SDP, ICE candidate
addresses, or TURN credentials in product analytics.

The critical operating metrics are:

```text
P2P success rate
TURN fallback rate
p50/p95 join time
reconnect success rate
TURN GB per relayed player-hour
```

TURN usage, not Durable Object signaling, is expected to dominate variable
Cloudflare cost.

## Acceptance criteria

1. The Host opens exactly one control WebSocket per active room.
2. The Host sends no periodic identity broadcast.
3. A Guest opens a signaling WebSocket only while negotiating or reconnecting.
4. The Guest signaling WebSocket closes after `rtc-ready` without closing the
   WebRTC connection.
5. A Guest creates exactly one peer connection, targeting the Host.
6. The Host creates at most one peer connection per admitted Guest.
7. The client never sends or accepts Guest-to-Guest signaling.
8. Healthy WebRTC sessions survive a temporary Host control socket reconnect.
9. Host control restoration completes within the server's 30-second grace
   period or transitions clearly to room-closed UX.
10. Direct and relay paths both produce the same successful join experience.
11. Relay status is visible as diagnostic information but not presented as an
    error.
12. Tickets, session tokens, SDP, ICE addresses, and TURN credentials do not
    appear in logs or telemetry.
13. Leaving, kicking, instance exit, and room closure release all WebRTC and
    WebSocket resources.

## Out of scope

- Guest-to-Guest voice, chat, or game traffic.
- Host migration.
- Dedicated-server ownership transfer.
- Matchmaking or public room discovery.
- A short-code directory.
- SFU topology.
- Relaying Minecraft traffic through the Durable Object.
