# Euphoria API

## Development

Install the locked dependencies:

```bash
bun install --frozen-lockfile
```

To start the development server run:

```bash
bun dev
```

Open http://localhost:3000/ with your browser to see the result.

### Backend v2 architecture

[`docs/backend-v2/PLAN.md`](docs/backend-v2/PLAN.md) is the canonical dependency-ordered Backend v2
plan. Its accepted ADRs define the PostgreSQL/Redis boundary, durable realtime recovery, profile
ownership, notification/push semantics, and cursor policy.

PostgreSQL is canonical for domain state and now contains the dormant F3 substrate for durable
events, per-scope sequences, command idempotency, and leased delivery jobs. The
[`F3 rollout runbook`](docs/backend-v2/F3-DURABLE-SUBSTRATE-ROLLOUT.md) defines its transaction,
retention, lease, cleanup, and production-policy preconditions. The
[`F4 rollout runbook`](docs/backend-v2/F4-TRANSACTIONAL-CHAT-ROLLOUT.md) defines the implemented
atomic chat producer, protocol 2 cutover, retention, event, notification/job, cleanup, and rollback
policy. Production activation remains blocked until the updated client and F5 worker are ready.

Redis is reserved for shared ephemeral coordination: cross-node fan-out,
connection/subscription routing, expiring presence/typing leases, and session-revocation signals.
Redis is not a canonical domain store. The current production runtime does not use Redis yet; chat
and notification socket hubs remain process-local until the later realtime milestone.

### OpenAPI contracts

- `GET /openapi/internal.json` returns the raw Elysia document for backend diagnostics.
- `GET /openapi/json` returns the normalized application REST contract.
- `GET /openapi/mobile.json` returns the application contract plus the supported Better Auth mobile operations.

The public contracts use OpenAPI 3.1, bearer security metadata, JSON-only request bodies, and
path-rooted component pruning so REST clients do not receive websocket-only schemas.

Mobile clients use `GET /api/mobile/auth/session` and `POST /api/mobile/auth/sign-out` for strict
bearer authentication semantics. The underlying Better Auth compatibility routes remain mounted,
but are not published in the mobile contract.

To generate a Better Auth bearer token for API testing:

```bash
bun run auth:token <user-id>
```

To seed 10,000 standalone Helsinki and Espoo dating profiles for feed testing:

```bash
bun run db:seed:profiles
```

### Pagination cursors

Feed, conversation, message, and notification lists use the same versioned opaque cursor policy.
Clients must store and return `cursor` unchanged and must not parse, construct, compare, or move it
between list resources, profiles/users, conversations, paging directions, or filter sets.

The current `c1` cursor authenticates its protected payload with HMAC-SHA-256. The payload carries
the resource, `next` direction, complete normalized sort tuple, and a keyed fingerprint of the
authorization scope and membership/order filters. Raw scope and filter values are not stored in
the fingerprint. Timestamp positions use PostgreSQL epoch microseconds so continuation does not
lose database precision when response dates are represented by JavaScript `Date`.

All malformed, tampered, unsupported-version, wrong-resource, wrong-direction, wrong-scope, and
filter-mismatched cursors return:

```json
{
  "code": "invalid_cursor",
  "message": "Cursor is invalid for this request"
}
```

with HTTP `400`.

`CURSOR_SIGNING_SECRET` is the active signing key. During rotation, put older accepted keys in the
comma-separated `CURSOR_SIGNING_PREVIOUS_SECRETS` value; new cursors use only the active key. For a
compatibility rollout, deployments without `CURSOR_SIGNING_SECRET` fall back to
`BETTER_AUTH_SECRET`. A dedicated random cursor secret is recommended. The F1 wire format does not
accept legacy numeric feed cursors or legacy date-time cursors, so clients with a stored legacy
cursor must restart that list from its first page.

### Push notifications

Existing Expo clients may continue to register without a `provider`; omission means `expo`:

```json
{
  "token": "ExponentPushToken[...]",
  "platform": "ios",
  "deviceId": "optional-installation-id"
}
```

Native Apple clients register an APNs token with its token environment and a stable, nonblank
installation ID:

```json
{
  "provider": "apns",
  "token": "0123456789abcdef",
  "platform": "ios",
  "deviceId": "stable-installation-id",
  "apnsEnvironment": "development"
}
```

Use `development` for tokens issued by an app using the APNs sandbox (normally a local
development-signed build). Use `production` for production APNs tokens, including TestFlight and
App Store builds. APNs device tokens are opaque hex values; the API normalizes their hex case but
does not assume a fixed length.

APNs uses token-based authentication over a reused HTTP/2 connection. `APNS_TOPIC` is deliberately
required: this repository does not contain enough authoritative client configuration to safely
assume `io.martiancode.Pluriel`. Supply the `.p8` key through `APNS_PRIVATE_KEY`, preserving PEM
newlines (escaped `\n` is accepted), or through base64 in `APNS_PRIVATE_KEY_BASE64`. Never commit the
key or either value. If there are no APNs provider attempts, APNs configuration is not loaded, so
Expo-only deployments remain compatible. An APNs `200` or successful Expo ticket confirms provider
acceptance only; it does not confirm that a device displayed or received the notification.

APNs throttling, transport errors, and server failures remain `pending` with `next_attempt_at` set.
This is the retry-worker seam; the repository does not currently include a retry worker.

## Docker
A `docker-compose.yml` is provided that sets up the API and a PostgreSQL 17 database.

```bash
docker compose up --build
```

The API runs on port `3000` and Postgres on `5432`. Database migrations are applied automatically on startup.

### PostgreSQL + Redis integration tests

The integration profile starts a dedicated PostGIS/PostgreSQL database and nonpersistent Redis
instance. It does not start the API or reuse the development database:

```bash
bun run test:integration:services:up
bun run test:integration
bun run test:integration:services:down
```

The services default to:

- PostgreSQL: `postgresql://postgres:postgres@127.0.0.1:55432/euphoria_integration`
- Redis: `redis://127.0.0.1:56379`

`test:integration` applies the existing Drizzle migrations and runs the PostgreSQL/Redis smoke test
plus tie-heavy cursor traversal, F2 ownership, and F3 command/event/job concurrency tests against
the migrated application tables. Each test harness creates a random PostgreSQL schema and
namespaced Redis keys, then removes only those resources; application fixtures use explicit unique
IDs and are removed after their suite. Durable event scope metadata intentionally remains until the
integration tmpfs is recreated because production scope sequence boundaries are permanent. The
smoke test also gives its key a short TTL. The harness refuses a database name that does not contain
`integration`.

The repository's PostGIS 17 image currently publishes an AMD64 runtime, so the integration service
declares `linux/amd64`; Apple Silicon Docker runtimes must have x86 emulation enabled.

Override the defaults with `INTEGRATION_DATABASE_URL` and `INTEGRATION_REDIS_URL`. If host ports
must change, set `INTEGRATION_POSTGRES_PORT`/`INTEGRATION_REDIS_PORT` for Docker Compose and provide
matching URLs to the test process.

The ordinary suite remains:

```bash
bun run test
```

The integration smoke test is skipped by that command unless `RUN_INTEGRATION_TESTS=1`; use the
documented integration command so migrations and service configuration are applied consistently.

### Environment variables
Set these via a `.env` file or directly in `docker-compose.yml`:

| Variable                          | Default                         | Description                                                                       |
| --------------------------------- | ------------------------------- | --------------------------------------------------------------------------------- |
| `DATABASE_URL`                    | `postgresql://...` (in compose) | Postgres connection                                                               |
| `BETTER_AUTH_SECRET`              | `change-me`                     | Better Auth secret key                                                            |
| `BETTER_AUTH_URL`                 | `http://localhost:3000`         | Better Auth base URL                                                              |
| `CURSOR_SIGNING_SECRET`           | Falls back to auth secret       | Active HMAC key for opaque application cursors; use a dedicated random value       |
| `CURSOR_SIGNING_PREVIOUS_SECRETS` |                                 | Optional comma-separated previous cursor keys accepted during rotation             |
| `EXPO_ACCESS_TOKEN`               |                                 | Optional Expo push access token                                                    |
| `APNS_TEAM_ID`                    |                                 | Apple Developer team ID                                                           |
| `APNS_KEY_ID`                     |                                 | APNs authentication key ID                                                        |
| `APNS_PRIVATE_KEY`                |                                 | APNs `.p8` PEM contents; escaped `\n` is accepted                                 |
| `APNS_PRIVATE_KEY_BASE64`         |                                 | Base64 `.p8` PEM alternative to `APNS_PRIVATE_KEY`                                 |
| `APNS_TOPIC`                      |                                 | Required APNs topic (normally the native app bundle ID); no implicit default       |
| `BACKBLAZE_S3_ACCESS_KEY_ID`      |                                 | Backblaze S3 key ID                                                               |
| `BACKBLAZE_S3_SECRET_ACCESS_KEY`  |                                 | Backblaze S3 application key                                                      |
| `BACKBLAZE_S3_ENDPOINT`           |                                 | Backblaze S3 endpoint, e.g. `https://s3.us-west-004.backblazeb2.com`               |
| `BACKBLAZE_S3_REGION`             |                                 | Optional region used to build the endpoint when `BACKBLAZE_S3_ENDPOINT` is unset  |
