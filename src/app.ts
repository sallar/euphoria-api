import cors from "@elysia/cors";
import { openapi } from "@elysia/openapi";
import { Elysia } from "elysia";

import {
  createMobileOpenApiDocument,
  createOpenApiDocument,
  openApiInfo,
} from "@/lib/openapi-document";
import { auth } from "@/plugins/auth";
import { chatRoutes } from "@/routes/chat";
import { feedRoutes } from "@/routes/feed";
import { notificationRoutes } from "@/routes/notifications";
import { profileRoutes } from "@/routes/profile";

export const application = new Elysia()
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

application.get("/openapi/mobile.json", () => createMobileOpenApiDocument(application), {
  detail: {
    hide: true,
  },
});

application.get("/", () => ({ healthy: true }), {
  detail: {
    hide: true,
  },
});
