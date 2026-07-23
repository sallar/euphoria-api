# ADR 0007: Media asset lifecycle

Status: accepted  
Date: 2026-07-23

## Context

The database can store seeded profile-photo object keys and image-shaped chat attachments, while
feed responses sign photo URLs. There is no server-managed upload-session/processing lifecycle,
gallery mutation API, or image-message creation flow. Treating URLs or client-chosen object keys as
canonical media identity would make authorization, expiry, cleanup, and reuse unsafe.

## Decision

Media identity is a server-owned `media_asset` ID. Uploads use expiring upload sessions with
server-generated object keys, declared purpose/content constraints, and lifecycle states such as
pending upload, processing, ready, rejected, and deleted.

Finalize verifies object existence, size, checksum/type, and ownership before durable processing.
Processing validates/decodes images, strips unsafe metadata, applies orientation/format/dimension
policy, and creates required derivatives. Only ready assets can be attached to a gallery or
message. Cleanup is durable job work.

Gallery entries and image messages reference asset IDs, not permanent URLs. Access checks use
current ownership/membership, match/visibility state, and asset purpose. Short-lived signed
rendition URLs are generated at read time and can expire without changing entity identity.

The dependency order is:

1. media asset/upload-session lifecycle;
2. profile gallery CRUD/reorder/visibility/delete and peer primary-photo projection;
3. image messages using ready authorized assets;
4. profile deletion lifecycle integrating asset retention/cleanup.

## Consequences

- Clients cannot choose canonical storage keys or attach foreign/pending assets.
- Object-store state can be reconciled and cleaned after crashes or abandoned uploads.
- Connection-only access is checked when signing, not encoded as a permanent URL capability.
- Existing photo rows require an explicit migration/backfill design in the later media milestone;
  this ADR does not perform it.
- Media work remains separate from F1 cursors and core realtime correctness.
