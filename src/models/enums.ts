import { createSchemaFactory } from "drizzle-orm/typebox-legacy";
import Elysia, { t } from "elysia";

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

import { modelRef } from "./utils";

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

export const enumModel = new Elysia({ name: "enum-model" }).model({
  ChatMessageType: chatMessageTypeSchema,
  DevicePlatform: devicePlatformSchema,
  NotificationChannel: notificationChannelSchema,
  NotificationDeliveryStatus: notificationDeliveryStatusSchema,
  NotificationType: notificationTypeSchema,
  ProfileGender: profileGenderSchema,
  ProfileOrientation: profileOrientationSchema,
  ProfilePrimaryGender: profilePrimaryGenderSchema,
  ProfileReactionType: profileReactionSchema,
  ProfileRelationshipType: profileRelationshipTypeSchema,
  ProfileType: profileTypeSchema,
  ProfileUserRole: profileUserRoleSchema,
  PushProvider: pushProviderSchema,
});

export const chatMessageTypeRef = modelRef("ChatMessageType", chatMessageTypeSchema);
export const devicePlatformRef = modelRef("DevicePlatform", devicePlatformSchema);
export const notificationChannelRef = modelRef("NotificationChannel", notificationChannelSchema);
export const notificationDeliveryStatusRef = modelRef(
  "NotificationDeliveryStatus",
  notificationDeliveryStatusSchema,
);
export const notificationTypeRef = modelRef("NotificationType", notificationTypeSchema);
export const profileGenderRef = modelRef("ProfileGender", profileGenderSchema);
export const profileOrientationRef = modelRef("ProfileOrientation", profileOrientationSchema);
export const profilePrimaryGenderRef = modelRef("ProfilePrimaryGender", profilePrimaryGenderSchema);
export const profileReactionRef = modelRef("ProfileReactionType", profileReactionSchema);
export const profileRelationshipTypeRef = modelRef(
  "ProfileRelationshipType",
  profileRelationshipTypeSchema,
);
export const profileTypeRef = modelRef("ProfileType", profileTypeSchema);
export const profileUserRoleRef = modelRef("ProfileUserRole", profileUserRoleSchema);
export const pushProviderRef = modelRef("PushProvider", pushProviderSchema);
