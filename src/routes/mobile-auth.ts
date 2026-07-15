import Elysia from "elysia";

import { betterAuth } from "@/lib/auth";

const unauthorizedResponse = {
  code: "UNAUTHORIZED",
  message: "A valid active bearer token is required",
} as const;

export const mobileAuthBackend = {
  getSession: (headers: Headers) => betterAuth.api.getSession({ headers }),
  signOut: (headers: Headers) => betterAuth.api.signOut({ headers }),
};

const getBearerSession = async (headers: Headers) => {
  const authorization = headers.get("authorization");
  if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) return null;

  return mobileAuthBackend.getSession(headers);
};

export const mobileAuthRoutes = new Elysia({
  prefix: "/api/mobile/auth",
  tags: ["Authentication"],
})
  .get(
    "/session",
    async ({ request, status }) => {
      const session = await getBearerSession(request.headers);
      if (!session) return status(401, unauthorizedResponse);

      return session;
    },
    {
      detail: {
        hide: true,
      },
    },
  )
  .post(
    "/sign-out",
    async ({ request, status }) => {
      const session = await getBearerSession(request.headers);
      if (!session) return status(401, unauthorizedResponse);

      await mobileAuthBackend.signOut(request.headers);
      return { success: true };
    },
    {
      detail: {
        hide: true,
      },
    },
  );
