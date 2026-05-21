import { t } from "elysia";

import { profile } from "@/db/user-schema";

import { createInsertSchema, createSelectSchema, createUpdateSchema } from "./factory";

export const profileSelectSchema = createSelectSchema(profile);
export const profilesSelectSchema = t.Array(profileSelectSchema);

const _profileInsertSchema = createInsertSchema(profile, {
  dateOfBirth: t.String({ format: "date" }),
});
export const profileInsertSchema = t.Omit(_profileInsertSchema, [
  "id",
  "createdAt",
  "updatedAt",
  "deletedAt",
  "lastSeenAt",
]);

const _profileUpdateSchema = createUpdateSchema(profile, {
  dateOfBirth: t.Optional(t.String({ format: "date" })),
});
export const profileUpdateSchema = t.Omit(_profileUpdateSchema, [
  "id",
  "createdAt",
  "updatedAt",
  "deletedAt",
  "lastSeenAt",
]);

export type Profile = typeof profileSelectSchema.static;
export type ProfileInsert = typeof profileInsertSchema.static;
export type ProfileUpdate = typeof profileUpdateSchema.static;
