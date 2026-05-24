import { and, eq, isNull, sql } from "drizzle-orm";
import { parsePgArray } from "drizzle-orm/pg-core";
import Elysia, { t } from "elysia";

import { profile, profileReaction, profileUser } from "@/db/profile-schema";
import { db } from "@/lib/db";
import { commonModel } from "@/models/common";
import { type ProfileFeedItem, profileModel } from "@/models/profile";
import { ref } from "@/models/utils";
import { auth } from "@/plugins/auth";

const defaultPageSize = 20;
const maxPageSize = 100;
const feedArrayFields = [
  "genderTags",
  "genderInterests",
  "orientationInterests",
  "relationshipTypes",
] as const;

type FeedArrayField = (typeof feedArrayFields)[number];
type RawProfileFeedItem = Omit<ProfileFeedItem, FeedArrayField> & {
  [Key in FeedArrayField]: ProfileFeedItem[Key] | string;
};

const parseProfileArray = <Value extends string>(value: Value[] | string | undefined): Value[] => {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  return parsePgArray(value) as Value[];
};

const normalizeProfileFeedItem = (item: RawProfileFeedItem): ProfileFeedItem => ({
  ...item,
  genderTags: parseProfileArray(item.genderTags),
  genderInterests: parseProfileArray(item.genderInterests),
  orientationInterests: parseProfileArray(item.orientationInterests),
  relationshipTypes: parseProfileArray(item.relationshipTypes),
});

const findOwnedProfile = (profileId: string, userId: string) =>
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

export const feedRoutes = new Elysia()
  .use(auth)
  .use(profileModel)
  .use(commonModel)
  .get(
    "/api/profile/:profileId/feed",
    async ({ params, query, status, user }) => {
      const minAge = Math.trunc(query.minAge);
      const maxAge = Math.trunc(query.maxAge);

      if (minAge > maxAge) return status(400, { message: "minAge cannot be greater than maxAge" });

      const [profileAccess] = await findOwnedProfile(params.profileId, user.id);
      if (!profileAccess) return status(404, { message: "Profile not found" });

      const cursorMeters = query.cursor === undefined ? null : query.cursor * 1000;
      const pageSize = Math.trunc(query.pageSize ?? defaultPageSize);
      const queryLimit = pageSize + 1;
      const radiusMeters = query.radius * 1000;

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
          where ${profile.id} = ${params.profileId}
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
            and st_dwithin(candidate.location, actor.location, ${radiusMeters})
            and not exists (
              select 1
              from ${profileUser} actor_user
              where actor_user.profile_id = candidate.id
                and actor_user.user_id = ${user.id}
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
          (distance_meters / 1000.0)::double precision as "distance"
        from feed_candidates
        where ${cursorMeters}::double precision is null
          or distance_meters > ${cursorMeters}::double precision
        order by distance_meters asc, id asc
        limit ${queryLimit}
      `)) as RawProfileFeedItem[];

      const normalizedFeed = feed.map(normalizeProfileFeedItem);
      const data = normalizedFeed.slice(0, pageSize);
      const cursor =
        normalizedFeed.length > pageSize ? (data[data.length - 1]?.distance ?? null) : null;

      return { data, cursor };
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
        cursor: t.Optional(t.Numeric({ minimum: 0 })),
        pageSize: t.Optional(t.Numeric({ minimum: 1, maximum: maxPageSize, multipleOf: 1 })),
      }),
      response: {
        200: ref("ProfileFeedResponse"),
        400: "MessageResponse",
        404: "MessageResponse",
      },
      tags: ["Feed"],
    },
  );
