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

REST accepts only a required `Idempotency-Key` header and WebSocket accepts only a required
`idempotencyKey` field. The accepted value is a canonical lowercase RFC 4122 UUID. The internal
identity is `chat.message.send` version `1`; the WebSocket command discriminator remains
`send_message`. The F3 authority remains
`(actorUserId, commandName, idempotencyKey)`, so the same raw key used by different authenticated
users is independent.

The normalized request is `{conversationId, actorProfileId, text, replyToMessageId}`, where text
is trimmed and an absent reply target is explicit `null`. F3 binds the command version outside
that object when creating its fingerprint. `clientMessageId` and the key are not fingerprint
inputs. Completed outcomes remain authoritative for 30 days and store a version-1 inline wrapper
containing the canonical `ChatMessage` or stable rejected error. PostgreSQL time sets the
retention boundary.

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

The lock is a transaction-scoped advisory lock over the sorted profile pair followed by
`FOR UPDATE` on the pair's conversation row. Authorization and both current `like` decisions are
rechecked after the lock. A reaction no-op succeeds without an event.

Read advancement is a database-conditional comparison of `(messageCreatedAt, messageId)`. REST
returns authorized participant read positions; conversation-scope read events are durable.
Profile-scope unread aggregate state has a canonical REST endpoint and durable event.

`ChatMessage` includes a bounded reply summary suitable for REST and events. It contains no
permanent media URL. Canonical message events exclude caller tokens. REST responses and
origin-only WebSocket acknowledgements carry correlation/idempotency outcomes.

The reply snapshot contains target ID, nullable sender profile ID, message type, state, and either
a 160-extended-grapheme text preview, an image discriminator, or `null`. Deleted and unavailable
targets expose no preview. The snapshot deliberately contains no display name or media URL.

The approved event families are `chat.message.created`, `chat.reaction.state`,
`chat.conversation.state`, `chat.conversation.read`, `chat.conversation.upsert`,
`chat.unread.aggregate`, and `notification.created`, all version `1`. They use only
`chat-conversation`, `chat-profile`, and `notification-user` scopes. One transaction shares one
causal UUID while each scope allocates its own sequence. Event retention is 30 days.

Message notifications always create canonical state, even for an active conversation viewer.
Each enabled token receives one legacy `push` delivery and one
`notification.push.deliver` version-1 job containing only `{notificationDeliveryId}`. Availability
is immediate, maximum lifetime attempts are 8, and terminal retention is 30 days. F4 creates no
legacy `in_app` delivery and performs no provider I/O. F5 owns the approved 60-second worker lease
and all retry, timeout, terminal-provider, receipt, and push-suppression policy.

REST returns `201` for both first success and replay, with `Idempotency-Replayed: true|false`.
WebSocket returns `send_message_result` only to the origin, with its optional correlation value
and key. A replay emits no canonical event. Realtime protocol is `2` and the AsyncAPI contract is
`2.0.0`; this greenfield rollout is a coordinated strict cutover, not a compatibility fallback.

Command and event cleanup run hourly in bounded operator-configured batches. Cleanup uses
PostgreSQL time, reports backlog/lag metrics, never cleans nonterminal claims, and preserves
permanent event-scope metadata.

## Consequences

- Automatic resend becomes safe only after this ADR's acceptance gates ship.
- A notification cannot be committed separately from the message that caused it.
- Match-state races resolve to a valid serial order instead of a stale check.
- Read state cannot regress under concurrent or delayed acknowledgements.
- Peer read, unread badges, reply display, and unlike/rematch recovery no longer require
  best-effort client reconstruction.
- Idempotency/correlation values are private to the command origin and operational records.
- Production activation is blocked until the protocol 2 client and F5 delivery worker are ready.
- Once F4 writes exist, rollback preserves F3/F4 rows and scope sequences; falling back to the
  non-idempotent legacy writer is unsafe.
