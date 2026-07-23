import { and, eq, isNull } from "drizzle-orm";
import Elysia, { t } from "elysia";

import { profile } from "@/db/profile-schema";
import { db } from "@/lib/db";
import {
  ActiveProfileCardinalityError,
  findActiveProfile,
  findActiveProfileMembership,
} from "@/lib/profile-queries";
import { commonModel } from "@/models/common";
import { Profile, profileModel, profileSelectColumns } from "@/models/profile";
import { auth } from "@/plugins/auth";
import { setProfileReactionAndSyncConversation } from "@/services/chat-service";
import {
  createProfileForUser,
  profileInvariantFailureForDatabaseError,
} from "@/services/profile-membership-service";

export const profileRoutes = new Elysia({ prefix: "/api/profile", tags: ["Profile"] })
  .use(auth)
  .use(profileModel)
  .use(commonModel)
  .get(
    "/",
    async ({ status, user }) => {
      const profiles = await db.query.profile.findMany({
        columns: profileSelectColumns,
        where: {
          deletedAt: {
            isNull: true,
          },
          users: {
            id: user.id,
          },
        },
        limit: 2,
      });

      if (profiles.length > 1) throw new ActiveProfileCardinalityError(user.id);
      if (!profiles.length) return [];

      return status(200, profiles as Profile[]);
    },
    {
      auth: true,
      response: {
        200: t.Array(Profile),
      },
      detail: {
        operationId: "listOwnedProfiles",
        security: [{ bearerAuth: [] }],
      },
    },
  )
  .post(
    "/",
    async ({ body, status, user }) => {
      try {
        const result = await createProfileForUser({
          profileInput: body,
          userId: user.id,
        });

        if (!result.ok) return status(409, result.error);

        return status(201, result.data as Profile);
      } catch (error) {
        console.error("Failed to create profile:", error);
        return status(500, {
          code: "profile_creation_failed",
          message: "Failed to create profile",
        });
      }
    },
    {
      auth: true,
      parse: "json",
      body: "ProfileInsert",
      response: {
        201: "Profile",
        409: "ApiErrorResponse",
        500: "ApiErrorResponse",
      },
      detail: {
        operationId: "createProfile",
        security: [{ bearerAuth: [] }],
      },
    },
  )
  .patch(
    "/:id",
    async ({ body, params, status, user }) => {
      if (Object.keys(body).length === 0)
        return status(400, { message: "No profile fields provided" });

      const [profileAccess] = await findActiveProfileMembership(params.id, user.id);
      if (!profileAccess) return status(404, { message: "Profile not found" });

      try {
        const [updatedProfile] = await db
          .update(profile)
          .set(body)
          .where(and(eq(profile.id, params.id), isNull(profile.deletedAt)))
          .returning();

        if (!updatedProfile) return status(404, { message: "Profile not found" });

        return updatedProfile as Profile;
      } catch (error) {
        const invariantFailure = profileInvariantFailureForDatabaseError(error);
        if (invariantFailure) return status(409, invariantFailure.error);
        throw error;
      }
    },
    {
      auth: true,
      parse: "json",
      params: t.Object({ id: t.String({ format: "uuid" }) }),
      body: "ProfileUpdate",
      response: {
        200: "Profile",
        400: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "updateProfile",
        security: [{ bearerAuth: [] }],
      },
    },
  )
  .post(
    "/:id/likes/:targetProfileId",
    async ({ params, status, user }) => {
      if (params.id === params.targetProfileId)
        return status(400, { message: "Profiles cannot like themselves" });

      const [profileAccess] = await findActiveProfileMembership(params.id, user.id);
      if (!profileAccess) return status(404, { message: "Profile not found" });

      const [targetProfile] = await findActiveProfile(params.targetProfileId);
      if (!targetProfile) return status(404, { message: "Target profile not found" });

      const result = await setProfileReactionAndSyncConversation({
        profileId: params.id,
        targetProfileId: params.targetProfileId,
        reaction: "like",
      });

      return status(200, result);
    },
    {
      auth: true,
      params: t.Object({
        id: t.String({ format: "uuid" }),
        targetProfileId: t.String({ format: "uuid" }),
      }),
      response: {
        200: "ProfileReactionStatus",
        400: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "likeProfile",
        security: [{ bearerAuth: [] }],
      },
    },
  )
  .post(
    "/:id/unlikes/:targetProfileId",
    async ({ params, status, user }) => {
      if (params.id === params.targetProfileId)
        return status(400, { message: "Profiles cannot unlike themselves" });

      const [profileAccess] = await findActiveProfileMembership(params.id, user.id);
      if (!profileAccess) return status(404, { message: "Profile not found" });

      const [targetProfile] = await findActiveProfile(params.targetProfileId);
      if (!targetProfile) return status(404, { message: "Target profile not found" });

      const result = await setProfileReactionAndSyncConversation({
        profileId: params.id,
        targetProfileId: params.targetProfileId,
        reaction: "unlike",
      });

      return status(200, result);
    },
    {
      auth: true,
      params: t.Object({
        id: t.String({ format: "uuid" }),
        targetProfileId: t.String({ format: "uuid" }),
      }),
      response: {
        200: "ProfileReactionStatus",
        400: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "unlikeProfile",
        security: [{ bearerAuth: [] }],
      },
    },
  );
