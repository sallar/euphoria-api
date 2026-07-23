# ADR 0004: Notification durability and push semantics

Status: accepted  
Date: 2026-07-23

## Context

Notification and delivery rows are currently created in a PostgreSQL transaction, followed by
in-process socket fan-out and direct provider calls. Chat message notification creation is skipped
for a recipient actively subscribed to the conversation, and provider acceptance is written to a
status named `delivered`.

## Decision

A notification-worthy domain mutation always creates canonical notification state and its
notification-user durable event transactionally. Socket placement and active-view state never
decide whether the notification exists.

An active conversation-view lease may suppress only external push for that conversation and user.
Suppression is advisory, expiring, and recorded with an explicit reason. In-app state, unread
semantics, replay, and other devices remain based on PostgreSQL.

Push and other external delivery use durable PostgreSQL jobs. Provider I/O happens after commit and
is retryable from job state. Workers claim jobs with an owner/expiry lease, bounded attempts,
backoff with jitter, crash-safe reclaim, and a queryable dead-letter terminal state.

Every notification mutation emits an ordered notification-user event with unambiguous resulting
state:

- create/read carries the canonical notification and authoritative unread count;
- archive carries notification ID, archive timestamp, and authoritative unread count;
- read-all carries its scope sequence/timestamp, changed count, and resulting count.

Scope ordering makes a notification created after read-all distinct from the rows affected by that
bulk operation. These events synchronize every device; process-local socket delivery is only a
transport optimization.

An APNs `200` or successful Expo ticket means the provider accepted the request. It is not
confirmed device display or user receipt. New schemas, APIs, metrics, and UI wording use
`provider_accepted` (or equivalent), not `delivered`, unless an actual downstream delivery receipt
exists. The current `delivered` enum is a compatibility debt to migrate safely, not a definition to
carry into v2.

Expo ticket IDs are retained and receipts are polled where available so later provider failures can
be recorded and invalid tokens disabled. APNs has no equivalent device receipt: acceptance remains
acceptance. APNs readiness requires physical-device verification in both sandbox and production,
correct environment/topic routing, invalid/unregistered-token disablement, and retry/crash tests
for throttling, transport, and server failures.

## Consequences

- Opening a conversation can prevent an unnecessary external alert but cannot erase history or
  unread/account state.
- Redis view/subscription leases may optimize suppression, but their loss defaults to attempting
  push rather than losing canonical notification state.
- Expo and APNs registration/provider compatibility is preserved.
- Worker retries can duplicate provider requests; provider idempotency/collapse identifiers and
  recorded attempts must be used where supported.
- Notification read/archive/read-all/count changes converge cross-device through durable ordered
  events, not count-only guesses.
- Provider acceptance, later Expo receipt state, dead-letter state, and any true receipt are
  separate concepts in storage, APIs, metrics, and support tooling.
