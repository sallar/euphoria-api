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

let _schema: ReturnType<typeof betterAuth.api.generateOpenAPISchema>;
const getSchema = async () => (_schema ??= betterAuth.api.generateOpenAPISchema());
export const OpenAPI = {
  getPaths: (prefix = "/api/auth") =>
    getSchema().then(({ paths }) => {
      const reference: typeof paths = Object.create(null);
      for (const path of Object.keys(paths)) {
        const key = prefix + path;
        reference[key] = paths[path];
        for (const method of Object.keys(paths[path])) {
          const operation = (reference[key] as any)[method];
          operation.tags = ["Better Auth"];
        }
      }
      return reference;
    }) as Promise<any>,
  components: getSchema().then(({ components }) => components) as Promise<any>,
} as const;
