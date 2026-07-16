import "dotenv/config";
import type { Logger } from "drizzle-orm/logger";

import { drizzle } from "drizzle-orm/bun-sql";

import { relations } from "@/db/relations";

export const parameterRedactingDatabaseLogger: Logger = {
  logQuery(query) {
    console.log(`Query: ${query}`);
  },
};

export const db = drizzle({
  connection: process.env.DATABASE_URL!,
  casing: "snake_case",
  relations,
  logger: process.env.NODE_ENV === "development" ? parameterRedactingDatabaseLogger : false,
});
