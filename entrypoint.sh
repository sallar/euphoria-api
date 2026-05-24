#!/bin/sh
set -e

echo "Running database migrations..."
bun x drizzle-kit migrate
bun run db:seed:profiles

echo "Starting application..."
exec bun run src/index.ts
