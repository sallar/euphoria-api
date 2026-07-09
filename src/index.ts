import cors from "@elysia/cors";
import { openapi } from "@elysia/openapi";
import { Elysia } from "elysia";

import { createOpenApiDocument, openApiInfo } from "@/lib/openapi-document";
import { chatRoutes } from "@/routes/chat";
import { feedRoutes } from "@/routes/feed";
import { notificationRoutes } from "@/routes/notifications";
import { profileRoutes } from "@/routes/profile";

import { auth } from "./plugins/auth";

const application = new Elysia()
  .use(cors())
  .use(
    openapi({
      documentation: {
        openapi: "3.1.0",
        info: openApiInfo,
      },
      exclude: {
        methods: ["options", "ws"],
      },
      scalar: {
        url: "/openapi/json",
      },
      specPath: "/openapi/internal.json",
    }),
  )
  .use(auth)
  .use(chatRoutes)
  .use(feedRoutes)
  .use(notificationRoutes)
  .use(profileRoutes);

application.get("/openapi/json", () => createOpenApiDocument(application), {
  detail: {
    hide: true,
  },
});

application.get("/", () => ({ healthy: true }), {
  detail: {
    hide: true,
  },
});

export const app = application.listen(3000);

console.log(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`);
