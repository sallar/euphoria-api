import { expo } from "@better-auth/expo";
import { betterAuth as betterAuthFactory } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { openAPI } from "better-auth/plugins";
import { bearer } from "better-auth/plugins/bearer";

import * as schema from "@/db/auth-schema";

import { db } from "./db";

export const betterAuth = betterAuthFactory({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  emailAndPassword: {
    enabled: true,
  },
  plugins: [openAPI(), expo(), bearer()],
  trustedOrigins: [
    "pluriel://",
    "exp://",
    "exp://**",
    "exp://192.168.*.*:*/**",
    "http://localhost:8081",
  ],
});
