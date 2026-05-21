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
    users: r.many.user({
      from: r.profile.id.through(r.profileUser.profileId),
      to: r.user.id.through(r.profileUser.userId),
    }),
  },
  session: {
    user: r.one.user({
      from: r.session.userId,
      to: r.user.id,
    }),
  },
}));
