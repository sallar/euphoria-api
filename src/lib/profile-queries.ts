import { and, eq, isNull } from "drizzle-orm";

import { profile, profileReaction, profileReactionValues, profileUser } from "@/db/profile-schema";
import { db } from "@/lib/db";

export type ProfileReaction = (typeof profileReactionValues)[number];

export const findOwnedProfile = (profileId: string, userId: string) =>
  db
    .select({ profileId: profileUser.profileId })
    .from(profileUser)
    .innerJoin(profile, eq(profileUser.profileId, profile.id))
    .where(
      and(
        eq(profileUser.profileId, profileId),
        eq(profileUser.userId, userId),
        isNull(profile.deletedAt),
      ),
    )
    .limit(1);

export const findActiveProfile = (profileId: string) =>
  db
    .select({ id: profile.id })
    .from(profile)
    .where(and(eq(profile.id, profileId), isNull(profile.deletedAt)))
    .limit(1);

export const setProfileReaction = (
  profileId: string,
  targetProfileId: string,
  reaction: ProfileReaction,
) =>
  db
    .insert(profileReaction)
    .values({
      profileId,
      targetProfileId,
      reaction,
    })
    .onConflictDoUpdate({
      target: [profileReaction.profileId, profileReaction.targetProfileId],
      set: {
        reaction,
        updatedAt: new Date(),
      },
    });
