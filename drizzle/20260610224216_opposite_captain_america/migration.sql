CREATE TABLE "chat_conversation_read_state" (
	"conversation_id" uuid,
	"profile_id" uuid,
	"last_read_message_id" uuid,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_conversation_read_state_pkey" PRIMARY KEY("conversation_id","profile_id")
);
--> statement-breakpoint
CREATE INDEX "chat_conversation_read_state_profile_idx" ON "chat_conversation_read_state" ("profile_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "chat_conversation_read_state_last_read_message_idx" ON "chat_conversation_read_state" ("last_read_message_id");--> statement-breakpoint
ALTER TABLE "chat_conversation_read_state" ADD CONSTRAINT "chat_conversation_read_state_7cRi5SQ0WMxo_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_conversation_read_state" ADD CONSTRAINT "chat_conversation_read_state_profile_id_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profile"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_conversation_read_state" ADD CONSTRAINT "chat_conversation_read_state_XnPCzaWbUkcU_fkey" FOREIGN KEY ("last_read_message_id") REFERENCES "chat_message"("id") ON DELETE SET NULL;--> statement-breakpoint
INSERT INTO "chat_conversation_read_state" (
	"conversation_id",
	"profile_id",
	"last_read_message_id",
	"last_read_at",
	"created_at",
	"updated_at"
)
SELECT
	conversation.id,
	participant.profile_id,
	latest_message.id,
	now(),
	now(),
	now()
FROM "chat_conversation" conversation
CROSS JOIN LATERAL (
	VALUES
		(conversation.profile_one_id),
		(conversation.profile_two_id)
) participant(profile_id)
LEFT JOIN LATERAL (
	SELECT message.id
	FROM "chat_message" message
	WHERE message.conversation_id = conversation.id
	ORDER BY message.created_at DESC, message.id DESC
	LIMIT 1
) latest_message ON true
WHERE latest_message.id IS NOT NULL
ON CONFLICT ("conversation_id", "profile_id") DO NOTHING;
