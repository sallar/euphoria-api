DROP TYPE IF EXISTS "profile_reaction";
--> statement-breakpoint
CREATE TYPE "profile_reaction_type" AS ENUM('like', 'unlike');--> statement-breakpoint
CREATE TABLE "profile_reaction" (
	"profile_id" uuid,
	"target_profile_id" uuid,
	"reaction" "profile_reaction_type" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_reaction_pkey" PRIMARY KEY("profile_id","target_profile_id"),
	CONSTRAINT "profile_reaction_no_self_reaction_check" CHECK ("profile_id" <> "target_profile_id")
);
--> statement-breakpoint
CREATE INDEX "profile_reaction_profile_reaction_idx" ON "profile_reaction" ("profile_id","reaction");--> statement-breakpoint
CREATE INDEX "profile_reaction_target_reaction_idx" ON "profile_reaction" ("target_profile_id","reaction");--> statement-breakpoint
ALTER TABLE "profile_reaction" ADD CONSTRAINT "profile_reaction_profile_id_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profile"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "profile_reaction" ADD CONSTRAINT "profile_reaction_target_profile_id_profile_id_fkey" FOREIGN KEY ("target_profile_id") REFERENCES "profile"("id") ON DELETE CASCADE;
