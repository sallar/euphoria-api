#!/bin/sh
set -e

echo "Running database migrations..."
bun x drizzle-kit migrate
bun run db:seed:profiles
bun run db:seed:profile-photos

echo "Starting application..."
exec bun run src/index.ts
