import Elysia, { t } from "elysia";

import {
  profileGenderSchema,
  profileOrientationSchema,
  profileRelationshipTypeSchema,
  profileTypeSchema,
} from "./enums";

const writableProfileFields = {
  name: t.String({ minLength: 1, maxLength: 120 }),
  bio: t.Nullable(t.String({ maxLength: 1000 })),
  profileType: profileTypeSchema,
  gender: profileGenderSchema,
  genderInterests: t.Array(profileGenderSchema),
  genderTags: t.Optional(t.Array(profileGenderSchema)),
  orientation: profileOrientationSchema,
  orientationInterests: t.Array(profileOrientationSchema),
  relationshipTypes: t.Array(profileRelationshipTypeSchema),
  location: t.Object({
    x: t.Number({ minimum: -90, maximum: 90 }),
    y: t.Number({ minimum: -180, maximum: 180 }),
  }),
  country: t.String({ minLength: 2, maxLength: 2 }),
  dateOfBirth: t.String({ format: "date" }),
};

const Profile = t.Object({
  id: t.String({ format: "uuid" }),
  createdAt: t.Date(),
  updatedAt: t.Date(),
  ...writableProfileFields,
});

const ProfileInsert = t.Object(writableProfileFields);

const ProfileUpdate = t.Partial(ProfileInsert);

export type Profile = typeof Profile.static;
export const profileSelectColumns = Object.fromEntries(
  Object.keys(Profile.properties).map((key) => [key, true]),
) as {
  [Key in keyof typeof Profile.properties]: true;
};

export const profileModel = new Elysia({ name: "profile-model" }).model({
  Profile,
  ProfileInsert,
  ProfileUpdate,
});
