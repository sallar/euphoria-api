ALTER TABLE "chat_conversation_read_state" DROP CONSTRAINT "chat_conversation_read_state_XnPCzaWbUkcU_fkey";--> statement-breakpoint
UPDATE "command_idempotency"
SET "result" = ("result" #>> '{}')::jsonb
WHERE jsonb_typeof("result") = 'string'
  AND ("result" #>> '{}') IS JSON;--> statement-breakpoint
UPDATE "command_idempotency"
SET "result_reference" = ("result_reference" #>> '{}')::jsonb
WHERE jsonb_typeof("result_reference") = 'string'
  AND ("result_reference" #>> '{}') IS JSON;--> statement-breakpoint
UPDATE "durable_event"
SET "payload" = ("payload" #>> '{}')::jsonb
WHERE jsonb_typeof("payload") = 'string'
  AND ("payload" #>> '{}') IS JSON;--> statement-breakpoint
UPDATE "delivery_job"
SET "payload" = ("payload" #>> '{}')::jsonb
WHERE jsonb_typeof("payload") = 'string'
  AND ("payload" #>> '{}') IS JSON;--> statement-breakpoint
UPDATE "notification"
SET "data" = ("data" #>> '{}')::jsonb
WHERE jsonb_typeof("data") = 'string'
  AND ("data" #>> '{}') IS JSON;--> statement-breakpoint
UPDATE "notification_delivery"
SET "provider_metadata" = ("provider_metadata" #>> '{}')::jsonb
WHERE jsonb_typeof("provider_metadata") = 'string'
  AND ("provider_metadata" #>> '{}') IS JSON;--> statement-breakpoint
UPDATE "chat_message"
SET "attachments" = ("attachments" #>> '{}')::jsonb
WHERE jsonb_typeof("attachments") = 'string'
  AND ("attachments" #>> '{}') IS JSON;--> statement-breakpoint
ALTER TABLE "chat_conversation_read_state" ADD COLUMN "last_read_message_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_message" ADD COLUMN "reply_summary" jsonb;--> statement-breakpoint
UPDATE "chat_conversation_read_state" read_state
SET "last_read_message_created_at" = message."created_at"
FROM "chat_message" message
WHERE message."id" = read_state."last_read_message_id";--> statement-breakpoint
UPDATE "chat_message" reply
SET "reply_summary" = jsonb_build_object(
  'messageId', target."id",
  'senderProfileId', target."sender_profile_id",
  'messageType', target."message_type",
  'state', 'unavailable',
  'preview', null
)
FROM "chat_message" target
WHERE target."id" = reply."reply_to_message_id"
  AND reply."reply_summary" IS NULL;--> statement-breakpoint
ALTER TABLE "chat_conversation_read_state" ADD CONSTRAINT "chat_conversation_read_state_position_check" CHECK (("last_read_message_id" is null) = ("last_read_message_created_at" is null));
