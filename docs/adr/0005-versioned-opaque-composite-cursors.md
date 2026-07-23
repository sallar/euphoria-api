# ADR 0005: Versioned opaque composite cursors

Status: accepted  
Date: 2026-07-23

## Context

Current list queries use deterministic secondary IDs in their `ORDER BY`, but their cursors encode
only distance or timestamp. Conversation, message, and notification lists also derive the cursor
from the lookahead row, which can skip it on the next request.

## Decision

Every paginated API uses a versioned opaque string cursor. Its authenticated server payload
contains:

- cursor format version and resource;
- paging direction;
- the complete normalized sort tuple, including every tie-breaker;
- a fingerprint of authorization scope and all filters that affect membership/order.

Clients store and return the string unchanged. They do not parse, construct, compare, or transfer a
cursor between resources, scopes, profiles/users, or filter sets.

The query applies a strict lexicographic predicate that exactly matches the declared ordering. It
fetches `limit + 1`, returns at most `limit`, and emits a next cursor from the last returned row only
when the extra row proves another page exists.

Malformed, tampered, unsupported-version, expired (if expiration is later introduced),
resource-mismatched, scope-mismatched, and filter-mismatched cursors receive a stable `400` error.
The fingerprint contains no raw sensitive filter/scope data.

## Consequences

- Feed cursors change from numbers to opaque strings; timestamp-shaped cursor schemas also become
  opaque strings.
- The server may evolve cursor internals through version dispatch without creating a client
  contract for the payload.
- Tie-heavy traversal integration tests are mandatory for every paginated endpoint.
- Cursor signing/key rotation and error codes belong in the shared codec, not individual routes.
