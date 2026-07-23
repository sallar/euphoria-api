# F3 durable command, event, and job substrate

Applies to: migrations `20260723170425_f3_durable_substrate` and
`20260723172330_f3_failure_code_sanitization`

F3 adds dormant, reusable PostgreSQL primitives. It does not enable a command producer, event
producer, scheduled cleanup, delivery worker, socket replay, or Redis fan-out. F4 and F5 must
provide reviewed production policy before their producers or workers are enabled.

## State ownership and transaction model

PostgreSQL is canonical for all F3 state. Redis is not used for command claims, fingerprints,
sequences, events, jobs, leases, or attempts.

`runIdempotentCommand` opens the command transaction. Its callback receives that transaction and
may write the domain mutation, call `appendDurableEventsInTransaction`, call
`enqueueDeliveryJobInTransaction`, and return the canonical command outcome. Only then is the
idempotency record completed. Any thrown error rolls back the claim, domain rows, scope metadata,
events, jobs, and outcome together.

F3 deliberately does not route existing chat, reaction, notification, APNs, Expo, or socket paths
through these primitives. F4 owns chat atomicity and producer configuration. F5 owns notification
workers and delivery policy.

## Command idempotency

`command_idempotency` is uniquely scoped by:

- authenticated `actor_user_id`;
- `command_name`;
- caller-supplied `idempotency_key`.

`command_version` and the normalized request both participate in the SHA-256 request fingerprint.
The fingerprint has the domain prefix `euphoria-command-fingerprint-v1`. Normalization accepts
JSON values only, recursively sorts object keys, preserves array order, normalizes negative zero,
and rejects cycles, non-plain objects, and non-finite numbers. A producer must normalize
domain-specific values, such as trimmed message text, before calling this generic layer.

A new claim starts as `in_progress`. A successful transaction stores `completed`, either
`succeeded` or `rejected`, and exactly one canonical inline result wrapper or result reference.
PostgreSQL uniqueness serializes concurrent claims. An identical committed duplicate returns the
stored outcome; a different version or fingerprint returns stable `idempotency_conflict` without
executing the callback. A visible nonterminal record returns stable `idempotency_in_progress`.

`created_at`, `completed_at`, and `retention_expires_at` use PostgreSQL time. The caller must supply
an explicit positive retention duration. Expiry is eligibility for cleanup, not a change in
authority: a completed row remains authoritative while present, even after expiry. Cleanup removes
only expired completed rows, so key reuse is possible only after that explicit deletion.
Nonterminal rows have no expiry and are never silently cleaned. The diagnostic query
`listNonterminalIdempotencyDiagnostics` reports old claims without returning their key,
fingerprint, request, or result.

## Durable scoped events

The only accepted scope kinds are:

| Stored kind         | External scope form                       | Authorization source                              |
| ------------------- | ----------------------------------------- | ------------------------------------------------- |
| `chat-profile`      | `chat-profile/{profileId}`                | Current F2 active profile membership, either role |
| `chat-conversation` | `chat-conversation/{conversationId}`      | Current participant through an F2 active profile  |
| `notification-user` | `notification-user/{authenticatedUserId}` | Exact authenticated user                          |

Authorization remains an explicit service operation. Event append is an internal producer
primitive and does not infer an authenticated scope.

`durable_event_scope` permanently stores each scope's high-water sequence and retention floor.
Inserting or updating that row allocates a sequence under PostgreSQL row serialization. The
corresponding immutable `durable_event` is written in the same transaction. Database guards reject
scope deletion, identity changes, decreasing metadata, unallocated event sequences, event updates,
and cleanup that would leave a hole in retained history.

Ordering is guaranteed only within one scope. Different scopes can both contain sequence `1`; no
comparison between them is meaningful. A transaction affecting several scopes writes one event
per scope and may attach one shared causal UUID.

Every event has an ID, scope, positive sequence, type/version, JSON payload, occurrence time,
commit time, explicit retention expiry, and optional causal ID. Producers must minimize payloads
and prefer stable references over private request bodies or provider credentials. Scope
identifiers remain after event cleanup because the sequence boundary is permanent.

### Retention floor and checkpoints

The retained event range is always contiguous. Cleanup deletes only an expired prefix for a scope.
The metadata definition is:

- `highWater`: greatest sequence ever committed for the scope;
- `retentionFloor`: oldest retained sequence, or `highWater + 1` if no events remain;
- a resume checkpoint is valid when
  `afterSequence >= retentionFloor - 1` and `afterSequence <= highWater`.

A new scope is `{ highWater: 0, retentionFloor: 1 }` and accepts checkpoint `0`. If sequences
through `5` are pruned and sequence `6` remains, floor `6` accepts checkpoint `5` and rejects
checkpoint `4`. If every event through `5` is pruned, the boundary is
`{ highWater: 5, retentionFloor: 6 }`, which still accepts checkpoint `5`. High-water values and
sequences are never reset or reused.

F3 does not fabricate events for changes that happened before a scope was introduced. Such a scope
starts at the documented empty boundary and its first post-introduction event receives sequence
`1`. F6 must pair that boundary with a canonical snapshot; it must not imply replay coverage for
older domain history.

## Leased delivery jobs

`delivery_job` stores a kind/version, minimal JSON payload, availability, state, bounded lifetime
attempt count, caller-provided terminal retention, lease metadata, and sanitized terminal
metadata. `delivery_job_attempt` is the immutable fencing/attempt history.

Claim behavior is transactionally implemented with PostgreSQL time and
`FOR UPDATE SKIP LOCKED`:

1. Select an available pending job or an expired reclaimable lease.
2. Close the previous expired attempt, when present.
3. Increment the attempt count atomically.
4. Set the owner, lease time, expiry, and a fresh UUID fencing token.
5. Insert the matching attempt row before commit.

Multiple workers cannot own the same job. Completion, retry, and permanent-failure transitions
require the job ID, owner, unexpired lease, and exact fencing token. A reclaimed or expired worker
receives stable `delivery_job_lease_lost`. Repeating a transition with the same completed token
returns the stored idempotent transition status.

Retry callers provide the next absolute availability timestamp. F3 does not choose backoff,
jitter, provider `Retry-After`, retryability, or terminal-error policy. F5 must own those decisions.
If the caller retries after the final claimed attempt, the job becomes a queryable
`attempts_exhausted` dead letter with outcome `failed`.

If a final-attempt lease expires before a worker records an outcome, reclaim scanning instead
creates `lease_expired_after_final_claim` with outcome `unknown`. It must not claim provider failure
because external I/O may already have occurred before the crash.

Failure input is reduced to one lower-case, bounded machine code. Error messages, exception
objects, authorization headers, response bodies, and private request bodies are never stored by
the transition API. Database constraints enforce the same failure-code grammar.

Manual requeue is an internal operations seam, not an endpoint. It requires an operator
identifier, sanitized reason, PostgreSQL-relative availability delay, and a new absolute
`maxAttempts` greater than the attempts already claimed. It preserves lifetime attempt numbering,
increments `manual_requeue_count`, and writes `delivery_job_manual_requeue` before returning the
job to pending. Operations tooling must resolve unknown provider outcomes before using this seam.

## Stable internal results

F3 adds no public endpoint or public envelope. Internal consumers can branch on:

| Code                                  | Meaning                                                      |
| ------------------------------------- | ------------------------------------------------------------ |
| `idempotency_conflict`                | Same actor/command/key, different version or fingerprint     |
| `idempotency_in_progress`             | A matching stored command has no terminal outcome            |
| `durable_scope_invalid`               | Scope kind or identifier is invalid                          |
| `durable_scope_forbidden`             | Authenticated actor does not own the approved scope          |
| `durable_checkpoint_before_retention` | Checkpoint is older than `retentionFloor - 1`                |
| `durable_checkpoint_ahead`            | Checkpoint is greater than the high-water mark               |
| `delivery_job_not_found`              | Referenced job does not exist                                |
| `delivery_job_lease_lost`             | Owner/token is stale, wrong, reclaimed, or expired           |
| `delivery_job_invalid_transition`     | Job is not in the state required by an operations transition |

F4/F5 may map these to public HTTP or socket results only when those milestones define their wire
contracts.

## Production rollout and preconditions

Before applying the migrations:

1. Complete the F2 production membership audit and install its invariant migration.
2. Take the normal PostgreSQL backup and confirm the F3 table/type names do not conflict with
   operator-created objects.
3. Confirm no F4/F5 producer, worker, scheduler, or cleanup task is enabled.
4. Assign ownership for monitoring and future cleanup, and review payload data classification.

Apply both F3 migrations before deploying code that imports the repositories. The migration adds
only tables, enums, constraints, indexes, and event-integrity triggers; it does not scan or rewrite
domain tables. Deploy the service code dormant. Validate the schema and observe that every F3 table
remains empty until a separately reviewed producer is enabled.

Before any production producer is enabled, its milestone must provide explicit reviewed values for
command/event retention, initial job availability, terminal job retention, lease duration, maximum
attempts, payload versioning, and cleanup cadence. Before any worker is enabled, F5 must also define
retry/backoff/jitter, provider `Retry-After`, terminal classification, unknown-outcome review, and
dead-letter alerting. F3 contains no production defaults for these policies.

P4 must define redaction, erasure, profile/user deletion, and retained-scope behavior before profile
deletion ships. F3 intentionally has no polymorphic domain foreign keys or cascading domain
deletion. The job-owned attempt and manual-requeue audit rows use ordinary ownership cascades only
when an explicitly expired terminal job is cleaned.

## Observability and cleanup

Monitoring must use metadata and counts without logging event/job payloads, idempotency keys,
fingerprints, results, or attempt details. At minimum, future dashboards should cover:

- old `in_progress` command count and age by command/version;
- event count and oldest retention expiry by scope kind, plus floor/high-water distance;
- pending availability lag, leased count, expired leases, and attempt distribution by job
  kind/version;
- completed/dead-letter count and age, dead-letter reason/outcome, and manual-requeue count.

F3 schedules no cleanup. When a later milestone supplies reviewed retention policy, its explicit
operator task may call:

- `cleanupCompletedIdempotencyRecords`, which deletes only expired completed commands;
- `pruneExpiredDurableEvents`, which deletes only expired contiguous scope prefixes and advances
  the permanent floor;
- `cleanupTerminalDeliveryJobs`, which deletes only expired completed/dead-letter jobs and their
  owned attempt/requeue history.

Pending, leased, and in-progress records are never retention-cleaned.

## Rollback

Before any producer writes F3 state, the migration can be rolled back by stopping the new
application, confirming all F3 tables are empty, and executing the reviewed
`20260723170425_f3_durable_substrate/rollback.sql` in a transaction. The script refuses to proceed
when command, event-scope, or job state exists.

After any scope metadata or canonical command/job state exists, dropping F3 is not a safe rollback:
scope sequence boundaries cannot be recreated or reused. Keep the schema, disable the new producer,
and roll application behavior forward or back while preserving the canonical rows. Redis state is
irrelevant to this decision.
