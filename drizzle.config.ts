import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: [
    "./src/db/auth-schema.ts",
    "./src/db/profile-schema.ts",
    "./src/db/chat-schema.ts",
    "./src/db/notification-schema.ts",
    "./src/db/durable-schema.ts",
  ],
  dialect: "postgresql",
  extensionsFilters: ["postgis"],
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
