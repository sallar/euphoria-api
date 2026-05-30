import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { randomInt, randomUUID } from "node:crypto";

import type { Notification } from "@/models/notification";

import { user } from "@/db/auth-schema";
import { profile, profileUser } from "@/db/profile-schema";
import { db } from "@/lib/db";

import type { NotificationType } from "./notification-service";

import { createNotification } from "./notification-service";

type NotificationTemplate = {
  type: NotificationType;
  title: string;
  body: (actorName: string | undefined) => string;
};

type TestNotificationRecipient = {
  id: string;
  email: string;
  name: string;
};

export type TestNotificationResult = {
  recipient: TestNotificationRecipient;
  notification: Notification;
};

const templates: NotificationTemplate[] = [
  {
    type: "profile_like",
    title: "Someone liked you",
    body: (actorName) => `${actorName ?? "Someone nearby"} sent you a like.`,
  },
  {
    type: "profile_match",
    title: "It's a match",
    body: (actorName) => `You and ${actorName ?? "someone new"} liked each other.`,
  },
  {
    type: "message",
    title: "New message",
    body: (actorName) => `${actorName ?? "Someone"} sent you a message.`,
  },
  {
    type: "system",
    title: "Test notification",
    body: () => "This is a random test notification from the API.",
  },
];

const pickRandom = <Value>(values: Value[]) => values[randomInt(values.length)]!;

const findRecipient = async (id: string) => {
  const [recipient] = await db
    .select({
      id: user.id,
      email: user.email,
      name: user.name,
    })
    .from(user)
    .where(eq(user.id, id))
    .limit(1);

  return recipient;
};

const findRecipientProfile = async (id: string) => {
  const [recipientProfile] = await db
    .select({
      id: profile.id,
      name: profile.name,
    })
    .from(profile)
    .innerJoin(profileUser, eq(profile.id, profileUser.profileId))
    .where(and(eq(profileUser.userId, id), isNull(profile.deletedAt)))
    .limit(1);

  return recipientProfile;
};

const findRandomActorProfile = async (recipientProfileId: string | undefined) => {
  const conditions = [isNull(profile.deletedAt)];
  if (recipientProfileId) conditions.push(ne(profile.id, recipientProfileId));

  const [actorProfile] = await db
    .select({
      id: profile.id,
      name: profile.name,
    })
    .from(profile)
    .where(sql.join(conditions, sql` and `))
    .orderBy(sql`random()`)
    .limit(1);

  return actorProfile;
};

export const sendRandomTestNotification = async (
  userId: string,
): Promise<TestNotificationResult | null> => {
  const recipient = await findRecipient(userId);
  if (!recipient) return null;

  const recipientProfile = await findRecipientProfile(userId);
  const actorProfile = await findRandomActorProfile(recipientProfile?.id);
  const template = pickRandom(templates);
  const notification = await createNotification({
    recipientUserId: recipient.id,
    type: template.type,
    title: template.title,
    body: template.body(actorProfile?.name),
    actorProfileId: template.type === "system" ? null : actorProfile?.id,
    relatedProfileId: recipientProfile?.id,
    data: {
      generatedBy: "test-notification-service",
      generatedAt: new Date().toISOString(),
      testId: randomUUID(),
      actorProfileId: actorProfile?.id ?? null,
      actorProfileName: actorProfile?.name ?? null,
      recipientProfileId: recipientProfile?.id ?? null,
      recipientProfileName: recipientProfile?.name ?? null,
    },
  });

  return {
    recipient,
    notification,
  };
};
