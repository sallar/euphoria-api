# Backend v2 delivery plan

Status: accepted foundation plan  
Last audited: 2026-07-23  
Applies to: Euphoria API and its published mobile contracts

This is the canonical implementation plan for Backend v2. Later milestones should update this
file when a decision, dependency, rollout gate, or current-code fact changes. Focused decisions are
recorded in:

- [F2 profile ownership audit and rollout](F2-PROFILE-OWNERSHIP-ROLLOUT.md)
- [F3 durable substrate schema and rollout](F3-DURABLE-SUBSTRATE-ROLLOUT.md)
- [ADR 0001: PostgreSQL and Redis state ownership](../adr/0001-postgres-redis-state-ownership.md)
- [ADR 0002: Durable realtime delivery and recovery](../adr/0002-durable-realtime-delivery.md)
- [ADR 0003: Profile ownership invariant](../adr/0003-profile-ownership-invariant.md)
- [ADR 0004: Notification durability and push semantics](../adr/0004-notification-durability-and-push-semantics.md)
- [ADR 0005: Versioned opaque composite cursors](../adr/0005-versioned-opaque-composite-cursors.md)
- [ADR 0006: Transactional chat correctness](../adr/0006-transactional-chat-correctness.md)
- [ADR 0007: Media asset lifecycle](../adr/0007-media-asset-lifecycle.md)

## Outcome

Backend v2 will make PostgreSQL the sole canonical domain store, add durable ordered event and job
processing, use Redis only for shared ephemeral coordination, and give clients replay-based
ordinary reconnects without weakening REST authority.

The target is ordered at-least-once delivery within each event scope. A client must deduplicate
durable events by `(scope, sequence)` and event ID. Presence and typing remain explicitly
ephemeral, unordered relative to durable events, and safe to lose.

## Source audit

The plan was checked against the backend at `a99f75a`, not copied from the native-client snapshot.
The sibling iOS architecture and handoff remain useful client context but include stale backend
claims: Backend main already implements APNs, and the test-notification route already requires
bearer authentication and restricts the target to the authenticated user.

| Current evidence                                                                                                                                                                                    | Consequence                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/db.ts` uses PostgreSQL through Drizzle/Bun SQL.                                                                                                                                            | PostgreSQL remains the canonical domain store.                                                                                                      |
| `src/services/chat-sockets.ts` and `notification-sockets.ts` keep sockets, subscriptions, and presence in process-local maps keyed by socket/profile/user, not session ID.                          | Current realtime cannot provide cross-node fan-out, session-wide revocation, leases, or replay.                                                     |
| Socket code has no subscription bound, command rate limit, output queue/backpressure policy, node heartbeat, or stale-node cleanup.                                                                 | Distributed realtime needs an explicit safety and lifecycle milestone, not only Redis pub/sub.                                                      |
| `src/lib/asyncapi-document.ts` explicitly advertises no durable ID, cursor, or replay.                                                                                                              | Protocol v2 must be additive and versioned; current clients still require REST reconciliation.                                                      |
| Feed, conversation, message, and notification pagination now uses one versioned HMAC-protected cursor codec with full normalized sort tuples and keyed scope/filter fingerprints.                   | F1 cursor integrity is implemented; clients treat every cursor as an opaque string and restart lists that retained a legacy numeric/date cursor.    |
| Every paginated query uses a strict full-tuple predicate, fetches `limit + 1`, and derives a next cursor from the returned boundary row only when lookahead proves another page.                    | Tie-heavy migrated-PostgreSQL traversal tests cover page-size-one boundaries, final/empty pages, and exactly-once traversal.                        |
| F2 defines active as `profile.deleted_at IS NULL`; database triggers and services enforce zero/one active membership while preserving explicit owner/member roles for shared couple/group profiles. | Bootstrap remains collection-shaped but returns zero/one active profile; every authorization scope names and verifies the active member profile.    |
| F3 now provides PostgreSQL command claims/fingerprints, permanent scope sequence metadata, immutable scoped events, and fenced leased jobs without importing them into existing request paths.      | The reusable substrate is complete and dormant; F4/F5 must supply reviewed retention/lease/retry policy and atomic domain producers before use.     |
| `clientMessageId` is optional WebSocket correlation, is absent from the message table and REST insert, and is included in a message event broadcast to every subscriber.                            | Persisted idempotency must cover REST and WebSocket, while correlation/acknowledgement stays origin-only.                                           |
| Message access/match checks happen before the message transaction; notification creation and socket broadcasts happen after it.                                                                     | Message, read/conversation mutation, canonical notification state, events, jobs, and idempotency are not atomic today.                              |
| Like/unlike takes a profile-pair advisory lock, but send/reaction does not; unlike returns before broadcasting an upsert.                                                                           | Match state can race with chat mutations, and peers may retain stale matched state after unlike.                                                    |
| Read advancement reads then writes in application logic, REST returns only the viewer's read state, and there is no total chat-unread endpoint.                                                     | Monotonic reads need a database predicate, peer reads need authorized recovery, and unread needs an authoritative aggregate/event.                  |
| `ChatMessage` exposes only `replyToMessageId`; no bounded reply summary is projected.                                                                                                               | The client must currently load the target or show a fallback.                                                                                       |
| `createNotification` transactionally creates notification/delivery rows but performs socket/provider I/O directly after commit; read/archive broadcasts are process-local.                          | Preserve transactional rows, add durable cross-device events, and move delivery to leased workers.                                                  |
| Chat message notifications use `channels: ["push"]`, and active conversation viewers are skipped before notification creation.                                                                      | Current behavior can omit canonical notification state; v2 must suppress only external push.                                                        |
| Provider outcome `accepted` is currently recorded as delivery status `delivered`; Expo receipts are not polled.                                                                                     | Provider acceptance is not device receipt and needs a compatibility-safe semantic and worker migration.                                             |
| `src/services/push/apns-provider.ts`, the APNs schema migration, and push tests are present.                                                                                                        | APNs is implemented; remaining work is operational durability, invalid-token/retry handling, and physical-device verification in both environments. |
| `/api/notifications/test/{userId}` has `auth: true` and rejects another user with `403`.                                                                                                            | The older iOS warning about an unauthenticated route is obsolete; protection remains a regression gate.                                             |
| `profile_photo` and image-shaped chat fields exist, but there is no upload-session/processing lifecycle, gallery CRUD, or image-message creation endpoint; attachments contain URLs.                | Media requires a server-owned asset lifecycle before gallery and image-message capabilities.                                                        |
| Conversation peer summaries have no photo, and there is no safe profile-by-ID or deletion lifecycle.                                                                                                | These are product-enabling backend milestones, distinct from core correctness.                                                                      |
| Docker originally supplied only the API and PostGIS/PostgreSQL.                                                                                                                                     | Foundation added isolated Postgres and Redis test services without changing production runtime behavior.                                            |

## State ownership and contract boundary

PostgreSQL owns:

- canonical application/domain state;
- the transactional outbox/event log;
- monotonic per-scope durable sequences and retention metadata;
- request/command idempotency records;
- notification, push, and other retryable delivery jobs;
- job attempts and provider-acceptance metadata.

Redis owns only shared ephemeral infrastructure:

- cross-node fan-out hints after a PostgreSQL commit;
- connection and subscription routing;
- expiring presence and typing leases;
- session-revocation signals and other invalidation hints.

Redis loss may disconnect sockets, remove advisory presence, or delay live fan-out. It must never
lose a committed domain change, consume the only copy of an event/job, allocate a canonical
sequence, or decide whether a mutation already succeeded. Workers and sockets recover from
PostgreSQL after Redis loss.

REST remains canonical for mutations, initial snapshots, explicit resynchronization, and integrity
repair. Ordinary reconnects use durable replay. A full REST repair is reserved for
`resync_required`, a client-detected sequence/integrity failure, or an explicit user refresh.

The backend owns OpenAPI and AsyncAPI. Contract changes are made and validated here first. The iOS
reviewed snapshots are updated only by a later explicit client contract task; they are not edited
by backend implementation milestones.

## Durable event scopes

Only these durable scopes are approved:

| Scope                                | Durable contents                                                                                                  | Authorization                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `chat-profile/{profileId}`           | Conversation-list projection changes, authoritative aggregate unread changes, and other profile-level chat state. | A current member of the profile.                     |
| `chat-conversation/{conversationId}` | Messages, reactions, participant read changes, match/conversation state, and other conversation-level state.      | A current participant through an accessible profile. |
| `notification-user/{userId}`         | Notification creation/read/archive state and authoritative unread-count changes.                                  | The authenticated user.                              |

Each durable record has at minimum an event ID, scope kind, scope ID, per-scope sequence, event
type/version, payload, occurrence time, and retention time. Sequences are gap-detectable and
strictly increase inside one scope. No ordering is promised across scopes. One transaction that
affects multiple scopes writes one scoped event per affected scope and can attach a shared causal
ID.

Presence and typing can use the same socket connection but never consume durable scope sequences.
Their payloads must identify them as ephemeral.

Command acknowledgements and client correlation are also not durable scoped events. They are sent
only to the originating REST request or WebSocket connection. Canonical message and peer events
must not expose another client's idempotency key or correlation token.

## Race-free snapshot, replay, and live handoff

The protocol implementation must use this ordering:

1. Authenticate and authorize every requested scope.
2. Subscribe the serving node to Redis/live fan-out before reading the PostgreSQL high-water mark.
3. Buffer live durable events for the scope.
4. In a consistent PostgreSQL snapshot, read the scope high-water mark `H` and either:
   - read the canonical REST snapshot represented through `H`, for initial sync/resync; or
   - read retained events in `(clientSequence, H]`, for an ordinary resume.
5. Send the snapshot or replay in sequence order.
6. Drain buffered events with sequence greater than `H`, discarding duplicates at or below `H`.
7. Enter live mode and preserve sequence order. If the next observed sequence is not the expected
   one, pause that scope and replay the gap from PostgreSQL.

Subscribing before reading `H` permits duplicates but closes the race window. At-least-once
delivery makes duplicates acceptable; clients apply an event only once and advance their stored
sequence only after the reducer commits it locally.

If `clientSequence` is older than the retained floor, ahead of the current high-water mark, belongs
to another scope/protocol, or cannot be repaired, return `resync_required` with the scope,
retention floor, and current high-water mark. The client then obtains a canonical snapshot and
resumes strictly after the snapshot sequence.

F3 implements only the permanent PostgreSQL floor/high-water metadata, checkpoint-boundary
validation, and contiguous retained ranges needed by this handoff. F6 still owns subscription,
buffering, replay reads, Redis fan-out, gap repair, socket results, and the complete race-free
handoff above.

## Dependency-ordered milestones

### F0. Foundation (this milestone)

- Record this plan and accepted ADRs.
- Add deterministic integration-only PostGIS/PostgreSQL and Redis services.
- Add a schema-isolated reusable test harness and a smoke test that exercises both services.
- Document Redis's noncanonical role and the test workflow.
- Make no domain schema, cursor, realtime, chat, media, or iOS contract changes.

Acceptance gates:

- Existing `bun test` suite passes.
- Integration services become healthy and migrations apply.
- PostgreSQL/Redis smoke test passes and cleans its schema/key namespace.
- Type-check, format-check, and lint pass.
- APNs tests and existing public contracts are unchanged.

### F1. Cursor integrity (complete)

Dependencies: F0 only.

Status: completed 2026-07-23.

- Implement one shared cursor codec with resource/version, full sort tuple, direction, and a
  scope/filter fingerprint.
- Convert feed, conversation, message, and notification pagination to strict lexicographic
  predicates matching their complete ordering.
- Emit the cursor from the last returned row only when a lookahead row proves another page exists.
- Reject malformed, unsupported, cross-scope, and filter-mismatched cursors with a stable `400`.
- Keep response envelope field names stable where possible; cursor wire types become opaque
  strings.
- Add integration tests for tied sort values, page boundaries, filter/scope mismatch, and complete
  traversal with no skips or duplicates.

Acceptance gates:

- Every paginated API traverses a tie-heavy fixture exactly once.
- Cursor values reveal no contract the client must interpret.
- OpenAPI changes are reviewed and both backend contracts validate.
- No iOS snapshot is regenerated in this backend task.

Implementation record:

- Cursor wire version `c1` signs a protected version/resource/direction/full-tuple/fingerprint
  payload with HMAC-SHA-256. Context fingerprints use a separate keyed HMAC domain and contain no
  raw scope/filter values.
- Feed fingerprints user, requesting profile, radius, normalized age bounds, and optional profile
  type. Conversations fingerprint user/profile; messages fingerprint user/profile/conversation;
  notifications fingerprint user and normalized `unreadOnly`.
- Descending timestamp tuples store PostgreSQL epoch microseconds plus the UUID tie-breaker; message
  rows remain chronological inside each returned page.
- `CURSOR_SIGNING_SECRET` is primary, comma-separated
  `CURSOR_SIGNING_PREVIOUS_SECRETS` supports verification during key rotation, and
  `BETTER_AUTH_SECRET` is the compatibility fallback when no dedicated primary is configured.
- Legacy numeric/date-time cursors intentionally return the stable `400 invalid_cursor` response;
  clients retaining one restart that list. All cursor query/response schemas are opaque strings.

### F2. Profile ownership invariant

Dependencies: F0; may proceed independently of F1.

Status: completed 2026-07-23.

- Audit production membership cardinality and choose a remediation for any user attached to more
  than one active profile.
- Enforce zero or one active profile per user at the service and database boundaries.
- Preserve multiple users on one couple/group profile only if product ownership requires it.
- Make active-profile selection explicit in authorization and event-scope code even while only one
  can exist.

Acceptance gates:

- Concurrent create and membership changes cannot give a user two active profiles.
- Couple/group membership has explicit roles and tests, or unused membership is removed.
- List/bootstrap and contract behavior match the chosen invariant.

Implementation record:

- An active profile has `deleted_at IS NULL`; `hidden` profiles remain active, while membership
  rows retained for deleted profiles are inactive and do not block replacement onboarding.
- Bootstrap retains its array envelope but explicitly filters deleted profiles and defensively
  rejects impossible multi-active state instead of selecting by row order.
- Transaction-scoped advisory locks and deferred database triggers enforce one active profile per
  user for direct, concurrent, service, and profile-reactivation writes. The migration aborts
  before installing enforcement when production cardinality, solo-membership, or owner-role
  preconditions are not satisfied; it never deletes, merges, or chooses conflicting rows.
- Solo profiles reject additional users. Couple/group profiles retain multiple active members and
  explicit `owner`/`member` roles. Existing acting-as-profile operations allow either active role;
  only owners may call the internal membership mutation service, and an active profile with
  memberships must retain at least one owner.
- No public membership, invitation, ownership-transfer, profile-switching, or additional-profile
  API was added. Those product flows remain the separate P0 milestone below.
- Stable conflicts use `active_profile_conflict`, `solo_profile_membership_forbidden`, and
  `final_owner_required`; inaccessible profile behavior remains the established concealed `404`.
- Migrated-PostgreSQL tests cover concurrent create, concurrent service and direct membership
  writes, zero/one bootstrap, deleted membership replacement/reactivation, solo restrictions,
  owner/member authorization, member removal, final-owner races, and authorized feed/chat/user
  notification/F1 cursor scopes. OpenAPI and AsyncAPI validation remain required gates.

### F3. Durable command, event, and job substrate

Dependencies: F2 for stable profile scope semantics.

Status: completed 2026-07-23.

- Add reusable idempotency records and normalized request fingerprints for replayable commands.
- Add transactional outbox/event-log rows and per-scope sequence allocation in PostgreSQL.
- Add retention metadata and indexes for ordered replay.
- Add durable delivery-job claiming, retry, and lease recovery.
- Write domain mutation, idempotency result, scoped events, and jobs in one transaction.

Acceptance gates:

- Transaction rollback leaves none of the domain/event/job/idempotency effects committed.
- Repeating an idempotency key returns the original outcome without another mutation.
- Concurrent writers produce unique, ordered sequences per scope.
- Abandoned worker leases are recoverable without duplicate domain mutations.

Implementation record:

- Actor/command/key uniqueness and a command-version-bound canonical JSON fingerprint serialize
  duplicate claims. Completed records remain authoritative after expiry until explicit terminal
  cleanup; old nonterminal records have a diagnostic query and no silent expiry.
- The three approved scope kinds are database enums. Atomic scope-row upserts allocate strictly
  increasing sequences, metadata is permanent and monotonic, retained ranges cannot contain
  holes, and optional causal IDs link multi-scope events without promising cross-scope ordering.
- A new scope starts at `{ highWater: 0, retentionFloor: 1 }`. Cleanup advances the floor through
  expired contiguous prefixes only; no historical events are fabricated.
- Jobs count attempts at claim time, use PostgreSQL time plus `FOR UPDATE SKIP LOCKED`, and fence
  every worker transition with an owner and unique lease token. Expired final claims become
  queryable `lease_expired_after_final_claim`/`unknown` dead letters. Retry availability is a
  caller-provided absolute timestamp; F3 chooses no backoff or terminal provider policy.
- Manual dead-letter requeue preserves lifetime attempt numbering and writes an operator/reason
  audit row. Failure metadata is reduced to a constrained machine code.
- Migrated-PostgreSQL tests cover concurrent duplicate/fingerprint claims, expired-but-present
  commands, nonterminal diagnostics, rollback injection, 20-way sequence allocation, causal
  multi-scope writes, floor/checkpoint boundaries, explicit F2 scope authorization, competing job
  workers, non-expired lease protection, reclaim, stale fences, retries, idempotent transitions,
  crashed final attempts, dead-letter queries, sanitization, and manual requeue.
- No chat/notification producer, delivery worker, scheduler, socket/replay path, Redis runtime, or
  public contract was added. Production use remains blocked on reviewed F4/F5 retention, lease,
  retry, attempt, cleanup, payload, and observability policy.

### F4. Transactional chat correctness

Dependencies: F3.

- Require a persisted message idempotency key on both REST and WebSocket send paths. Scope the key
  to the authenticated actor/command so retries across reconnects and transports resolve to the
  same stored outcome.
- Normalize the command before fingerprinting: conversation, actor profile, trimmed text,
  nullable reply target, and command version all participate. Reusing a key with the same
  fingerprint returns the original result; a different fingerprint returns stable `409 Conflict`.
- Execute idempotency claim/reuse, authorization and current match check, message insert, sender
  read advancement, conversation projection update, canonical notification creation, durable
  scoped events, and delivery-job creation in one PostgreSQL transaction.
- Use one ordered profile-pair/conversation locking strategy for like, unlike, rematch, send, and
  reaction mutations. Match state must be checked while holding that common lock so send/reaction
  cannot commit concurrently after unlike wins.
- After every committed unlike or rematch, unconditionally emit durable conversation and
  profile-stream upserts for every affected participant, even when the conversation already
  existed or the REST unlike response remains intentionally minimal.
- Enforce monotonic read advancement in the database using the ordered
  `(messageCreatedAt, messageId)` position. Concurrent or delayed acknowledgements may be equal or
  advance but can never overwrite a newer position.
- Return authorized, recoverable read state for both participants through REST and emit durable
  conversation-stream read events. Never expose read state outside current conversation access.
- Add an authoritative chat-unread aggregate REST endpoint per profile and a durable
  chat-profile-stream aggregate-unread event produced in the same transaction as changes that
  affect the count.
- Add a bounded server-provided reply summary to `ChatMessage` REST projections and durable events.
  It identifies the target, sender/type, deletion state, and a bounded safe text/media preview
  without requiring unbounded history or embedding permanent asset URLs.
- Separate origin-only command acknowledgement/correlation from canonical events. REST responds to
  the request; WebSocket sends an origin-only command result containing the caller's correlation
  value/idempotency outcome. Canonical peer message events contain no client correlation token.

Acceptance gates:

- The same required idempotency key through REST, WebSocket, reconnect, or a concurrent duplicate
  creates exactly one message and returns the same canonical message/result.
- Reusing the key with different normalized text, reply target, conversation, actor, or command
  version returns `409` and creates no mutation/event/job.
- Failure injection at every statement boundary proves that message, sender read, conversation,
  notification, events, jobs, and stored idempotency outcome commit together or all roll back.
- Deterministic race tests for send-versus-unlike and reaction-versus-unlike show the common lock
  chooses one valid serial outcome; no chat mutation commits against stale matched state.
- Unlike and rematch always update both participants through durable conversation/profile events,
  including an existing historical conversation and repeated reaction changes.
- Concurrent out-of-order read acknowledgements leave the greatest
  `(messageCreatedAt, messageId)` position in PostgreSQL; REST and replay return both authorized
  participant positions.
- Chat unread REST aggregate equals the database truth after send/read/unlike sequences, and its
  profile-stream event converges another device without paging every conversation.
- Reply summaries are bounded, stable for deleted/unavailable targets, and identical in REST and
  durable message events.
- Only the command origin receives its correlation/idempotency acknowledgement; peer and replayed
  canonical message events contain no other client's token.

### F5. Notification durability and delivery semantics

Dependencies: F3 and F4.

- Always create canonical notification state transactionally for a notification-worthy event.
- Model push/in-app work as durable jobs.
- Use an active conversation-view lease only to suppress external push; never suppress the
  notification row or durable notification-user event.
- Emit durable cross-device notification events for create/upsert, individual read, archive,
  read-all, and authoritative unread-count changes. Payloads describe the resulting state:
  individual read carries the canonical notification and resulting count; archive carries
  notification ID, archive timestamp, and resulting count; read-all carries its operation
  sequence/timestamp, changed count, and resulting count. Scope sequence ordering disambiguates
  notifications created after a bulk read.
- Claim jobs with an atomic PostgreSQL lease (`owner`, `leasedAt`, `leaseExpiresAt`), bounded
  attempts, exponential backoff with jitter, and crash-safe reclaim. Permanent failure or
  exhausted retry moves the job to a queryable dead-letter state with sanitized diagnostics.
- Store provider acceptance separately from confirmed device delivery.
- Poll Expo receipts when the provider returns receipt/ticket IDs, reconcile later provider
  failures, and disable invalid registrations.
- Verify APNs against physical devices in both sandbox and production (including TestFlight/App
  Store production tokens), classify invalid/unregistered tokens for disablement, and retain
  retryable transport/throttling/server failures for worker retry.
- Preserve Expo and APNs registration/provider compatibility.

Acceptance gates:

- Active viewing still yields durable notification state and replay.
- Push suppression has an explicit recorded reason and expires safely.
- A mutation on one device produces unambiguous ordered create/read/archive/read-all/count events
  on another device, and REST returns the same resulting state.
- Multiple workers cannot concurrently own one job; expired leases are reclaimed, backoff is
  honored, exhausted jobs are dead-lettered, and retry/dead-letter transitions never duplicate
  notification state.
- Crash injection after commit, after claim, before provider I/O, and after provider response
  proves jobs remain recoverable and attempts are auditable.
- API/log/UI wording never claims provider acceptance proves device receipt.
- Expo ticket acceptance remains distinct from later receipt status; receipt polling records
  confirmed provider processing failures and invalid-token disablement.
- APNs sandbox and production physical-device tests pass with the correct host/topic/environment;
  invalid tokens disable the registration, while throttling/transport/server failures remain
  retryable.

### F6. Distributed realtime and replay protocol

Dependencies: F3 and F4; notification-user delivery also depends on F5.

- Publish committed outbox hints through Redis and recover missed hints from PostgreSQL.
- Register every connection by authenticated session ID, user, optional active profile, node, and
  connection ID. Sign-out, session revocation, or session expiry publishes a revocation signal and
  closes every socket for that exact session across nodes without signing out unrelated sessions.
- Represent connection, conversation subscription, presence, and typing state as expiring leases.
  Renew them with connection heartbeat; maintain node heartbeats; reap stale-node leases; and emit
  aggregate `typing=false` when the final typing lease for a profile/conversation disappears or
  expires.
- Define presence as the aggregate of live profile connection leases across all healthy nodes.
  Redis loss makes presence/typing unknown or temporarily offline, never canonical, and reconnect
  plus lease renewal rebuilds them.
- Implement versioned resume, replay, acknowledgement, gap repair, `resync_required`, and the
  snapshot/replay/live handoff for the three approved scopes.
- Bound subscriptions per socket; enforce per-session/profile/IP command rate limits and
  command-specific limits; cap frame/decoded payload sizes; and reject excess work with stable,
  documented errors.
- Give every connection a bounded output queue by message count and bytes. Define coalescing only
  for replaceable ephemeral state, never durable events; close a persistently slow consumer with a
  documented retryable close code and resume point.
- Classify intentional closes (background, client sign-out, superseded generation/profile),
  terminal-until-input-change closes (invalid/revoked session, inaccessible profile), and retryable
  transport/server/backpressure failures. Only retryable failures enter reconnect backoff.
- Emit sanitized metrics/logs for connections, leases, subscriptions, rate-limit rejections,
  queue depth, slow-consumer closes, replay/gap/resync lag, node cleanup, Redis availability, and
  revocation latency without tokens, message bodies, notification payloads, or private IDs in
  high-cardinality labels.
- Keep acknowledgements and caller correlation origin-only. AsyncAPI must state capabilities,
  limits, allowed subscription transitions, authorization rules, scope resume rules, close
  classes, and which events are durable versus ephemeral.
- Keep protocol v1 available during rollout.

Acceptance gates:

- Two API replicas deliver a committed event to a socket connected to either node.
- Signing out/revoking one session closes that session's chat and notification sockets on every
  node within a bounded interval while another session for the same user remains connected.
- Node crash/heartbeat expiry removes stale connection, subscription, presence, and typing leases;
  final typing-lease disappearance produces aggregate `typing=false`.
- Subscription, command-rate, payload, and output-queue limits reject abusive clients without
  unbounded memory/CPU growth; a slow consumer is closed predictably and recovers through replay.
- Intentional and terminal closes do not reconnect-loop; retryable failures use the documented
  jittered backoff and preserve resume state.
- Redis outage/restart loses only ephemeral leases/fan-out hints. PostgreSQL writes still commit,
  sockets recover or close safely, multi-node fan-out resumes, and replay repairs every durable
  gap without Redis becoming canonical.
- Multi-node presence reflects leases from every healthy node and converges after connect,
  disconnect, node crash, lease expiry, and Redis restart.
- Disconnects at every handoff boundary produce no permanent gap.
- Duplicate and out-of-order injected delivery converges through sequence checks.
- AsyncAPI validation/tests prove origin-only acknowledgements, capability negotiation,
  subscription authorization/bounds, durable/ephemeral classification, and close semantics.

### F7. Core contract and client rollout

Dependencies: F1, F4, F5, and F6.

- Publish additive protocol/version metadata and client capability negotiation.
- Deploy database changes first, then dual-write/dual-serve backend behavior.
- Update and review the iOS OpenAPI/AsyncAPI snapshots in the iOS repository through its explicit
  contract workflow.
- Release replay-capable clients before retiring protocol v1 and reconnect-wide REST repair.

Acceptance gates:

- Old clients remain functional during the compatibility window.
- New clients demonstrate replay, duplicate tolerance, explicit resync, and cursor traversal.
- Server metrics show replay lag, retention misses, Redis health, job lag, and protocol versions.
- Retirement has a documented minimum supported client version and rollback path.

## Product-enabling backend roadmap

These milestones are deliberately separate from core correctness. They are dependency-ordered and
must receive their own implementation tasks and contract rollout.

### P0. Shared-profile invitations and multi-profile switching

Dependencies: F2 and an explicit product/identity design.

- Add consent-based invitations and acceptance for existing users without exposing unrestricted
  user discovery.
- Add public owner-authorized membership and role management, ownership transfer, member leave and
  removal, and final-owner resolution using the F2 internal service semantics.
- Permit a user to belong to multiple profiles only together with an explicit persisted active
  profile selection and authenticated create/list/switch operations.
- Update every REST, WebSocket, notification, cursor, cache, and later durable-event scope to use
  the selected profile explicitly. Never restore first-row selection.
- Define client-visible switching, invitation expiry/revocation, deleted-profile handling, and
  migration/rollback behavior before relaxing F2's database cardinality trigger.

Acceptance gates:

- Invitation acceptance is authenticated, consent-based, expiring/revocable, and race-safe.
- Concurrent create/accept/switch/leave/remove/role mutations produce one valid membership and
  active-selection state with no orphaned shared profile.
- Every profile-scoped authorization and cursor/event fingerprint uses the explicitly selected
  profile, and another membership cannot leak state across scopes.
- Existing clients remain on the zero/one behavior until the explicit backend/client contract
  rollout is complete.

P0 is not part of F2 or F3. Until it is implemented, an authenticated user has zero or one active
profile even though couple/group profiles may contain multiple users.

### P1. Media asset and upload-session lifecycle

Dependencies: F3 durable jobs.

- Introduce `media_asset` and expiring upload-session records with owner, purpose, expected
  content type/size/checksum, server-generated object bucket/key, lifecycle state, and retention.
- Never accept a client-chosen canonical object key. Issue constrained presigned uploads and verify
  object existence, size, checksum, and declared type before processing.
- Process images through decode/validation, metadata stripping/orientation, safe dimension/format
  policy, and required derivatives. Only `ready` assets are consumable.
- Authorize create/finalize/read/delete by current profile membership and intended purpose.
- Add jobs for abandoned upload cleanup, rejected/failed processing, derivative cleanup, and
  tombstoned asset deletion.

Acceptance gates:

- A client cannot overwrite or read another owner's object by choosing a key/asset ID.
- Missing, oversized, mismatched, corrupt, or unsupported uploads never become `ready`.
- Finalize/process retries are idempotent; crashes and expired sessions leave recoverable jobs or
  cleaned objects, not orphaned canonical state.
- Signed access is short-lived and derived from current authorization; permanent object URLs never
  enter public contracts.

This milestone is the foundation for removing the iOS media blocker but does not itself provide
gallery UI operations or image messages.

### P2. Profile gallery and conversation photo projections

Dependencies: P1, F2, and F3.

- Add owner-authorized profile gallery create/list/update/delete and atomic reorder operations
  referencing ready profile-photo asset IDs.
- Enforce stable unique positions, one explicit primary photo, public versus connection-only
  visibility, soft-delete/tombstone behavior, and cleanup handoff to the asset lifecycle.
- Enforce connection-only access from current match/relationship truth at read/signing time.
- Add a safe primary-photo descriptor to conversation peer projections and corresponding durable
  profile/conversation upserts when it changes.

Acceptance gates:

- Concurrent reorder/delete/primary changes yield one deterministic contiguous gallery with at
  most one primary photo.
- Owners see authorized assets; peers/public feed see only permitted visibility; access is revoked
  after unlike/deletion without relying on an already issued permanent URL.
- Conversation list/detail REST and events expose the same peer primary-photo projection and
  update it without a full profile fetch.

This removes the iOS workarounds for missing gallery management, connection-only photos, and
conversation peer photos.

### P3. Image messages

Dependencies: P1 and F4; conversation delivery uses F6 when protocol v2 is active.

- Create image messages by referencing ready, authorized media asset IDs, never client-supplied or
  permanent URLs.
- Reuse F4 idempotency, profile-pair locking, notification, reply summary, unread, and durable
  event transaction semantics.
- Return asset descriptors whose signed rendition URLs are generated/renewed at read time and may
  expire without changing message identity.
- Define retention/deletion behavior so message history does not silently reference a removed or
  repurposed asset.

Acceptance gates:

- Pending/rejected/deleted/foreign-purpose assets cannot be sent.
- REST and WebSocket retries create one image message and one durable event/job set.
- Expired signed URLs are refreshable from the stable asset/message ID; no permanent object URL is
  stored in the wire message.
- Reply summaries and notification previews remain bounded and safe for image messages.

This removes the native client's image-message blocker.

### P4. Safe profile lookup and deletion lifecycle

Dependencies: F2, F3, P1, and P2 for complete media cleanup.

- Add an authorization-aware profile-by-ID projection that excludes precise location, date of
  birth, membership details, deleted/hidden data, and connection-only media unless access permits.
- Define profile deletion as a lifecycle, not an immediate blind cascade: mark unavailable,
  prevent feed/reaction/new-send use, publish durable conversation/profile changes, revoke relevant
  leases/access, retain or redact history according to policy, and enqueue asset cleanup.
- Define owner/member and final-owner behavior for couple/group profiles.

Acceptance gates:

- Unauthorized, hidden, or deleted lookups reveal no sensitive existence/state beyond the chosen
  contract.
- Deletion is idempotent, survives worker crashes, removes the profile from feed/new mutations,
  converges every authorized client, and follows documented chat/notification/media retention.
- Couple/group member removal and final-owner deletion cannot orphan an active profile.

This removes the iOS workaround for absent profile lookup/deletion. It is not required for cursor,
chat transaction, or realtime correctness.

### P5. Separate product capabilities

Dependencies: product-specific; start only after their policy and moderation requirements exist.

- Blocking, reporting, and user search remain separate product features.
- If blocking ships, it must integrate with authorization, feed, profile lookup, match/chat,
  notifications, media access, events, and deletion semantics atomically.
- Reporting requires retention, moderation access, evidence/privacy, abuse-rate, and audit policy.
- Search requires a deliberate discoverability/privacy model and must not reuse unrestricted
  profile lookup.

These features are not required to remove current iOS correctness workarounds and must not be
smuggled into F1 or the core Backend v2 rollout.

## Audit coverage and workaround removal

| Audited concern/current workaround                                         | Named milestone and acceptance gate                                                                                                                                                |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| APNs described as absent in stale iOS text                                 | Already implemented and protected by F0 regression gates; F5 adds durable workers, receipt semantics, invalid-token handling, and sandbox/production physical-device verification. |
| Incomplete/skipping pagination and defensive client deduplication          | Closed by F1 tie-heavy complete traversal, strict full-tuple predicates, and returned-boundary cursor tests; client workaround removal still follows explicit client rollout.      |
| Unsafe resend and no durable message outbox                                | F3 reusable claim/event/job substrate is complete; F4 still owns cross-transport message wiring, normalization, common locking, and atomicity gates.                               |
| Process-local realtime and reconnect-wide REST reconciliation              | F6 multi-node, Redis-outage, replay, handoff, and no-canonical-Redis gates; F7 removes the workaround only after client rollout.                                                   |
| Missing typing cleanup/local expiry                                        | F6 TTL/final-lease aggregate `typing=false` and stale-node cleanup gates.                                                                                                          |
| Peer read is transient and unrecoverable                                   | F4 authorized REST peer-read and durable conversation-read gates.                                                                                                                  |
| Best-effort chat badge from paged rows                                     | F4 authoritative aggregate REST/profile-event gate.                                                                                                                                |
| Unlike does not propagate canonical conversation state                     | F4 common-lock and unconditional unlike/rematch upsert gates.                                                                                                                      |
| Reply target fallback                                                      | F4 bounded reply-summary parity gate.                                                                                                                                              |
| Correlation token can reach peers                                          | F4 origin-only acknowledgement gate and F6 AsyncAPI origin/capability gate.                                                                                                        |
| Message notification rows/count are missing while actively viewed          | F4 atomic notification creation plus F5 push-only suppression/cross-device event gates.                                                                                            |
| Notification cross-device read/archive/count ambiguity                     | F5 resulting-state payload and sequence-order gates.                                                                                                                               |
| Direct push calls, no worker/receipt loop, misleading `delivered`          | F3 leased/fenced job primitives are complete; F5 still owns notification producers/workers, retry policy, Expo receipts, and provider-acceptance gates.                            |
| Sign-out cannot close one session's sockets across nodes                   | F6 session-ID registry/revocation-latency gate.                                                                                                                                    |
| Unbounded socket subscriptions/commands/output and unclear close handling  | F6 bounds, backpressure, slow-consumer, rate/payload, close-class, and sanitized-observability gates.                                                                              |
| Zero/one product behavior over permissive membership                       | Closed by F2 database/service concurrency, active/deleted semantics, and explicit shared-profile role/final-owner gates; P0 is required before multi-profile switching.            |
| Profile photos seeded/read-only; no upload/gallery/image-message lifecycle | P1 asset lifecycle, P2 gallery/access, and P3 ready-asset image-message gates.                                                                                                     |
| Conversation peer has no primary photo                                     | P2 projection/update parity gate.                                                                                                                                                  |
| No safe profile-by-ID or deletion                                          | P4 privacy and idempotent deletion-lifecycle gates.                                                                                                                                |
| Notification test route described as unauthenticated                       | Stale claim: current route is bearer-protected/self-only; F0 preserves it as a regression fact, with no new milestone needed.                                                      |
| Blocking/reporting/search absent                                           | P5 separate product capabilities; explicitly not current correctness blockers.                                                                                                     |

## Implementation orchestration

1. F1 composite cursors are complete; preserve their shared codec and traversal regression gates.
2. Complete F2 before introducing stable profile-scoped event ownership.
3. F3 reusable PostgreSQL substrate is complete; preserve its dormant producer boundary and
   concurrency/rollback gates.
4. Implement F4 transactional chat correctness before relying on chat events/jobs in notification
   or replay rollout.
5. Implement F5 notification workers and cross-device semantics on F3/F4.
6. Implement F6 distributed realtime/replay after the durable producers are correct.
7. Perform F7 backend/client compatibility rollout; update the iOS snapshots only in its explicit
   client contract task.
8. Schedule P1-P5 as separate product tasks following their stated dependencies. P1 may begin
   after F3 without widening F4-F7, but P3 must reuse F4 correctness.

Each implementation task must update this coverage table when it closes a gate. Parallel work is
allowed only where the dependency text permits it and shared contracts/schemas do not conflict.
No task may mark an iOS workaround removable until its backend acceptance gate is deployed and the
explicit client contract/update task has passed.

## Migration and rollout sequence

F1 cursor integrity can deploy independently before the durable-event rollout. The remaining core
sequence is:

1. Audit/remediate profile membership, then expand F2/F3 PostgreSQL schemas and indexes without
   removing v1 behavior.
2. Deploy the F3 schema and dormant repositories without enabling a producer, worker, scheduler,
   or cleanup task. F4/F5 may begin reviewed shadow writes only after supplying explicit retention,
   lease, attempt, retry, cleanup, payload, and observability policy; do not claim replay or
   delivery correctness yet.
3. Backfill only state with a defined semantic mapping. Do not fabricate historical socket events;
   start each scope at a documented sequence boundary when necessary.
4. Cut chat writes to F4 atomic transactions while dual-serving compatible v1 responses/events;
   verify idempotency, lock races, reads, unread aggregates, reply summaries, and origin-only
   acknowledgement before enabling automatic replay.
5. Start F5 notification workers in shadow/limited mode, reconcile their outcomes against current
   delivery rows, then cut provider calls from request paths to durable jobs.
6. Run F6 Redis fan-out/leases in shadow mode, compare multi-node presence/routing and replay with
   PostgreSQL projections, then add protocol v2 while serving v1.
7. Roll out F7 replay/cursor-capable clients and monitor resync, lag, duplicate, mismatch,
   revocation, slow-consumer, job, receipt, and dead-letter rates.
8. Stop v1 writes/serving only after the client compatibility window and operational gates.
9. Remove v1 paths and misleading legacy status names in a later contraction migration.

Every phase must be rollback-safe. Redis rollout is never a prerequisite for committing domain
state. A worker or fan-out outage creates lag, not lost state.

## Non-goals for foundation

- No production outbox, event-log, sequence, idempotency, or new delivery-job tables.
- No cursor implementation or API contract change.
- No transactional chat, unread, reply-summary, realtime, or Redis runtime behavior change.
- No notification suppression or delivery-status behavior change.
- No profile invariant migration.
- No media-asset, gallery, image-message, profile lookup/deletion, or storage changes.
- No APNs rebuild, credential change, or provider contract change.
- No iOS source or reviewed contract snapshot edits.

## Foundation test strategy

Integration services use a dedicated `euphoria_integration` database on port `55432` and Redis on
port `56379`. PostgreSQL data is held in an integration-only tmpfs. Each test suite creates a
random schema and uses a namespaced Redis key set; cleanup drops only that schema and those keys.
The harness refuses a database whose name does not clearly contain `integration`.

The integration test command first applies all existing Drizzle migrations to the dedicated
database. Later domain tests may use the migrated public schema for compatibility checks and
should use per-suite schemas or explicit fixtures for mutable test state. Tests must never
`FLUSHDB`, drop the integration database, or point at a development/production database.

## Next task handoff

The next orchestrated milestone should implement F4 transactional chat correctness on the F3
transaction APIs. Require one persisted idempotency key across REST/WebSocket, define the reviewed
command normalization and F3 policy inputs, use one common match/chat lock, and atomically commit
the message/reaction domain change, monotonic sender read, conversation projection, canonical
notification state, scoped events, jobs, and idempotency outcome. Add unread aggregates, authorized
peer reads, bounded reply summaries, unlike/rematch convergence events, and origin-only command
acknowledgements exactly as specified by F4.

Preserve F1 cursor wire/traversal behavior, every F2 ownership/remediation gate, the F3
sequence/floor/fencing/rollback invariants, existing public endpoint envelopes, APNs/Expo
semantics, and the bearer-authenticated self-only test-notification route. Do not implement F5
workers or provider-policy changes, F6 replay/Redis runtime, P0 profile switching, P1-P5 product
work, or iOS contract updates in F4.
