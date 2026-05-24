import { createSchemaFactory } from "drizzle-orm/typebox-legacy";
import { t } from "elysia";

import {
  profileGenderEnum,
  profileOrientationEnum,
  profileReactionEnum,
  profileRelationshipTypeEnum,
  profileTypeEnum,
  profileUserRoleEnum,
} from "@/db/profile-schema";

export const { createSelectSchema } = createSchemaFactory({
  typeboxInstance: t,
});

export const profileTypeSchema = createSelectSchema(profileTypeEnum);
export const profileGenderSchema = createSelectSchema(profileGenderEnum);
export const profileOrientationSchema = createSelectSchema(profileOrientationEnum);
export const profileRelationshipTypeSchema = createSelectSchema(profileRelationshipTypeEnum);
export const profileUserRoleSchema = createSelectSchema(profileUserRoleEnum);
export const profileReactionSchema = createSelectSchema(profileReactionEnum);
