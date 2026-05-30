# Agent Notes

## Project Basics

- Runtime/package manager: Bun.
- Main schema barrel: `src/db/schema.ts`.
- Drizzle config currently reads explicit schema files from `drizzle.config.ts`.
- Auth tables live in `src/db/auth-schema.ts`; app/domain tables can live in feature schema files such as `src/db/profile-schema.ts` or `src/db/notification-schema.ts`.
- When adding a new schema file, export it from `src/db/schema.ts` and add it to the explicit schema list in `drizzle.config.ts`.

## Elysia / Models / Types Notes

- Keep route validation models in `src/models/<feature>.ts` as a named Elysia model plugin:

  ```ts
  export const featureModel = new Elysia({ name: "feature-model" }).model({
    Feature,
    FeatureInsert,
    FeatureUpdate,
  });
  ```

- Export TypeScript types from TypeBox schemas with `typeof Schema.static` so services and websocket helpers share the same response shapes.
- Add Drizzle enum TypeBox schemas in `src/models/enums.ts` with `createSelectSchema(...)`; import the enum from the feature schema file.
- Use `ref("ModelName")` from `src/models/utils.ts` for nested model refs and arrays, for example `t.Array(ref("Notification"))`. Top-level route responses can use registered model names like `"Notification"`.
- Mount the relevant model plugin before routes that use its model names, and mount `commonModel` before using `"MessageResponse"`.
- For query parameters that arrive as strings, prefer Elysia coercion helpers such as `t.Numeric(...)` and `t.BooleanString()`.
- For websocket routes, validate incoming messages with `body: "SomeSocketMessage"`. Avoid complex `response: "SomeSocketEvent"` schemas that contain unions and refs; current Elysia can log `Failed to create exactMirror` at startup for those. Keep socket event objects typed in TypeScript instead.
- If a script and a route need the same behavior, put the real logic in `src/services/*` and call it from both. This matters for in-memory websocket delivery: only code running inside the API process can broadcast to connected sockets.

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
