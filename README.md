# Euphoria API

## Development
To start the development server run:
```bash
bun dev
```

Open http://localhost:3000/ with your browser to see the result.

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
key or either value. If no APNs registrations are delivered, APNs configuration is not loaded, so
Expo-only deployments remain compatible.

APNs throttling, transport errors, and server failures remain `pending` with `next_attempt_at` set.
This is the retry-worker seam; the repository does not currently include a retry worker.

## Docker
A `docker-compose.yml` is provided that sets up the API and a PostgreSQL 17 database.

```bash
docker compose up --build
```

The API runs on port `3000` and Postgres on `5432`. Database migrations are applied automatically on startup.

### Environment variables
Set these via a `.env` file or directly in `docker-compose.yml`:

| Variable                          | Default                         | Description                                                                       |
| --------------------------------- | ------------------------------- | --------------------------------------------------------------------------------- |
| `DATABASE_URL`                    | `postgresql://...` (in compose) | Postgres connection                                                               |
| `BETTER_AUTH_SECRET`              | `change-me`                     | Better Auth secret key                                                            |
| `BETTER_AUTH_URL`                 | `http://localhost:3000`         | Better Auth base URL                                                              |
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
