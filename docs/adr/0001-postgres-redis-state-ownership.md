# ADR 0001: PostgreSQL and Redis state ownership

Status: accepted  
Date: 2026-07-23

## Context

The API already stores domain data in PostgreSQL, while chat sockets, notification sockets,
subscriptions, and presence are in process-local maps. Backend v2 needs horizontal fan-out and
recovery without creating two sources of truth.

## Decision

PostgreSQL is the only canonical domain store. It owns domain rows, transactional outbox/event-log
records, per-scope durable sequences, replay retention, idempotency records, and durable delivery
jobs and attempts.

Redis is shared ephemeral infrastructure only. Approved uses are:

- cross-node fan-out hints;
- session-ID-scoped connection and subscription routing with TTL leases;
- expiring presence and typing leases;
- session-revocation/invalidation signals.

Redis must not allocate canonical sequences, hold the only copy of an event/job, prove mutation
idempotency, or decide committed domain state. A PostgreSQL commit succeeds independently of Redis
availability. Publishers and workers retry from PostgreSQL.

## Consequences

- Redis loss may temporarily remove presence, subscriptions, or live fan-out, but replay restores
  durable events.
- All dual effects originate in one PostgreSQL transaction, avoiding a PostgreSQL/Redis
  distributed transaction.
- Redis data requires TTLs or connection-lifecycle cleanup and is never backfilled as domain data.
- Node heartbeat and stale-node cleanup are required for aggregate presence/subscription truth, but
  their result remains advisory and rebuildable.
- Operational readiness requires PostgreSQL job/replay lag metrics and Redis ephemeral-health
  metrics with different alert semantics.
- Foundation adds Redis only to integration infrastructure; production runtime wiring is a later
  milestone.
