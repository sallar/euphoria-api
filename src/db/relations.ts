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
    profiles: r.many.profile(),
    sessions: r.many.session(),
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
}));
