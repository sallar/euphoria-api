CREATE TYPE "device_platform" AS ENUM('ios', 'android', 'web');--> statement-breakpoint
CREATE TYPE "notification_channel" AS ENUM('in_app', 'push');--> statement-breakpoint
CREATE TYPE "notification_delivery_status" AS ENUM('pending', 'delivered', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "notification_type" AS ENUM('profile_like', 'profile_match', 'message', 'system');--> statement-breakpoint
CREATE TYPE "push_provider" AS ENUM('expo');--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"recipient_user_id" text NOT NULL,
	"actor_profile_id" uuid,
	"related_profile_id" uuid,
	"type" "notification_type" NOT NULL,
	"title" varchar(140) NOT NULL,
	"body" text NOT NULL,
	"data" jsonb DEFAULT '{}' NOT NULL,
	"read_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"notification_id" uuid NOT NULL,
	"recipient_user_id" text NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"status" "notification_delivery_status" DEFAULT 'pending'::"notification_delivery_status" NOT NULL,
	"provider" "push_provider",
	"push_token_id" uuid,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_push_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" text NOT NULL,
	"provider" "push_provider" DEFAULT 'expo'::"push_provider" NOT NULL,
	"token" text NOT NULL,
	"platform" "device_platform" NOT NULL,
	"device_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "notification_recipient_created_at_idx" ON "notification" ("recipient_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notification_recipient_unread_idx" ON "notification" ("recipient_user_id","created_at" DESC NULLS LAST) WHERE "read_at" is null and "archived_at" is null;--> statement-breakpoint
CREATE INDEX "notification_type_idx" ON "notification" ("type");--> statement-breakpoint
CREATE INDEX "notification_actor_profile_id_idx" ON "notification" ("actor_profile_id");--> statement-breakpoint
CREATE INDEX "notification_related_profile_id_idx" ON "notification" ("related_profile_id");--> statement-breakpoint
CREATE INDEX "notification_delivery_notification_id_idx" ON "notification_delivery" ("notification_id");--> statement-breakpoint
CREATE INDEX "notification_delivery_recipient_created_at_idx" ON "notification_delivery" ("recipient_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notification_delivery_queue_idx" ON "notification_delivery" ("channel","status","next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "notification_delivery_push_token_id_idx" ON "notification_delivery" ("push_token_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_push_token_provider_token_unique_idx" ON "user_push_token" ("provider","token");--> statement-breakpoint
CREATE INDEX "user_push_token_user_enabled_idx" ON "user_push_token" ("user_id","enabled");--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_recipient_user_id_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_actor_profile_id_profile_id_fkey" FOREIGN KEY ("actor_profile_id") REFERENCES "profile"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_related_profile_id_profile_id_fkey" FOREIGN KEY ("related_profile_id") REFERENCES "profile"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_notification_id_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notification"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_recipient_user_id_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_push_token_id_user_push_token_id_fkey" FOREIGN KEY ("push_token_id") REFERENCES "user_push_token"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "user_push_token" ADD CONSTRAINT "user_push_token_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;