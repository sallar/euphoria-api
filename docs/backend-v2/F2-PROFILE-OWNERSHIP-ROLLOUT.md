# F2 profile ownership audit and rollout

Status: implementation record  
Date: 2026-07-23

## Semantics

An active profile is a `profile` row whose `deleted_at` is `NULL`. A `profile_user` row belongs to
an active profile only while its referenced profile is active. Membership rows retained for a
deleted profile are inactive and do not prevent the user from creating or joining a replacement
active profile. `hidden` affects discovery, not activity or ownership.

The current product cardinality is zero or one active profile membership per authenticated user:

- zero means the user has not onboarded, or every retained membership refers to a deleted profile;
- one means the user acts as that active profile;
- more than one is invalid and must never be selected by row order.

`solo` profiles permit exactly one membership once they have a member. `couple` and `group`
profiles may have multiple active members. Roles remain `owner` and `member`. Every active member
may act as the profile in existing profile, feed, reaction, chat, and realtime authorization.
Only owners may use the internal membership mutation service. An active profile with memberships
must retain at least one owner; the last owner cannot be removed or demoted.

F2 does not publish membership-management endpoints. Creating additional profiles, choosing an
active profile, inviting and accepting users, transferring ownership through public APIs, and
switching profiles are a separate future product milestone. Until that milestone changes the
invariant and all authorization/cursor/client scopes together, a user must have zero or one active
profile.

## Available production inspection mechanism

The repository has no production admin connector, operator API, or production audit job. It only
accepts a PostgreSQL connection through `DATABASE_URL`, and production startup applies Drizzle
migrations. Therefore an operator with approved database access must run the audit directly using
a read-only PostgreSQL session. Do not point the integration harness at production: it
intentionally refuses non-integration database names and is not an inspection mechanism.

Run the following in a repeatable-read, read-only transaction. It changes no rows and reports only
internal identifiers and aggregate counts:

```sql
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

-- 1. Invalid: users attached to more than one active profile.
SELECT
  membership.user_id,
  count(DISTINCT membership.profile_id)::integer AS active_profile_count,
  array_agg(DISTINCT membership.profile_id ORDER BY membership.profile_id) AS active_profile_ids
FROM profile_user membership
INNER JOIN profile active_profile
  ON active_profile.id = membership.profile_id
  AND active_profile.deleted_at IS NULL
GROUP BY membership.user_id
HAVING count(DISTINCT membership.profile_id) > 1
ORDER BY membership.user_id;

-- 2. Supported only for couple/group: profiles with multiple users.
SELECT
  active_profile.id AS profile_id,
  active_profile.profile_type,
  count(*)::integer AS member_count,
  count(*) FILTER (WHERE membership.role = 'owner')::integer AS owner_count,
  count(*) FILTER (WHERE membership.role = 'member')::integer AS non_owner_member_count,
  array_agg(membership.user_id ORDER BY membership.user_id) AS user_ids
FROM profile active_profile
INNER JOIN profile_user membership ON membership.profile_id = active_profile.id
WHERE active_profile.deleted_at IS NULL
GROUP BY active_profile.id, active_profile.profile_type
HAVING count(*) > 1
ORDER BY active_profile.id;

-- 3. Role distribution by profile activity and type.
SELECT
  (audited_profile.deleted_at IS NULL) AS profile_active,
  audited_profile.profile_type,
  membership.role,
  count(*)::bigint AS membership_count,
  count(DISTINCT membership.profile_id)::bigint AS profile_count,
  count(DISTINCT membership.user_id)::bigint AS user_count
FROM profile_user membership
INNER JOIN profile audited_profile ON audited_profile.id = membership.profile_id
GROUP BY
  (audited_profile.deleted_at IS NULL),
  audited_profile.profile_type,
  membership.role
ORDER BY profile_active DESC, audited_profile.profile_type, membership.role;

-- 4a. Invalid if present despite foreign keys: memberships with a missing profile or user.
SELECT
  membership.profile_id,
  membership.user_id,
  membership.role,
  (audited_profile.id IS NULL) AS missing_profile,
  (audited_user.id IS NULL) AS missing_user
FROM profile_user membership
LEFT JOIN profile audited_profile ON audited_profile.id = membership.profile_id
LEFT JOIN "user" audited_user ON audited_user.id = membership.user_id
WHERE audited_profile.id IS NULL OR audited_user.id IS NULL
ORDER BY membership.profile_id, membership.user_id;

-- 4b. Invalid: active solo profiles with more than one membership.
SELECT
  active_profile.id AS profile_id,
  count(*)::integer AS member_count,
  array_agg(membership.user_id ORDER BY membership.user_id) AS user_ids
FROM profile active_profile
INNER JOIN profile_user membership ON membership.profile_id = active_profile.id
WHERE active_profile.deleted_at IS NULL
  AND active_profile.profile_type = 'solo'
GROUP BY active_profile.id
HAVING count(*) > 1
ORDER BY active_profile.id;

-- 4c. Invalid: active profiles with memberships but no owner.
SELECT
  active_profile.id AS profile_id,
  active_profile.profile_type,
  count(*)::integer AS member_count,
  array_agg(membership.user_id ORDER BY membership.user_id) AS user_ids
FROM profile active_profile
INNER JOIN profile_user membership ON membership.profile_id = active_profile.id
WHERE active_profile.deleted_at IS NULL
GROUP BY active_profile.id, active_profile.profile_type
HAVING count(*) FILTER (WHERE membership.role = 'owner') = 0
ORDER BY active_profile.id;

-- 4d. Orphan audit: active profiles with no membership. Seed/feed-only fixtures may explain
-- these rows, but an operator must classify production rows before treating them as user profiles.
SELECT
  active_profile.id AS profile_id,
  active_profile.profile_type,
  active_profile.created_at
FROM profile active_profile
LEFT JOIN profile_user membership ON membership.profile_id = active_profile.id
WHERE active_profile.deleted_at IS NULL
GROUP BY active_profile.id, active_profile.profile_type, active_profile.created_at
HAVING count(membership.user_id) = 0
ORDER BY active_profile.created_at, active_profile.id;

-- Informational and valid under F2: retained inactive memberships.
SELECT
  membership.profile_id,
  membership.user_id,
  membership.role,
  deleted_profile.deleted_at
FROM profile_user membership
INNER JOIN profile deleted_profile
  ON deleted_profile.id = membership.profile_id
  AND deleted_profile.deleted_at IS NOT NULL
ORDER BY deleted_profile.deleted_at, membership.profile_id, membership.user_id;

ROLLBACK;
```

## Remediation precondition

Migration `20260723162013_f2_profile_ownership_invariant` does not delete, merge, reassign, or
silently prefer any membership. It aborts before installing enforcement when any of these
preconditions fail:

- a user belongs to more than one active profile;
- an active solo profile has multiple members;
- an active profile that has memberships has no owner.

The operator/product owner must decide the disposition of every conflicting production row. Valid
choices depend on product facts not present in the database—for example which membership to
remove, which profile to mark deleted, whether a solo profile was incorrectly typed, or which
member should become an owner. F2 deliberately provides no automatic remediation or merge query.
After approved remediation, rerun the complete read-only audit and require all invalid result sets
to be empty before applying the migration.

Active profiles with no memberships are reported but do not block the migration because the
repository's feed seed data intentionally contains unowned profiles. They must still be classified
before treating them as real user-created profiles.

## Enforcement and rollout

The migration installs database triggers without adding F3 tables, jobs, events, or runtime Redis
behavior:

1. Membership writes take transaction-scoped advisory locks in deterministic profile/user order.
2. Deferred checks reject more than one active profile per user, including direct SQL and
   concurrent writes.
3. Reactivating a deleted profile rechecks every retained member against current active
   memberships.
4. Solo profiles reject a second member and reject a type change from shared to solo while
   multiple memberships exist.
5. Shared profiles allow multiple members and multiple owners, but membership writes cannot leave
   an active profile with memberships and no owner.
6. Existing `profile_user(user_id)` and `profile_user(profile_id)` indexes support the checks; F2
   needs no additional index.

Deploy the migration before the F2 application code. If its precondition raises an error, leave the
old application running, make no automatic data change, complete the approved remediation, and
retry. Once installed, the application uses the same active predicate at bootstrap and every
profile-scoped authorization boundary.

Stable application/service errors are:

| HTTP/service code                            | Meaning                                                         |
| -------------------------------------------- | --------------------------------------------------------------- |
| `active_profile_conflict`                    | The user already belongs to another active profile.             |
| `solo_profile_membership_forbidden`          | A solo profile cannot gain another member or retain many users. |
| `final_owner_required`                       | The mutation would leave an active profile without an owner.    |
| `membership_forbidden`                       | A non-owner attempted an internal membership mutation.          |
| `membership_exists` / `membership_not_found` | The internal membership mutation conflicts with current state.  |

Profile creation returns HTTP `409` with `active_profile_conflict`. Changing a multi-member shared
profile to `solo` returns HTTP `409` with `solo_profile_membership_forbidden`. Existing
authorization continues to conceal inaccessible profiles with the established `404 Profile not
found` behavior.
