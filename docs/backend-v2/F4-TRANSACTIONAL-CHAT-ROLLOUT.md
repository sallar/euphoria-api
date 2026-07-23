# F4 transactional chat correctness and rollout

Status: implementation record; production activation blocked on the protocol 2 client and F5
delivery worker  
Date: 2026-07-24  
Applies to: migrations `20260723220755_f4_transactional_chat_correctness` and
`20260723233434_chat_reply_summary_preview_optional`

F4 routes chat mutations through the F3 PostgreSQL transaction APIs. PostgreSQL owns the command
claim, chat domain state, read and conversation projections, canonical notification state,
durable events, delivery rows, jobs, and terminal command result. Redis, socket delivery, APNs,
and Expo are not part of the commit.

## Command identity and public cutover

Message send uses one command identity:

| Property                      | Approved value                                      |
| ----------------------------- | --------------------------------------------------- |
| F3 command name               | `chat.message.send`                                 |
| Command version               | `1`                                                 |
| Stored result wrapper version | `1`                                                 |
| F3 authority                  | `(actorUserId, commandName, idempotencyKey)`        |
| REST key                      | required `Idempotency-Key` header                   |
| WebSocket key                 | required `idempotencyKey` field                     |
| Accepted key syntax           | canonical lowercase RFC 4122 UUID                   |
| Completed-command retention   | `2_592_000` seconds (30 days), from PostgreSQL time |

Wire/schema validation happens before an F3 claim. Missing and malformed keys do not create a
record. Message validation trims text before deciding whether it is empty or over the existing
4,000-character bound. Once a key is claimed, inaccessible conversations, unmatched
conversations, and invalid reply targets are terminal `rejected` outcomes. Their original status
and `{code, message}` are stored and replayed.

The fingerprint binds the F3 command name/version to this normalized JSON object:

```json
{
  "conversationId": "uuid",
  "actorProfileId": "uuid",
  "text": "trimmed text",
  "replyToMessageId": null
}
```

`replyToMessageId` is explicitly `null` when absent. Neither `clientMessageId` nor the
idempotency key is in the fingerprint. A same-actor, same-key, same-fingerprint retry through
REST, WebSocket, reconnect, or concurrent execution returns the stored canonical result without
another mutation. A changed value or command version returns `idempotency_conflict`.
Authenticated users using the same raw key are independent and cannot observe one another's
claim.

REST success and success replay both return `201` with the exact stored `ChatMessage`.
`Idempotency-Replayed: false` identifies the first terminal result and `true` identifies a replay.
A visible nonterminal claim returns `409 idempotency_in_progress` with `Retry-After: 1`.

WebSocket retains `type: "send_message"` and returns this result only to the command origin:

```json
{
  "type": "send_message_result",
  "command": "chat.message.send",
  "commandVersion": 1,
  "idempotencyKey": "10000000-0000-4000-8000-000000000042",
  "clientMessageId": "optional-origin-correlation",
  "replayed": false,
  "result": {
    "status": "succeeded",
    "message": {}
  }
}
```

The result discriminator is `succeeded` with the canonical message or `rejected` with the stable
error. `clientMessageId` is optional correlation only. A replay sends only this origin result; it
does not emit another canonical event. Canonical socket and durable events contain neither
correlation nor idempotency fields.

This is a strict greenfield cutover to realtime protocol `2` and contract `2.0.0`. No key is
derived from a correlation value, request body, or connection. Protocol 1 message send is not
served by this implementation. F6 may add resume/replay to protocol 2 without changing this
command boundary.

## Atomic message transaction

`runIdempotentCommand` opens the transaction. A first execution performs these operations in
order:

1. insert the actor/command/key claim and compute the normalized fingerprint;
2. locate the conversation only to resolve its canonical profile pair;
3. take the common pair advisory lock and then lock the conversation row;
4. recheck active F2 membership and participant authorization;
5. recheck both current `like` rows while the pair lock is held;
6. validate the reply target in the same conversation and create its persisted summary snapshot;
7. insert the message;
8. advance the sender read position to the database message position;
9. update `chat_conversation.last_message_at` and `updated_at`;
10. create one canonical message notification per recipient profile member other than the sender;
11. create one legacy `push` delivery per enabled recipient token and enqueue one minimal F3 job
    per delivery;
12. load both conversation projections and authoritative unread aggregates;
13. append all ordered, scoped events with one causal UUID;
14. store the versioned canonical command outcome and 30-day expiry.

Any error before commit rolls back the claim, message, read state, conversation projection,
notification and delivery rows, job rows, events, newly allocated scope metadata, and terminal
outcome. The failure-injection test covers every named boundary from claim through outcome
persistence.

Post-commit code may send process-local socket hints. It cannot change the committed result and
does not call Redis or a push provider. A replay skips all canonical socket hints.

### JSONB compatibility correction

The Bun SQL driver natively encodes JavaScript JSON values. Drizzle's standard PostgreSQL JSONB
mapper pre-encoded the same values, which could physically store an object as a JSON string. F4
uses a Bun-aware mapper for existing JSONB columns without changing their PostgreSQL types. The
F4 migration converts valid pre-encoded F3 command results, event/job payloads, notification data,
delivery metadata, and message attachments back to their original JSON value. This preserves the
logical F3 contents while allowing PostgreSQL payload operators and the F5 job reference lookup
to work.

The forward compatibility migration
`20260723233434_chat_reply_summary_preview_optional` changes only mutable
`chat_message.reply_summary` JSONB. Deleted and unavailable summaries lose the `preview` key.
Available summaries retain an object preview; a missing, null, or non-object preview is
conservatively changed to `unavailable` and has the key removed. The update guards non-object
summary values and is idempotent in effect. It does not rewrite completed command results,
durable-event payloads, scope metadata, jobs, or notification state.

## Common chat/match lock

Like, unlike, rematch, send, and reaction calculate the sorted profile pair first. They acquire:

1. `pg_advisory_xact_lock(hashtextextended('chat-profile-pair:<lower>:<higher>', 0))`;
2. the existing `chat_conversation` pair row with `FOR UPDATE`, when present.

Every path uses this order. F2 membership and profile-pair invariants remain unchanged. Send and
reaction recheck current match state only after acquiring the lock. If chat wins, it commits
before unlike; if unlike wins, chat returns `conversation_not_matched` and commits no mutation.
One transaction never acquires two pair locks, preventing pair-order inversion.

Every unlike or rematch affecting an existing historical conversation writes
`chat.conversation.state` plus one participant-specific `chat.conversation.upsert` in each profile
scope, including repeated decisions. The public unlike response remains compatible.

## Durable event contract

Every F4 event has `eventVersion: 1`, 30-day retention, PostgreSQL timestamps, and a resulting-state
payload. One transaction uses one causal UUID across all affected scopes. Ordering exists only
inside a scope; each scope retains its independent permanent F3 sequence.

| Event                      | Scope                                | Payload                                                                         |
| -------------------------- | ------------------------------------ | ------------------------------------------------------------------------------- |
| `chat.message.created`     | `chat-conversation/{conversationId}` | `{ conversationId, message: ChatMessage }`                                      |
| `chat.reaction.state`      | `chat-conversation/{conversationId}` | `{ conversationId, messageId, reactionCounts, actorProfileId, emoji, reacted }` |
| `chat.conversation.state`  | `chat-conversation/{conversationId}` | `{ conversationId, isMatched, updatedAt }`                                      |
| `chat.conversation.read`   | `chat-conversation/{conversationId}` | `{ conversationId, position: ChatParticipantReadPosition }`                     |
| `chat.conversation.upsert` | `chat-profile/{profileId}`           | `{ profileId, conversation: ChatConversation }`                                 |
| `chat.unread.aggregate`    | `chat-profile/{profileId}`           | `{ profileId, count }`                                                          |
| `notification.created`     | `notification-user/{userId}`         | `{ notification: Notification, unreadCount }`                                   |

Conversation-scope send order is `chat.message.created` then the sender's
`chat.conversation.read`. Within a profile scope, `chat.conversation.upsert` precedes
`chat.unread.aggregate` when both exist. Unlike/rematch writes the conversation state and the two
profile upserts. Reaction writes one state event only when the row actually changes; adding an
existing reaction or removing an absent reaction is a successful no-op. Notification-user scope
writes `notification.created`.

Payloads contain no command body, key, correlation value, token, provider credential, or
permanent media URL. F4 does not expose replay, change subscription behavior, or publish these
events through Redis; F6 owns that consumer side.

## Reads, unread truth, and reply summaries

`chat_conversation_read_state` persists both parts of the ordered position:
`(last_read_message_created_at, last_read_message_id)`. The conditional upsert sources the
timestamp directly from PostgreSQL so JavaScript millisecond conversion cannot lose database
microseconds. Only a greater tuple updates the row. Equal, delayed, and concurrently older
acknowledgements are no-ops.

Every `ChatConversation` retains the viewer-oriented `readState` and adds exactly two
`participantReadPositions`, sorted by profile UUID:

```text
profileId
lastReadMessageId | null
lastReadMessageCreatedAt | null
lastReadAt | null
```

Only an active participant can recover this state. An unrelated user receives the existing
concealed `conversation_not_found`.

`GET /api/chat/profiles/:profileId/unread-count` returns `{count}` from a direct PostgreSQL count
over all incoming messages newer than each conversation's complete read position. It does not
page conversations. Historical unmatched conversations continue contributing while their
history remains accessible; unlike makes history read-only and does not mark it read.

`ChatMessage.replySummary` is nullable and contains:

```text
messageId
senderProfileId | null
messageType: text | image
state: available | deleted | unavailable
preview, present only when state is available:
  {kind: text, text, truncated} | {kind: image}
```

Text is bounded to 160 Unicode extended grapheme clusters with `Intl.Segmenter`. The snapshot is
stored when the reply is created. It has no display name or media URL. `replySummary` itself
remains required-nullable, so non-reply messages contain `"replySummary": null`. Available text
and image summaries always contain their corresponding non-null preview. A soft-deleted target
projects `deleted` and omits `preview`. A target outside retained history, or malformed legacy
available state without a valid preview, projects `unavailable` and omits `preview` while
retaining its stored ID, sender reference, and type. P4 remains responsible for future privacy
redaction or erasure.

This staging-only protocol-2 correction keeps AsyncAPI contract `2.0.0` and realtime protocol
`2`: protocol 2 has not shipped to a supported production client, so the generator-compatible
optional non-null preview shape is corrected before release rather than creating another protocol
generation.

## Notification and job producer

A notification-worthy text message always creates canonical notification state, including while
the recipient has an active conversation socket. In-app state is the notification row plus its
`notification.created` durable event; F4 creates no legacy `in_app` delivery.

For each enabled push token F4 creates:

- one legacy `notification_delivery` row with channel `push`;
- one F3 job:

```json
{
  "jobKind": "notification.push.deliver",
  "jobVersion": 1,
  "payload": {
    "notificationDeliveryId": "uuid"
  },
  "availableInSeconds": 0,
  "maxAttempts": 8,
  "terminalRetentionSeconds": 2592000
}
```

The payload contains no token, message body, notification projection, or provider credential.
Availability uses PostgreSQL time. The future F5 worker must load the delivery, notification, and
current token state from PostgreSQL. Its approved lease is 60 seconds and provider timeouts must
remain safely below it unless F5 adds renewal.

F4 starts no worker and performs no APNs or Expo I/O. It does not choose backoff, jitter,
`Retry-After`, retryability, terminal-provider, receipt, unknown-outcome, or push-suppression
policy. Existing non-F4 notification producers and APNs/Expo acceptance semantics remain
unchanged.

## Stable public errors

F4 uses `ApiErrorResponse` with `{code, message}`:

| Situation                                            | HTTP | Code                       |
| ---------------------------------------------------- | ---: | -------------------------- |
| Missing idempotency key                              |  400 | `idempotency_key_required` |
| Malformed idempotency key                            |  400 | `invalid_idempotency_key`  |
| Same actor/key with a changed fingerprint            |  409 | `idempotency_conflict`     |
| Existing nonterminal claim                           |  409 | `idempotency_in_progress`  |
| Inaccessible/nonparticipant conversation             |  404 | `conversation_not_found`   |
| Accessible but unmatched conversation                |  409 | `conversation_not_matched` |
| Missing/inaccessible/deleted reaction target         |  404 | `message_not_found`        |
| Empty, oversized, or invalid reaction                |  422 | `invalid_reaction`         |
| Missing, deleted, or cross-conversation reply target |  422 | `invalid_reply_target`     |
| Trimmed-empty, oversized, or invalid message text    |  422 | `invalid_message`          |

WebSocket command errors use the same codes. Key/correlation fields, when available, occur only on
the origin error/result. Concealed `404` responses do not distinguish absent from inaccessible
state.

## Cleanup, observability, and failure injection

Run `bun run chat:durability:cleanup` hourly with an explicitly reviewed positive
`CHAT_DURABILITY_CLEANUP_BATCH_SIZE`. One invocation deletes at most one bounded command batch and one bounded
event prefix batch. It uses the F3 cleanup APIs and PostgreSQL time, never deletes nonterminal
claims, never resets scope sequences, and never deletes scope metadata.

The command emits one payload-free structured metric record containing deleted counts, expired
backlog counts, and oldest cleanup lag for commands and events. Production dashboards and alerts
must also cover:

- message command result counts by status/code/version and old nonterminal claim age;
- conflict/in-progress/replay rates without logging keys or fingerprints;
- transaction rollback count by failure boundary;
- common-lock wait duration and PostgreSQL deadlocks;
- event append count, sequence/floor lag, and expiry backlog by scope/event type;
- notification, push-delivery, and pending-job counts;
- unread REST/database/event mismatch sampling;
- post-commit socket-hint failures separately from transaction failures.

Failure injection names the claim, lock, authorization, match, reply, message, sender-read,
conversation, notification, job, event, and outcome boundaries. Integration tests compare every
affected table and projection before and after each injected failure.

## Production rollout and rollback

Production activation requires all of these preconditions:

1. F1 cursor and F2 ownership migrations/gates remain green.
2. F3 migrations and the F4 migration are applied. The migration converts valid double-encoded
   JSONB values, removes the read-message foreign key, backfills exact read timestamps, adds the
   tuple consistency check, and adds reply snapshots. Existing reply rows are conservatively
   marked `unavailable`; no historical event is fabricated. The reply-summary compatibility
   migration then removes legacy null preview keys and downgrades malformed available summaries
   in mutable message rows without rewriting immutable command or event history.
3. The protocol 2 client is deployed for the coordinated strict cutover and always persists a
   canonical UUID key before sending.
4. The F5 worker is implemented, verified, and ready to consume
   `notification.push.deliver` version 1. F4 must not produce production jobs before then.
5. Production supplies these reviewed values explicitly:

```text
CHAT_COMMAND_RETENTION_SECONDS=2592000
CHAT_EVENT_RETENTION_SECONDS=2592000
NOTIFICATION_PUSH_JOB_AVAILABLE_IN_SECONDS=0
NOTIFICATION_PUSH_JOB_MAX_ATTEMPTS=8
NOTIFICATION_PUSH_JOB_TERMINAL_RETENTION_SECONDS=2592000
CHAT_DURABILITY_CLEANUP_BATCH_SIZE=<reviewed-positive-integer>
```

6. An hourly scheduler supplies the reviewed bounded cleanup batch size, metrics are scraped, and
   alerts/ownership are active.
7. OpenAPI `2026-07-24`, AsyncAPI `2.0.0`, and protocol `2` are published before write traffic is
   admitted.

Do not dual-write or fall through to the unsafe legacy send. Without a key, the request receives
the stable error. Until the client and F5 are ready, leave production on the pre-F4 application
and do not set the transactional chat producer policy.

Before the first F4 write, application rollback may use the prior binary after reverting the code
deployment. After any F4 command/event/job exists, do not drop F3/F4 state or reuse sequence
metadata. Stop new chat writes, keep PostgreSQL rows, and roll forward. Returning to a
non-idempotent legacy writer after accepting protocol 2 retries is unsafe. A socket-hint or future
worker outage does not require domain rollback because PostgreSQL remains complete.

## F5 handoff

F5 should implement only the approved job consumer and notification delivery semantics on this
producer:

- claim `notification.push.deliver` version 1 with a 60-second lease;
- load the delivery, notification, and current enabled token from PostgreSQL;
- keep provider timeouts below the lease or add fenced renewal;
- define retry/backoff/jitter, provider `Retry-After`, terminal classification, Expo receipt
  polling, APNs/Expo invalid-token handling, unknown-outcome review, and dead-letter alerting;
- preserve canonical notification rows/events and add cross-device read/archive/count semantics.

F5 must not change the F4 command identity, normalization, common lock, event payloads, or
origin-only acknowledgement.
