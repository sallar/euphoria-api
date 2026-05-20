import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  geometry,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { user } from "./auth-schema";

export const profileTypeValues = ["solo", "couple", "group"] as const;

export const profileGenderValues = [
  "man",
  "woman",
  "non_binary",
  "intersex",
  "custom",
  "cis_man",
  "cis_woman",
  "trans_man",
  "trans_woman",
  "transmasculine",
  "transfeminine",
  "agender",
  "androgynous",
  "bigender",
  "demiboy",
  "demigirl",
  "genderfluid",
  "genderqueer",
  "gender_nonconforming",
  "gender_questioning",
  "gender_variant",
  "gendervoid",
  "neutrois",
  "pangender",
  "polygender",
  "two_spirit",
  "enby",
  "maverique",
  "aporagender",
  "xenogender",
  "cultural_gender",
] as const;

export const profileOrientationValues = [
  "heterosexual",
  "heteroflexible",
  "homosexual",
  "gay",
  "lesbian",
  "homoflexible",
  "bisexual",
  "bi_curious",
  "pansexual",
  "polysexual",
  "omnisexual",
  "skoliosexual",
  "queer",
  "sapiosexual",
  "androsexual",
  "gynesexual",
  "androgynosexual",
  "asexual",
  "demisexual",
  "graysexual",
  "aceflux",
  "acespike",
  "fictosexual",
  "fraysexual",
  "lithosexual",
  "reciprosexual",
  "aegosexual",
  "cupiosexual",
  "idemsexual",
  "quoisexual",
  "apothisexual",
  "aromantic",
  "demiromantic",
  "grayromantic",
  "biromantic",
  "panromantic",
  "heteroromantic",
  "homoromantic",
  "autosexual",
  "objectumsexual",
  "custom",
] as const;

export const profileRelationshipTypeValues = [
  "monogamous",
  "monogamish",
  "ethical_non_monogamy",
  "polyamorous",
  "polyfidelity",
  "relationship_anarchy",
  "open_relationship",
  "swinging",
  "casual",
  "friends_with_benefits",
  "dating",
  "long_term",
  "serious",
  "married",
  "engaged",
  "nesting_partner",
  "primary_partner",
  "secondary_partner",
  "metamour",
  "solo_poly",
  "kitchen_table_poly",
  "parallel_poly",
  "hierarchical_poly",
  "non_hierarchical",
  "unicorn_hunting",
  "couple",
  "triad",
  "quad",
  "group",
  "one_on_one_only",
  "play_partner",
  "casual_play",
  "friendship",
  "platonic",
  "queerplatonic",
  "custom",
] as const;

export const profileUserRoleValues = ["owner", "member"] as const;

export const profileTypeEnum = pgEnum("profile_type", profileTypeValues);
export const profileGenderEnum = pgEnum("profile_gender", profileGenderValues);
export const profileOrientationEnum = pgEnum("profile_orientation", profileOrientationValues);
export const profileRelationshipTypeEnum = pgEnum(
  "profile_relationship_type",
  profileRelationshipTypeValues,
);
export const profileUserRoleEnum = pgEnum("profile_user_role", profileUserRoleValues);

export const profile = pgTable(
  "profile",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    profileType: profileTypeEnum("profile_type").notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    bio: text("bio"),
    gender: profileGenderEnum("gender").notNull(),
    genderTags: profileGenderEnum("gender_tags")
      .array()
      .default(sql`'{}'::profile_gender[]`)
      .notNull(),
    genderInterests: profileGenderEnum("gender_interests")
      .array()
      .default(sql`'{}'::profile_gender[]`)
      .notNull(),
    orientation: profileOrientationEnum("orientation").notNull(),
    orientationInterests: profileOrientationEnum("orientation_interests")
      .array()
      .default(sql`'{}'::profile_orientation[]`)
      .notNull(),
    relationshipTypes: profileRelationshipTypeEnum("relationship_types")
      .array()
      .default(sql`'{}'::profile_relationship_type[]`)
      .notNull(),
    // location: geographyPoint("location").notNull(),
    location: geometry("location", {
      type: "Geography",
      mode: "xy",
      srid: 4326,
    }).notNull(),
    country: varchar("country", { length: 2 }).notNull(),
    dateOfBirth: date("date_of_birth", { mode: "string" }).notNull(),
    hidden: boolean("hidden").default(false).notNull(),
  },
  (table) => [
    check(
      "profile_primary_gender_check",
      sql`${table.gender} in ('man', 'woman', 'non_binary', 'intersex', 'custom')`,
    ),
    index("profile_feed_visibility_idx")
      .on(table.country, table.hidden, table.deletedAt)
      .where(sql`${table.deletedAt} is null and ${table.hidden} = false`),
    index("profile_location_idx")
      .using("gist", table.location)
      .where(sql`${table.deletedAt} is null and ${table.hidden} = false`),
    index("profile_feed_birth_date_idx")
      .on(table.dateOfBirth)
      .where(sql`${table.deletedAt} is null and ${table.hidden} = false`),
    index("profile_last_seen_at_idx").on(table.lastSeenAt.desc()),
    index("profile_gender_idx").on(table.gender),
    index("profile_gender_tags_idx").using("gin", table.genderTags),
    index("profile_gender_interests_idx").using("gin", table.genderInterests),
    index("profile_orientation_idx").on(table.orientation),
    index("profile_orientation_interests_idx").using("gin", table.orientationInterests),
    index("profile_relationship_types_idx").using("gin", table.relationshipTypes),
  ],
);

export const profileUser = pgTable(
  "profile_user",
  {
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profile.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: profileUserRoleEnum("role").default("member").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.profileId, table.userId] }),
    index("profile_user_profile_id_idx").on(table.profileId),
    index("profile_user_user_id_idx").on(table.userId),
  ],
);

export const profileRelations = relations(profile, ({ many }) => ({
  users: many(profileUser),
}));

export const profileUserRelations = relations(profileUser, ({ one }) => ({
  profile: one(profile, {
    fields: [profileUser.profileId],
    references: [profile.id],
  }),
  user: one(user, {
    fields: [profileUser.userId],
    references: [user.id],
  }),
}));
