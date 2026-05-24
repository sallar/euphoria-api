# Agent Notes

## Project Basics

- Runtime/package manager: Bun.
- Main schema barrel: `src/db/schema.ts`.
- Drizzle config currently reads explicit schema files from `drizzle.config.ts`.
- Auth tables live in `src/db/auth-schema.ts`; app/domain tables can live in `src/db/profile-schema.ts`.

## Verification Commands

- Type-check with:

  ```sh
  bunx tsc --noEmit --ignoreDeprecations 6.0
  ```

- Plain `bunx tsc --noEmit` currently fails before checking the code because `tsconfig.json` uses deprecated `moduleResolution=node10`.

- Format-check the repo with:

  ```sh
  bun run fmt:check
  ```

- Lint the repo with:

  ```sh
  bun run lint
  ```

- For a faster focused check while iterating, `bunx oxfmt --check <files>` and `bunx oxlint <files>` are also fine.

## Drizzle / PostGIS Notes

- Drizzle ORM is `^1.0.0-beta.22`; current docs support array-style table callbacks for indexes and `timestamp().defaultNow().$onUpdate(...)`.
- In this dating-app domain, "unlike" means an explicit negative profile decision, not undoing a like. Store profile decisions as mutually exclusive reactions such as `like` / `unlike` rather than modeling unlike as a delete.
- Avoid naming a PostgreSQL enum the same as a table. PostgreSQL creates a composite type for each table, so an enum named `profile_reaction` conflicts with a table named `profile_reaction`; prefer names like `profile_reaction_type`.
- For proximity feed queries, prefer PostGIS `geography(Point,4326)` plus a GiST index over separate latitude/longitude columns.
- Migrations that use geography require:

  ```sql
  CREATE EXTENSION IF NOT EXISTS postgis;
  ```

- Coordinate order for PostGIS points is longitude, latitude.
