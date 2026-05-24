import Elysia, { t } from "elysia";

import {
  profileGenderSchema,
  profileOrientationSchema,
  profileReactionSchema,
  profileRelationshipTypeSchema,
  profileTypeSchema,
} from "./enums";
import { ref } from "./utils";

const writableProfileFields = {
  name: t.String({ minLength: 1, maxLength: 120 }),
  bio: t.Nullable(t.String()),
  profileType: profileTypeSchema,
  gender: profileGenderSchema,
  genderInterests: t.Array(profileGenderSchema),
  genderTags: t.Optional(t.Array(profileGenderSchema)),
  orientation: profileOrientationSchema,
  orientationInterests: t.Array(profileOrientationSchema),
  relationshipTypes: t.Array(profileRelationshipTypeSchema),
  hidden: t.Optional(t.Boolean()),
};

const wirteOnlyFields = {
  lastSeenAt: t.Optional(t.Date()),
  dateOfBirth: t.String({ format: "date" }),
  country: t.String({ minLength: 2, maxLength: 2 }),
  location: t.Object({
    x: t.Number({ minimum: -180, maximum: 180 }), // longitude
    y: t.Number({ minimum: -90, maximum: 90 }), // latitude
  }),
};

const Profile = t.Object({
  id: t.String({ format: "uuid" }),
  createdAt: t.Date(),
  updatedAt: t.Date(),
  ...writableProfileFields,
});

const ProfileInsert = t.Object({
  ...writableProfileFields,
  ...wirteOnlyFields,
});

const ProfileUpdate = t.Partial(ProfileInsert);

const ProfileReactionStatus = t.Object({
  reaction: profileReactionSchema,
});

const ProfileFeedItem = t.Object({
  ...Profile.properties,
  age: t.Number({ minimum: 0 }),
  distance: t.Number({ minimum: 0 }),
});

const ProfileFeedResponse = t.Object({
  data: t.Array(ref("ProfileFeedItem")),
  cursor: t.Nullable(t.Number({ minimum: 0 })),
});

export type Profile = typeof Profile.static;
export type ProfileFeedItem = typeof ProfileFeedItem.static;
export type ProfileFeedResponse = typeof ProfileFeedResponse.static;
export const profileSelectColumns = Object.fromEntries(
  Object.keys(Profile.properties).map((key) => [key, true]),
) as {
  [Key in keyof typeof Profile.properties]: true;
};

export const profileModel = new Elysia({ name: "profile-model" }).model({
  Profile,
  ProfileFeedItem,
  ProfileFeedResponse,
  ProfileInsert,
  ProfileReactionStatus,
  ProfileUpdate,
});
