#!/bin/sh
set -e

echo "Running database migrations..."
bun x drizzle-kit migrate

echo "Starting application..."
exec bun run src/index.ts
