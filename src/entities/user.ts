import { user } from "@/db/auth-schema";

import { createInsertSchema, createSelectSchema, createUpdateSchema } from "./factory";

export const userSelectSchema = createSelectSchema(user);
export const userInsertSchema = createInsertSchema(user);
export const userUpdateSchema = createUpdateSchema(user);

export type User = typeof userSelectSchema.static;
export type UserInsert = typeof userInsertSchema.static;
export type UserUpdate = typeof userUpdateSchema.static;
