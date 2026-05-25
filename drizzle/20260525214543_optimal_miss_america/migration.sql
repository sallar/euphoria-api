CREATE TABLE "profile_photo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profile_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"object_bucket" varchar(255) NOT NULL,
	"object_key" text NOT NULL,
	"hash" varchar(255) NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"connection_only" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX "profile_photo_profile_id_idx" ON "profile_photo" ("profile_id");--> statement-breakpoint
CREATE INDEX "profile_photo_gallery_idx" ON "profile_photo" ("profile_id","position","created_at") WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX "profile_photo_public_gallery_idx" ON "profile_photo" ("profile_id","position","created_at") WHERE "deleted_at" is null and "connection_only" = false;--> statement-breakpoint
CREATE UNIQUE INDEX "profile_photo_object_unique_idx" ON "profile_photo" ("object_bucket","object_key") WHERE "deleted_at" is null;--> statement-breakpoint
ALTER TABLE "profile_photo" ADD CONSTRAINT "profile_photo_profile_id_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profile"("id") ON DELETE CASCADE;