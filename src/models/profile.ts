import Elysia, { t } from "elysia";

import {
  profileGenderSchema,
  profileOrientationSchema,
  profilePrimaryGenderSchema,
  profileReactionSchema,
  profileRelationshipTypeSchema,
  profileTypeSchema,
} from "./enums";

const ProfilePhoto = t.Object({
  id: t.String({ format: "uuid" }),
  position: t.Integer({ minimum: 0 }),
  connectionOnly: t.Boolean(),
  hash: t.String(),
  url: t.String(),
});
export type ProfilePhoto = typeof ProfilePhoto.static;

const requiredProfileFields = {
  name: t.String({ minLength: 1, maxLength: 120 }),
  profileType: profileTypeSchema,
  gender: profilePrimaryGenderSchema,
  genderInterests: t.Array(profileGenderSchema),
  orientation: profileOrientationSchema,
  orientationInterests: t.Array(profileOrientationSchema),
  relationshipTypes: t.Array(profileRelationshipTypeSchema),
  location: t.Object({
    x: t.Number({ minimum: -180, maximum: 180 }), // longitude
    y: t.Number({ minimum: -90, maximum: 90 }), // latitude
  }),
};

const identityProfileFields = {
  dateOfBirth: t.String({ format: "date" }),
  country: t.String({ minLength: 2, maxLength: 2 }),
};

export const Profile = t.Object({
  id: t.String({ format: "uuid" }),
  createdAt: t.Date(),
  updatedAt: t.Date(),
  ...requiredProfileFields,
  bio: t.Nullable(t.String()),
  ...identityProfileFields,
  genderTags: t.Array(profileGenderSchema),
  hidden: t.Boolean(),
});

const ProfileInsert = t.Object({
  ...requiredProfileFields,
  bio: t.Optional(t.String()),
  ...identityProfileFields,
  genderTags: t.Optional(t.Array(profileGenderSchema)),
  hidden: t.Optional(t.Boolean()),
});

const ProfileUpdate = t.Partial(
  t.Object({
    ...requiredProfileFields,
    bio: t.String(),
    ...identityProfileFields,
    genderTags: t.Array(profileGenderSchema),
    hidden: t.Boolean(),
  }),
);

const ProfileReactionStatus = t.Object({
  reaction: profileReactionSchema,
  matched: t.Optional(t.Boolean()),
  conversationId: t.Optional(t.Nullable(t.String({ format: "uuid" }))),
});

const ProfileFeedItem = t.Object({
  ...t.Omit(Profile, ["location", "dateOfBirth", "country"]).properties,
  age: t.Integer({ minimum: 0 }),
  photos: t.Array(ProfilePhoto),
  distance: t.Number({ minimum: 0 }),
});

const ProfileFeedResponse = t.Object({
  data: t.Array(ProfileFeedItem),
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
  ProfilePhoto,
});
