import cors from "@elysia/cors";
import { openapi } from "@elysia/openapi";
import { Elysia } from "elysia";

import { OpenAPI } from "@/lib/auth";
import { profileRoutes } from "@/routes/profile";

const app = new Elysia()
  .use(cors())
  .use(
    openapi({
      documentation: {
        components: await OpenAPI.components,
        paths: await OpenAPI.getPaths(),
      },
    }),
  )
  .use(profileRoutes)
  .get("/", () => ({ healthy: true }))
  .listen(3000);

console.log(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`);
