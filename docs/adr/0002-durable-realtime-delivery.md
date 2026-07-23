# ADR 0002: Durable realtime delivery and recovery

Status: accepted  
Date: 2026-07-23

## Context

Protocol v1 emits best-effort events from process memory and instructs clients to reconcile all
state through REST after reconnect. That is correct for the current implementation but does not
scale or support efficient recovery.

## Decision

Durable socket events use ordered at-least-once delivery within one of three scopes:

- `chat-profile/{profileId}`;
- `chat-conversation/{conversationId}`;
- `notification-user/{userId}`.

Each scope has a PostgreSQL-allocated monotonic sequence. Events also have globally unique event
IDs, typed/versioned payloads, timestamps, and retention metadata. Clients deduplicate by event ID
and `(scope, sequence)`. There is no cross-scope ordering guarantee.

Presence and typing are ephemeral. They use leases/snapshots, carry no durable sequence, and may be
lost, duplicated, or reordered.

REST remains canonical. Initial sync and explicit repair use a REST snapshot with a scope
high-water mark. Ordinary reconnect uses replay after the client's last applied sequence. Full
REST repair is reserved for `resync_required`, a detected sequence/integrity failure, or explicit
refresh.

Command acknowledgements and caller correlation are origin-only. They are not stored in the
durable event stream and must never appear in canonical peer/replay events.

## Race-free handoff

For each scope, the server subscribes to live fan-out first, buffers events, reads high-water mark
`H` in the same consistent PostgreSQL snapshot as the state snapshot or retained replay, sends
state/events through `H`, discards buffered duplicates at or below `H`, and then drains events
above `H` in order. A detected sequence gap pauses live delivery and is filled from PostgreSQL.

If the requested sequence is below the retained floor, ahead of `H`, belongs to another
scope/version, or cannot be repaired, the server returns `resync_required` with the retention floor
and current high-water mark. The client replaces state from REST and resumes after the returned
snapshot sequence.

## Connection registry and leases

Every socket is registered by authenticated session ID, user, optional active profile, node, and
connection ID. Sign-out, revocation, and session expiry close only that session's sockets across
all nodes.

Connections, subscriptions, presence, and typing use expiring Redis leases renewed by heartbeat.
Nodes also publish heartbeats. Stale-node cleanup removes its leases. Presence is the aggregate of
live leases across healthy nodes. Typing is aggregated per profile/conversation; disappearance or
expiry of the final lease emits `typing=false`.

Redis outage can remove advisory leases or fan-out hints, but PostgreSQL commits continue. Sockets
either recover leases/fan-out or close safely and replay. Redis is never authoritative for event
history, authorization, idempotency, or domain state.

## Protocol safety and close semantics

The protocol declares and enforces:

- bounded subscriptions per socket;
- per-command/session/profile/IP rate limits;
- frame and decoded-payload limits;
- bounded output queues by message count and bytes;
- no coalescing/dropping of durable events;
- slow-consumer closure with a documented retryable code and resume position;
- intentional, terminal-until-input-change, and retryable close classifications;
- capabilities, authorization, subscription transitions, resume scopes, limits, and
  durable/ephemeral event classes in AsyncAPI.

Logs and metrics cover leases, nodes, queues, rate limits, replay/resync, Redis availability,
revocation latency, and slow consumers without credentials, private payloads, or high-cardinality
private identifiers.

## Consequences

- Duplicates are expected; permanent gaps are not.
- Client reducers and stored sequence advancement must be idempotent and atomic from the client's
  perspective.
- Protocol v2 is additive and coexists with v1 during rollout.
- Redis pub/sub is a latency mechanism, not replay storage.
- Retention duration becomes an explicit product/operations setting with resync-rate monitoring.
- Intentional/terminal closes cannot reconnect-loop; retryable failures retain resume state and
  use bounded jittered backoff.
- A slow or abusive client cannot create unbounded subscription, CPU, memory, frame, or output
  growth.
