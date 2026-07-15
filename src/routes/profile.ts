import { and, eq, isNull, sql } from "drizzle-orm";
import Elysia, { t } from "elysia";

import { profile, profileUser } from "@/db/profile-schema";
import { db } from "@/lib/db";
import { findActiveProfile, findOwnedProfile } from "@/lib/profile-queries";
import { commonModel } from "@/models/common";
import { Profile, profileModel, profileSelectColumns } from "@/models/profile";
import { auth } from "@/plugins/auth";
import { setProfileReactionAndSyncConversation } from "@/services/chat-service";

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
          users: {
            id: user.id,
          },
        },
      });

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
        const createdProfile = await db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${user.id}))`);

          const existingProfile = await tx.query.profile.findFirst({
            columns: {
              id: true,
            },
            where: {
              users: {
                id: user.id,
              },
            },
          });

          if (existingProfile) return undefined;

          const [created] = await tx.insert(profile).values(body).returning();

          await tx.insert(profileUser).values({
            profileId: created.id,
            userId: user.id,
            role: "owner",
          });

          return created;
        });

        if (!createdProfile) return status(409, { message: "User already has a profile" });

        return status(201, createdProfile as Profile);
      } catch (error) {
        console.error("Failed to create profile:", error);
        return status(500, { message: "Failed to create profile" });
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

      const [profileAccess] = await findOwnedProfile(params.id, user.id);
      if (!profileAccess) return status(404, { message: "Profile not found" });

      const [updatedProfile] = await db
        .update(profile)
        .set(body)
        .where(and(eq(profile.id, params.id), isNull(profile.deletedAt)))
        .returning();

      if (!updatedProfile) return status(404, { message: "Profile not found" });

      return updatedProfile as Profile;
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

      const [profileAccess] = await findOwnedProfile(params.id, user.id);
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

      const [profileAccess] = await findOwnedProfile(params.id, user.id);
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
