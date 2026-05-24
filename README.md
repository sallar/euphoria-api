# Euphoria API

## Development
To start the development server run:
```bash
bun dev
```

Open http://localhost:3000/ with your browser to see the result.

To generate a Better Auth bearer token for API testing:

```bash
bun run auth:token <user-id>
```

To seed 100 standalone Helsinki dating profiles for feed testing:

```bash
bun run db:seed:profiles
```

## Docker
A `docker-compose.yml` is provided that sets up the API and a PostgreSQL 17 database.

```bash
docker compose up --build
```

The API runs on port `3000` and Postgres on `5432`. Database migrations are applied automatically on startup.

### Environment variables
Set these via a `.env` file or directly in `docker-compose.yml`:

| Variable              | Default                          | Description            |
| --------------------- | -------------------------------- | ---------------------- |
| `DATABASE_URL`        | `postgresql://...` (in compose)  | Postgres connection    |
| `BETTER_AUTH_SECRET`  | `change-me`                      | Better Auth secret key |
| `BETTER_AUTH_URL`     | `http://localhost:3000`          | Better Auth base URL   |
