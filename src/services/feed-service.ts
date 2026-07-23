import { sql } from "drizzle-orm";
import { parsePgArray } from "drizzle-orm/pg-core";

import type { ProfileFeedItem } from "@/models/profile";

import { profile, profileReaction, profileUser } from "@/db/profile-schema";
import { decodeCursor, encodeCursor } from "@/lib/cursor";
import { db } from "@/lib/db";
import { findOwnedProfile, findPublicProfilePhotos } from "@/lib/profile-queries";

const defaultPageSize = 20;
const maxPageSize = 100;
const feedArrayFields = [
  "genderTags",
  "genderInterests",
  "orientationInterests",
  "relationshipTypes",
] as const;

type FeedArrayField = (typeof feedArrayFields)[number];
type ProfileFeedItemWithoutPhotos = Omit<ProfileFeedItem, "photos">;
type RawProfileFeedItem = Omit<ProfileFeedItemWithoutPhotos, FeedArrayField> & {
  [Key in FeedArrayField]: ProfileFeedItem[Key] | string;
} & {
  cursorDistanceMeters: number;
};

type FeedServiceResult =
  | {
      ok: true;
      data: {
        data: ProfileFeedItem[];
        cursor: string | null;
      };
    }
  | {
      ok: false;
      message: string;
    };

const parseProfileArray = <Value extends string>(value: Value[] | string | undefined): Value[] => {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  return parsePgArray(value) as Value[];
};

const normalizeProfileFeedItem = ({
  cursorDistanceMeters,
  ...item
}: RawProfileFeedItem): {
  cursorDistanceMeters: number;
  item: ProfileFeedItemWithoutPhotos;
} => ({
  cursorDistanceMeters,
  item: {
    ...item,
    genderTags: parseProfileArray(item.genderTags),
    genderInterests: parseProfileArray(item.genderInterests),
    orientationInterests: parseProfileArray(item.orientationInterests),
    relationshipTypes: parseProfileArray(item.relationshipTypes),
  },
});

export const normalizeFeedLimit = (limit: number | undefined) =>
  Math.min(Math.max(Math.trunc(limit ?? defaultPageSize), 1), maxPageSize);

export const listProfileFeed = async ({
  cursor,
  limit,
  maxAge,
  minAge,
  profileId,
  profileType,
  radius,
  userId,
}: {
  cursor?: string;
  limit?: number;
  maxAge: number;
  minAge: number;
  profileId: string;
  profileType?: ProfileFeedItem["profileType"];
  radius: number;
  userId: string;
}): Promise<FeedServiceResult> => {
  const [profileAccess] = await findOwnedProfile(profileId, userId);
  if (!profileAccess) return { ok: false, message: "Profile not found" };

  const pageSize = normalizeFeedLimit(limit);
  const normalizedProfileType = profileType ?? null;
  const radiusMeters = radius * 1000;
  const context = {
    userId,
    profileId,
    radiusMeters,
    minAge,
    maxAge,
    profileType: normalizedProfileType,
  };
  const cursorSort = cursor
    ? decodeCursor({
        cursor,
        resource: "profile-feed",
        direction: "next",
        context,
      })
    : null;

  const feed = (await db.execute(sql`
    with actor as (
      select
        ${profile.id} as id,
        ${profile.gender} as gender,
        ${profile.genderInterests} as gender_interests,
        ${profile.orientation} as orientation,
        ${profile.orientationInterests} as orientation_interests,
        ${profile.location} as location
      from ${profile}
      where ${profile.id} = ${profileId}
        and ${profile.deletedAt} is null
    ),
    feed_candidates as (
      select
        candidate.id,
        candidate.created_at as "createdAt",
        candidate.updated_at as "updatedAt",
        candidate.profile_type as "profileType",
        candidate.name,
        candidate.bio,
        candidate.gender,
        candidate.gender_tags as "genderTags",
        candidate.gender_interests as "genderInterests",
        candidate.orientation,
        candidate.orientation_interests as "orientationInterests",
        candidate.relationship_types as "relationshipTypes",
        candidate.hidden,
        date_part('year', age(current_date, candidate.date_of_birth))::int as age,
        st_distance(candidate.location, actor.location) as distance_meters
      from ${profile} candidate
      cross join actor
      where candidate.id <> actor.id
        and candidate.deleted_at is null
        and candidate.hidden = false
        and candidate.gender = any(actor.gender_interests)
        and candidate.gender_interests @> array[actor.gender]::profile_gender[]
        and candidate.orientation = any(actor.orientation_interests)
        and candidate.orientation_interests @> array[actor.orientation]::profile_orientation[]
        and candidate.date_of_birth <= (current_date - make_interval(years => ${minAge}::int))::date
        and candidate.date_of_birth > (current_date - make_interval(years => ${maxAge + 1}::int))::date
        and (${normalizedProfileType}::profile_type is null or candidate.profile_type = ${normalizedProfileType}::profile_type)
        and st_dwithin(candidate.location, actor.location, ${radiusMeters})
        and not exists (
          select 1
          from ${profileUser} actor_user
          where actor_user.profile_id = candidate.id
            and actor_user.user_id = ${userId}
        )
        and not exists (
          select 1
          from ${profileReaction} reaction
          where reaction.profile_id = actor.id
            and reaction.target_profile_id = candidate.id
        )
    )
    select
      id,
      "createdAt",
      "updatedAt",
      "profileType",
      name,
      bio,
      gender,
      "genderTags",
      "genderInterests",
      orientation,
      "orientationInterests",
      "relationshipTypes",
      hidden,
      age,
      (distance_meters / 1000.0)::double precision as "distance",
      distance_meters::double precision as "cursorDistanceMeters"
    from feed_candidates
    where ${cursorSort?.distanceMeters ?? null}::double precision is null
      or distance_meters > ${cursorSort?.distanceMeters ?? null}::double precision
      or (
        distance_meters = ${cursorSort?.distanceMeters ?? null}::double precision
        and id > ${cursorSort?.profileId ?? null}::uuid
      )
    order by distance_meters asc, id asc
    limit ${pageSize + 1}
  `)) as RawProfileFeedItem[];

  const normalizedFeed = feed.map(normalizeProfileFeedItem);
  const pageRows = normalizedFeed.slice(0, pageSize);
  const photosByProfileId = await findPublicProfilePhotos(pageRows.map(({ item }) => item.id));
  const data = pageRows.map(
    ({ item }): ProfileFeedItem => ({
      ...item,
      photos: photosByProfileId.get(item.id) ?? [],
    }),
  );
  const lastReturned = pageRows[pageRows.length - 1];
  const nextCursor =
    normalizedFeed.length > pageSize && lastReturned
      ? encodeCursor({
          resource: "profile-feed",
          direction: "next",
          context,
          sort: {
            distanceMeters: lastReturned.cursorDistanceMeters,
            profileId: lastReturned.item.id,
          },
        })
      : null;

  return {
    ok: true,
    data: {
      data,
      cursor: nextCursor,
    },
  };
};
