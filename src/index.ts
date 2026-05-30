import cors from "@elysia/cors";
import { openapi } from "@elysia/openapi";
import { Elysia } from "elysia";

import { OpenAPI } from "@/lib/auth";
import { chatRoutes } from "@/routes/chat";
import { feedRoutes } from "@/routes/feed";
import { notificationRoutes } from "@/routes/notifications";
import { profileRoutes } from "@/routes/profile";

import { auth } from "./plugins/auth";

export const app = new Elysia()
  .use(cors())
  .use(
    openapi({
      documentation: {
        components: await OpenAPI.components,
        paths: await OpenAPI.getPaths(),
      },
    }),
  )
  .use(auth)
  .use(chatRoutes)
  .use(feedRoutes)
  .use(notificationRoutes)
  .use(profileRoutes)
  .get("/", () => ({ healthy: true }), {
    detail: {
      hide: true,
    },
  })
  .listen(3000);

console.log(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`);
