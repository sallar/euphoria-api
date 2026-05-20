import { profile, profileUser } from "@/db/user-schema";

import { createInsertSchema, createSelectSchema, createUpdateSchema } from "./factory";

export const profileSelectSchema = createSelectSchema(profile);
export const profileInsertSchema = createInsertSchema(profile);
export const profileUpdateSchema = createUpdateSchema(profile);

export const profileUserSelectSchema = createSelectSchema(profileUser);
export const profileUserInsertSchema = createInsertSchema(profileUser);
export const profileUserUpdateSchema = createUpdateSchema(profileUser);

export type Profile = typeof profileSelectSchema.static;
export type ProfileInsert = typeof profileInsertSchema.static;
export type ProfileUpdate = typeof profileUpdateSchema.static;

export type ProfileUser = typeof profileUserSelectSchema.static;
export type ProfileUserInsert = typeof profileUserInsertSchema.static;
export type ProfileUserUpdate = typeof profileUserUpdateSchema.static;
