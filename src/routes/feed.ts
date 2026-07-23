import Elysia, { t } from "elysia";

import { commonModel } from "@/models/common";
import { OpaqueCursor } from "@/models/cursor";
import { profileTypeSchema } from "@/models/enums";
import { profileModel } from "@/models/profile";
import { auth } from "@/plugins/auth";
import { listProfileFeed } from "@/services/feed-service";

const maxPageSize = 100;

export const feedRoutes = new Elysia({ prefix: "/api/profile", tags: ["Feed"] })
  .use(auth)
  .use(profileModel)
  .use(commonModel)
  .get(
    ":profileId/feed",
    async ({ params, query, status, user }) => {
      const minAge = Math.trunc(query.minAge);
      const maxAge = Math.trunc(query.maxAge);

      if (minAge > maxAge) return status(400, { message: "minAge cannot be greater than maxAge" });

      const result = await listProfileFeed({
        cursor: query.cursor,
        limit: query.limit,
        maxAge,
        minAge,
        profileId: params.profileId,
        profileType: query.profileType,
        radius: query.radius,
        userId: user.id,
      });
      if (!result.ok) return status(404, { message: result.message });

      return result.data;
    },
    {
      auth: true,
      params: t.Object({
        profileId: t.String({ format: "uuid" }),
      }),
      query: t.Object({
        radius: t.Numeric({ exclusiveMinimum: 0, maximum: 500 }),
        minAge: t.Numeric({ minimum: 18, maximum: 120, multipleOf: 1 }),
        maxAge: t.Numeric({ minimum: 18, maximum: 120, multipleOf: 1 }),
        cursor: t.Optional(OpaqueCursor),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: maxPageSize, multipleOf: 1 })),
        profileType: t.Optional(profileTypeSchema),
      }),
      response: {
        200: "ProfileFeedResponse",
        400: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "listProfileFeed",
        security: [{ bearerAuth: [] }],
      },
    },
  );
