import "dotenv/config";
import { drizzle } from "drizzle-orm/bun-sql";

import { relations } from "@/db/relations";

export const db = drizzle({
  connection: process.env.DATABASE_URL!,
  casing: "snake_case",
  relations,
});
