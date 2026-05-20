import {
  profileGenderEnum,
  profileOrientationEnum,
  profileRelationshipTypeEnum,
  profileTypeEnum,
  profileUserRoleEnum,
} from "@/db/user-schema";

import { createSelectSchema } from "./factory";

export const profileTypeSchema = createSelectSchema(profileTypeEnum);
export const profileGenderSchema = createSelectSchema(profileGenderEnum);
export const profileOrientationSchema = createSelectSchema(profileOrientationEnum);
export const profileRelationshipTypeSchema = createSelectSchema(profileRelationshipTypeEnum);
export const profileUserRoleSchema = createSelectSchema(profileUserRoleEnum);

export type ProfileType = typeof profileTypeSchema.static;
export type ProfileGender = typeof profileGenderSchema.static;
export type ProfileOrientation = typeof profileOrientationSchema.static;
export type ProfileRelationshipType = typeof profileRelationshipTypeSchema.static;
export type ProfileUserRole = typeof profileUserRoleSchema.static;
