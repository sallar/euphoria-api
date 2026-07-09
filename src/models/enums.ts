import { createSchemaFactory } from "drizzle-orm/typebox-legacy";
import { t } from "elysia";

import { chatMessageTypeEnum as chatMessageTypePgEnum } from "@/db/chat-schema";
import {
  devicePlatformEnum as notificationDevicePlatformEnum,
  notificationChannelEnum as notificationChannelPgEnum,
  notificationDeliveryStatusEnum as notificationDeliveryStatusPgEnum,
  notificationTypeEnum as notificationTypePgEnum,
  pushProviderEnum as notificationPushProviderEnum,
} from "@/db/notification-schema";
import {
  profileGenderEnum,
  profilePrimaryGenderValues,
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
export const profilePrimaryGenderSchema = t.UnionEnum(profilePrimaryGenderValues, {
  default: undefined,
});
export const profileOrientationSchema = createSelectSchema(profileOrientationEnum);
export const profileRelationshipTypeSchema = createSelectSchema(profileRelationshipTypeEnum);
export const profileUserRoleSchema = createSelectSchema(profileUserRoleEnum);
export const profileReactionSchema = createSelectSchema(profileReactionEnum);
export const chatMessageTypeSchema = createSelectSchema(chatMessageTypePgEnum);
export const notificationTypeSchema = createSelectSchema(notificationTypePgEnum);
export const notificationChannelSchema = createSelectSchema(notificationChannelPgEnum);
export const notificationDeliveryStatusSchema = createSelectSchema(
  notificationDeliveryStatusPgEnum,
);
export const pushProviderSchema = createSelectSchema(notificationPushProviderEnum);
export const devicePlatformSchema = createSelectSchema(notificationDevicePlatformEnum);
