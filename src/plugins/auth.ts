import Elysia from "elysia";

import { betterAuth } from "@/lib/auth";

export const auth = new Elysia({ name: "better-auth" }).mount(betterAuth.handler).macro({
  auth: {
    async resolve({ status, request: { headers } }) {
      const session = await betterAuth.api.getSession({
        headers,
      });
      if (!session) return status(401);
      return {
        user: session.user,
        session: session.session,
      };
    },
  },
});
