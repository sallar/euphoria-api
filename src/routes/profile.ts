import { and, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import Elysia, { t } from "elysia";

import { profile, profileUser } from "@/db/user-schema";
import {
  profileInsertSchema,
  profileSelectSchema,
  profilesSelectSchema,
  profileUpdateSchema,
} from "@/entities/profile";
import { db } from "@/lib/db";
import { auth } from "@/plugins/auth";

export const profileRoutes = new Elysia()
  .use(auth)
  .get(
    "/api/profile",
    async ({ status, user }) => {
      const profiles = await db.query.profile.findMany({
        where: {
          users: {
            id: user.id,
          },
        },
      });

      if (!profiles.length) return status(404, { message: "Profile not found" });

      return status(200, profiles);
    },
    {
      auth: true,
      response: {
        200: profilesSelectSchema,
        404: t.Object({ message: t.String() }),
      },
      tags: ["Profile"],
    },
  )
  .post(
    "/api/profile",
    async ({ body, status, user }) => {
      try {
        const createdProfile = await db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${user.id}))`);

          const existingProfile = await tx.query.profile.findFirst({
            where: {
              users: {
                id: user.id,
              },
            },
          });

          if (existingProfile) return undefined;

          const [created] = await tx
            .insert(profile)
            .values({
              ...body,
              profileType: "solo",
            })
            .returning();

          await tx.insert(profileUser).values({
            profileId: created.id,
            userId: user.id,
            role: "owner",
          });

          return created;
        });

        if (!createdProfile) return status(409, { message: "User already has a profile" });

        return status(201, createdProfile);
      } catch (error) {
        console.error("Failed to create profile:", error);
        return status(500, { message: "Failed to create profile" });
      }
    },
    {
      auth: true,
      body: profileInsertSchema,
      tags: ["Profile"],
    },
  )
  .put(
    "/api/profile/:id",
    async ({ body, params, status, user }) => {
      if (Object.keys(body).length === 0)
        return status(400, { message: "No profile fields provided" });

      const [profileAccess] = await db
        .select({ profileId: profileUser.profileId })
        .from(profileUser)
        .innerJoin(profile, eq(profileUser.profileId, profile.id))
        .where(
          and(
            eq(profileUser.profileId, params.id),
            eq(profileUser.userId, user.id),
            isNull(profile.deletedAt),
          ),
        )
        .limit(1);

      if (!profileAccess) return status(404, { message: "Profile not found" });

      const [updatedProfile] = await db
        .update(profile)
        .set(body)
        .where(and(eq(profile.id, params.id), isNull(profile.deletedAt)))
        .returning();

      if (!updatedProfile) return status(404, { message: "Profile not found" });

      return updatedProfile;
    },
    {
      auth: true,
      params: t.Object({ id: t.String({ format: "uuid" }) }),
      body: profileUpdateSchema,
      response: {
        200: profileSelectSchema,
        400: t.Object({ message: t.String() }),
        404: t.Object({ message: t.String() }),
      },
      tags: ["Profile"],
    },
  );
