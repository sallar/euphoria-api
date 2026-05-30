import { defineRelations } from "drizzle-orm";

import * as schema from "./schema";

export const relations = defineRelations(schema, (r) => ({
  account: {
    user: r.one.user({
      from: r.account.userId,
      to: r.user.id,
    }),
  },
  user: {
    accounts: r.many.account(),
    notificationDeliveries: r.many.notificationDelivery(),
    notifications: r.many.notification(),
    profiles: r.many.profile(),
    pushTokens: r.many.userPushToken(),
    sessions: r.many.session(),
  },
  notification: {
    deliveries: r.many.notificationDelivery(),
    recipient: r.one.user({
      from: r.notification.recipientUserId,
      to: r.user.id,
    }),
  },
  notificationDelivery: {
    notification: r.one.notification({
      from: r.notificationDelivery.notificationId,
      to: r.notification.id,
    }),
    pushToken: r.one.userPushToken({
      from: r.notificationDelivery.pushTokenId,
      to: r.userPushToken.id,
    }),
    recipient: r.one.user({
      from: r.notificationDelivery.recipientUserId,
      to: r.user.id,
    }),
  },
  profile: {
    photos: r.many.profilePhoto(),
    users: r.many.user({
      from: r.profile.id.through(r.profileUser.profileId),
      to: r.user.id.through(r.profileUser.userId),
    }),
  },
  profilePhoto: {
    profile: r.one.profile({
      from: r.profilePhoto.profileId,
      to: r.profile.id,
    }),
  },
  session: {
    user: r.one.user({
      from: r.session.userId,
      to: r.user.id,
    }),
  },
  userPushToken: {
    deliveries: r.many.notificationDelivery(),
    user: r.one.user({
      from: r.userPushToken.userId,
      to: r.user.id,
    }),
  },
}));
