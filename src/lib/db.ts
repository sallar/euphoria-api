import "dotenv/config";
import { drizzle } from "drizzle-orm/bun-sql";

import * as schema from "@/db/schema";

export const db = drizzle({
  connection: process.env.DATABASE_URL!,
  casing: "snake_case",
  schema,
});
