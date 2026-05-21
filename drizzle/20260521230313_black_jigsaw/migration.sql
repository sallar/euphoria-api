CREATE TYPE "profile_gender" AS ENUM('man', 'woman', 'non_binary', 'intersex', 'custom', 'cis_man', 'cis_woman', 'trans_man', 'trans_woman', 'transmasculine', 'transfeminine', 'agender', 'androgynous', 'bigender', 'demiboy', 'demigirl', 'genderfluid', 'genderqueer', 'gender_nonconforming', 'gender_questioning', 'gender_variant', 'gendervoid', 'neutrois', 'pangender', 'polygender', 'two_spirit', 'enby', 'maverique', 'aporagender', 'xenogender', 'cultural_gender');--> statement-breakpoint
CREATE TYPE "profile_orientation" AS ENUM('heterosexual', 'heteroflexible', 'homosexual', 'gay', 'lesbian', 'homoflexible', 'bisexual', 'bi_curious', 'pansexual', 'polysexual', 'omnisexual', 'skoliosexual', 'queer', 'sapiosexual', 'androsexual', 'gynesexual', 'androgynosexual', 'asexual', 'demisexual', 'graysexual', 'aceflux', 'acespike', 'fictosexual', 'fraysexual', 'lithosexual', 'reciprosexual', 'aegosexual', 'cupiosexual', 'idemsexual', 'quoisexual', 'apothisexual', 'aromantic', 'demiromantic', 'grayromantic', 'biromantic', 'panromantic', 'heteroromantic', 'homoromantic', 'autosexual', 'objectumsexual', 'custom');--> statement-breakpoint
CREATE TYPE "profile_relationship_type" AS ENUM('monogamous', 'monogamish', 'ethical_non_monogamy', 'polyamorous', 'polyfidelity', 'relationship_anarchy', 'open_relationship', 'swinging', 'casual', 'friends_with_benefits', 'dating', 'long_term', 'serious', 'married', 'engaged', 'nesting_partner', 'primary_partner', 'secondary_partner', 'metamour', 'solo_poly', 'kitchen_table_poly', 'parallel_poly', 'hierarchical_poly', 'non_hierarchical', 'unicorn_hunting', 'couple', 'triad', 'quad', 'group', 'one_on_one_only', 'play_partner', 'casual_play', 'friendship', 'platonic', 'queerplatonic', 'custom');--> statement-breakpoint
CREATE TYPE "profile_type" AS ENUM('solo', 'couple', 'group');--> statement-breakpoint
CREATE TYPE "profile_user_role" AS ENUM('owner', 'member');--> statement-breakpoint
CREATE TABLE "profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"profile_type" "profile_type" NOT NULL,
	"name" varchar(120) NOT NULL,
	"bio" text,
	"gender" "profile_gender" NOT NULL,
	"gender_tags" "profile_gender"[] DEFAULT '{}'::"profile_gender"[] NOT NULL,
	"gender_interests" "profile_gender"[] DEFAULT '{}'::"profile_gender"[] NOT NULL,
	"orientation" "profile_orientation" NOT NULL,
	"orientation_interests" "profile_orientation"[] DEFAULT '{}'::"profile_orientation"[] NOT NULL,
	"relationship_types" "profile_relationship_type"[] DEFAULT '{}'::"profile_relationship_type"[] NOT NULL,
	"location" geography(point,4326) NOT NULL,
	"country" varchar(2) NOT NULL,
	"date_of_birth" date NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	CONSTRAINT "profile_primary_gender_check" CHECK ("gender" in ('man', 'woman', 'non_binary', 'intersex', 'custom'))
);
--> statement-breakpoint
CREATE TABLE "profile_user" (
	"profile_id" uuid,
	"user_id" text,
	"role" "profile_user_role" DEFAULT 'member'::"profile_user_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_user_pkey" PRIMARY KEY("profile_id","user_id")
);
--> statement-breakpoint
CREATE INDEX "profile_feed_visibility_idx" ON "profile" ("country","hidden","deleted_at") WHERE "deleted_at" is null and "hidden" = false;--> statement-breakpoint
CREATE INDEX "profile_location_idx" ON "profile" USING gist ("location") WHERE "deleted_at" is null and "hidden" = false;--> statement-breakpoint
CREATE INDEX "profile_feed_birth_date_idx" ON "profile" ("date_of_birth") WHERE "deleted_at" is null and "hidden" = false;--> statement-breakpoint
CREATE INDEX "profile_last_seen_at_idx" ON "profile" ("last_seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "profile_gender_idx" ON "profile" ("gender");--> statement-breakpoint
CREATE INDEX "profile_gender_tags_idx" ON "profile" USING gin ("gender_tags");--> statement-breakpoint
CREATE INDEX "profile_gender_interests_idx" ON "profile" USING gin ("gender_interests");--> statement-breakpoint
CREATE INDEX "profile_orientation_idx" ON "profile" ("orientation");--> statement-breakpoint
CREATE INDEX "profile_orientation_interests_idx" ON "profile" USING gin ("orientation_interests");--> statement-breakpoint
CREATE INDEX "profile_relationship_types_idx" ON "profile" USING gin ("relationship_types");--> statement-breakpoint
CREATE INDEX "profile_user_profile_id_idx" ON "profile_user" ("profile_id");--> statement-breakpoint
CREATE INDEX "profile_user_user_id_idx" ON "profile_user" ("user_id");--> statement-breakpoint
ALTER TABLE "profile_user" ADD CONSTRAINT "profile_user_profile_id_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profile"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "profile_user" ADD CONSTRAINT "profile_user_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;
