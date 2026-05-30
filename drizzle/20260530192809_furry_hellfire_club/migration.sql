CREATE TYPE "chat_message_type" AS ENUM('text', 'image');--> statement-breakpoint
CREATE TABLE "chat_conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profile_one_id" uuid NOT NULL,
	"profile_two_id" uuid NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_conversation_profile_order_check" CHECK ("profile_one_id" < "profile_two_id")
);
--> statement-breakpoint
CREATE TABLE "chat_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"conversation_id" uuid NOT NULL,
	"sender_profile_id" uuid,
	"message_type" "chat_message_type" DEFAULT 'text'::"chat_message_type" NOT NULL,
	"content" text,
	"attachments" jsonb DEFAULT '[]' NOT NULL,
	"reply_to_message_id" uuid,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_message_text_content_check" CHECK ("message_type" <> 'text' or length(btrim(coalesce("content", ''))) > 0),
	CONSTRAINT "chat_message_reply_not_self_check" CHECK ("reply_to_message_id" is null or "reply_to_message_id" <> "id")
);
--> statement-breakpoint
CREATE TABLE "chat_message_reaction" (
	"message_id" uuid,
	"profile_id" uuid,
	"emoji" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_message_reaction_pkey" PRIMARY KEY("message_id","profile_id","emoji"),
	CONSTRAINT "chat_message_reaction_emoji_not_blank_check" CHECK (length(btrim("emoji")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_conversation_profile_pair_unique_idx" ON "chat_conversation" ("profile_one_id","profile_two_id");--> statement-breakpoint
CREATE INDEX "chat_conversation_profile_one_idx" ON "chat_conversation" ("profile_one_id","last_message_at" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "chat_conversation_profile_two_idx" ON "chat_conversation" ("profile_two_id","last_message_at" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "chat_message_conversation_created_at_idx" ON "chat_message" ("conversation_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "chat_message_sender_profile_id_idx" ON "chat_message" ("sender_profile_id");--> statement-breakpoint
CREATE INDEX "chat_message_reply_to_message_id_idx" ON "chat_message" ("reply_to_message_id");--> statement-breakpoint
CREATE INDEX "chat_message_reaction_profile_id_idx" ON "chat_message_reaction" ("profile_id");--> statement-breakpoint
CREATE INDEX "chat_message_reaction_emoji_idx" ON "chat_message_reaction" ("emoji");--> statement-breakpoint
ALTER TABLE "chat_conversation" ADD CONSTRAINT "chat_conversation_profile_one_id_profile_id_fkey" FOREIGN KEY ("profile_one_id") REFERENCES "profile"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_conversation" ADD CONSTRAINT "chat_conversation_profile_two_id_profile_id_fkey" FOREIGN KEY ("profile_two_id") REFERENCES "profile"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_conversation_id_chat_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_sender_profile_id_profile_id_fkey" FOREIGN KEY ("sender_profile_id") REFERENCES "profile"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_reply_to_message_id_chat_message_id_fkey" FOREIGN KEY ("reply_to_message_id") REFERENCES "chat_message"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "chat_message_reaction" ADD CONSTRAINT "chat_message_reaction_message_id_chat_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "chat_message"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_message_reaction" ADD CONSTRAINT "chat_message_reaction_profile_id_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profile"("id") ON DELETE CASCADE;--> statement-breakpoint
INSERT INTO "chat_conversation" (
	"profile_one_id",
	"profile_two_id",
	"created_at",
	"updated_at"
)
SELECT
	matches.profile_one_id,
	matches.profile_two_id,
	min(matches.matched_at),
	now()
FROM (
	SELECT
		least("profile_id", "matched_profile_id") AS profile_one_id,
		greatest("profile_id", "matched_profile_id") AS profile_two_id,
		"matched_at"
	FROM "profile_match"
) matches
GROUP BY matches.profile_one_id, matches.profile_two_id
ON CONFLICT ("profile_one_id", "profile_two_id") DO NOTHING;
