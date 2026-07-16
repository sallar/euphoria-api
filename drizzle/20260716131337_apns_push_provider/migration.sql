CREATE TYPE "apns_environment" AS ENUM('development', 'production');--> statement-breakpoint
ALTER TYPE "push_provider" ADD VALUE 'apns';--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD COLUMN "apns_environment" "apns_environment";--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD COLUMN "provider_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "user_push_token" ADD COLUMN "apns_environment" "apns_environment";--> statement-breakpoint
CREATE UNIQUE INDEX "user_push_token_apns_installation_unique_idx" ON "user_push_token" ("provider","apns_environment","device_id") WHERE "apns_environment" is not null and "enabled" = true;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_provider_environment_check" CHECK (("provider" is null and "apns_environment" is null) or ("provider"::text = 'expo' and "apns_environment" is null) or ("provider"::text = 'apns' and "apns_environment" is not null));--> statement-breakpoint
ALTER TABLE "user_push_token" ADD CONSTRAINT "user_push_token_provider_environment_check" CHECK (("provider"::text = 'expo' and "apns_environment" is null) or ("provider"::text = 'apns' and "apns_environment" is not null));--> statement-breakpoint
ALTER TABLE "user_push_token" ADD CONSTRAINT "user_push_token_apns_registration_check" CHECK ("provider"::text <> 'apns' or ("platform"::text = 'ios' and nullif(btrim("device_id"), '') is not null and "token" ~ '^([0-9A-Fa-f]{2})+$'));
