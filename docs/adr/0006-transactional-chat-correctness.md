# ADR 0006: Transactional chat correctness

Status: accepted  
Date: 2026-07-23

## Context

Current message correlation is optional and ephemeral. REST has no idempotency key, the database
does not store one, authorization/match checks happen before the message transaction, notification
creation happens afterward, and the correlation value is attached to a canonical message event
sent to every subscriber.

Like/unlike serializes one profile pair, but send and reaction do not use that lock. Read
monotonicity is decided by an application read-then-write. REST exposes only viewer read state,
there is no authoritative profile unread aggregate, unlike does not broadcast its committed
conversation state, and reply projections contain only a target ID.

## Decision

Message send requires a persisted idempotency key through both REST and WebSocket. The key is
scoped to the authenticated actor/command and stores a fingerprint of the normalized command,
status, and canonical result. Same-key/same-fingerprint replay returns the stored result;
same-key/different-fingerprint reuse returns `409 Conflict`.

One PostgreSQL transaction performs:

1. idempotency claim or stored-result lookup;
2. authorization and current match check under the common profile-pair/conversation lock;
3. message and reply validation/insertion;
4. sender read and conversation projection mutation;
5. canonical notification mutation;
6. scoped durable event and delivery-job insertion;
7. idempotency-result completion.

Like, unlike, rematch, send, and reaction use the same deterministic pair/conversation locking
order. Every committed unlike/rematch emits conversation and profile-scope upserts for affected
participants.

Read advancement is a database-conditional comparison of `(messageCreatedAt, messageId)`. REST
returns authorized participant read positions; conversation-scope read events are durable.
Profile-scope unread aggregate state has a canonical REST endpoint and durable event.

`ChatMessage` includes a bounded reply summary suitable for REST and events. It contains no
permanent media URL. Canonical message events exclude caller tokens. REST responses and
origin-only WebSocket acknowledgements carry correlation/idempotency outcomes.

## Consequences

- Automatic resend becomes safe only after this ADR's acceptance gates ship.
- A notification cannot be committed separately from the message that caused it.
- Match-state races resolve to a valid serial order instead of a stale check.
- Read state cannot regress under concurrent or delayed acknowledgements.
- Peer read, unread badges, reply display, and unlike/rematch recovery no longer require
  best-effort client reconstruction.
- Idempotency/correlation values are private to the command origin and operational records.
