import { openapi } from "@elysia/openapi";
import { Elysia } from "elysia";

import { OpenAPI } from "@/lib/auth";
import { auth } from "@/plugins/auth";

const app = new Elysia()
  .use(
    openapi({
      documentation: {
        components: await OpenAPI.components,
        paths: await OpenAPI.getPaths(),
      },
    }),
  )
  .use(auth)
  .get("/api/me", ({ user }) => user, {
    auth: true,
  })
  .get("/", () => ({ healthy: true }))
  .listen(3000);

console.log(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`);
