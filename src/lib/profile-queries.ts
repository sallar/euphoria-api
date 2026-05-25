import { and, eq, inArray, isNull } from "drizzle-orm";

import {
  profile,
  profilePhoto,
  profileReaction,
  profileReactionValues,
  profileUser,
} from "@/db/profile-schema";
import { db } from "@/lib/db";
import { ProfilePhoto } from "@/models/profile";

import { createPresignedDownloadUrl } from "./s3";

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

export const findPublicProfilePhotos = async (profileIds: string[]) => {
  const photosByProfileId = new Map<string, ProfilePhoto[]>();
  if (!profileIds.length) return photosByProfileId;

  const photos = await db
    .select({
      profileId: profilePhoto.profileId,
      id: profilePhoto.id,
      objectBucket: profilePhoto.objectBucket,
      objectKey: profilePhoto.objectKey,
      hash: profilePhoto.hash,
      position: profilePhoto.position,
      connectionOnly: profilePhoto.connectionOnly,
    })
    .from(profilePhoto)
    .where(
      and(
        inArray(profilePhoto.profileId, profileIds),
        isNull(profilePhoto.deletedAt),
        eq(profilePhoto.connectionOnly, false),
      ),
    )
    .orderBy(
      profilePhoto.profileId,
      profilePhoto.position,
      profilePhoto.createdAt,
      profilePhoto.id,
    );

  for (const { profileId, ...photo } of photos) {
    const signedPhoto = {
      id: photo.id,
      url: createPresignedDownloadUrl({
        bucket: photo.objectBucket,
        key: photo.objectKey,
        expiresIn: 3600,
      }),
      hash: photo.hash,
      position: photo.position,
      connectionOnly: photo.connectionOnly,
    };
    const profilePhotos = photosByProfileId.get(profileId);
    if (profilePhotos) {
      profilePhotos.push(signedPhoto);
      continue;
    }

    photosByProfileId.set(profileId, [signedPhoto]);
  }

  return photosByProfileId;
};
