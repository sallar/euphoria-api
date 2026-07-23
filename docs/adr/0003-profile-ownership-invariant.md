# ADR 0003: Profile ownership invariant

Status: accepted  
Date: 2026-07-23

## Context

The create route serializes by user and returns `409` when that user already has a profile. The
client selects the first owned profile. The `profile_user` table is nevertheless many-to-many and
does not prevent a user from being attached to multiple active profiles. This is a half-supported
multi-profile model: switching, authorization scope, notifications, presence, and client state do
not define consistent behavior for it.

## Decision

The current-product invariant is zero or one active profile per user.

Multiple users may remain members of one profile only when couple/group ownership genuinely
requires it. Membership roles and authorization must be explicit. "One profile per user" does not
mean "one user per profile."

Before database enforcement, the implementation milestone audits existing rows and resolves any
user attached to multiple active profiles. The database and all membership mutations must then
enforce the invariant under concurrency, not only the profile-create route.

## Rejected current alternative

Fully supporting multiple profiles per user is valid only as a separate product milestone. It
would require explicit active-profile selection and switching, per-profile authorization,
notification routing, socket generation changes, client cache partitioning, and UX. Keeping the
schema permissive while those behaviors are absent is rejected because outcomes depend on row
ordering and entry point.

## Consequences

- APIs may retain collection-shaped owned-profile responses for forward compatibility, but
  current behavior must never silently choose among multiple active profiles.
- Durable chat scopes use explicit profile IDs even with the zero/one user invariant.
- Couple/group membership is preserved only with tested product semantics; unused generic
  membership should be removed rather than implied.
