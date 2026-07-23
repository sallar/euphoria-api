CREATE TYPE "command_idempotency_outcome" AS ENUM('succeeded', 'rejected');--> statement-breakpoint
CREATE TYPE "command_idempotency_state" AS ENUM('in_progress', 'completed');--> statement-breakpoint
CREATE TYPE "delivery_job_attempt_outcome" AS ENUM('leased', 'completed', 'retry_scheduled', 'lease_expired', 'dead_lettered_failed', 'dead_lettered_unknown');--> statement-breakpoint
CREATE TYPE "delivery_job_dead_letter_outcome" AS ENUM('failed', 'unknown');--> statement-breakpoint
CREATE TYPE "delivery_job_dead_letter_reason" AS ENUM('permanent_failure', 'attempts_exhausted', 'lease_expired_after_final_claim');--> statement-breakpoint
CREATE TYPE "delivery_job_state" AS ENUM('pending', 'leased', 'completed', 'dead_letter');--> statement-breakpoint
CREATE TYPE "durable_event_scope_kind" AS ENUM('chat-profile', 'chat-conversation', 'notification-user');--> statement-breakpoint
CREATE TABLE "command_idempotency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"actor_user_id" text NOT NULL,
	"command_name" varchar(120) NOT NULL,
	"command_version" integer NOT NULL,
	"idempotency_key" varchar(255) NOT NULL,
	"request_fingerprint" varchar(64) NOT NULL,
	"state" "command_idempotency_state" DEFAULT 'in_progress'::"command_idempotency_state" NOT NULL,
	"outcome" "command_idempotency_outcome",
	"result" jsonb,
	"result_reference" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"retention_expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "command_idempotency_command_version_check" CHECK ("command_version" > 0),
	CONSTRAINT "command_idempotency_key_not_blank_check" CHECK (length(btrim("idempotency_key")) > 0),
	CONSTRAINT "command_idempotency_fingerprint_check" CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "command_idempotency_state_check" CHECK ((
        "state" = 'in_progress'
        and "outcome" is null
        and "result" is null
        and "result_reference" is null
        and "completed_at" is null
        and "retention_expires_at" is null
      ) or (
        "state" = 'completed'
        and "outcome" is not null
        and (("result" is not null)::integer + ("result_reference" is not null)::integer) = 1
        and "completed_at" is not null
        and "retention_expires_at" > "completed_at"
      ))
);
--> statement-breakpoint
CREATE TABLE "delivery_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"job_kind" varchar(120) NOT NULL,
	"job_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"state" "delivery_job_state" DEFAULT 'pending'::"delivery_job_state" NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"max_attempts" integer NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"terminal_retention_seconds" integer NOT NULL,
	"lease_owner" varchar(160),
	"lease_token" uuid,
	"leased_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"dead_lettered_at" timestamp with time zone,
	"dead_letter_reason" "delivery_job_dead_letter_reason",
	"dead_letter_outcome" "delivery_job_dead_letter_outcome",
	"last_failure_code" varchar(100),
	"last_failure_at" timestamp with time zone,
	"retention_expires_at" timestamp with time zone,
	"manual_requeue_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_job_kind_not_blank_check" CHECK (length(btrim("job_kind")) > 0),
	CONSTRAINT "delivery_job_version_check" CHECK ("job_version" > 0),
	CONSTRAINT "delivery_job_max_attempts_check" CHECK ("max_attempts" > 0),
	CONSTRAINT "delivery_job_attempt_count_check" CHECK ("attempt_count" >= 0 and "attempt_count" <= "max_attempts"),
	CONSTRAINT "delivery_job_terminal_retention_seconds_check" CHECK ("terminal_retention_seconds" > 0),
	CONSTRAINT "delivery_job_manual_requeue_count_check" CHECK ("manual_requeue_count" >= 0),
	CONSTRAINT "delivery_job_state_check" CHECK ((
        "state" = 'pending'
        and "lease_owner" is null
        and "lease_token" is null
        and "leased_at" is null
        and "lease_expires_at" is null
        and "completed_at" is null
        and "dead_lettered_at" is null
        and "dead_letter_reason" is null
        and "dead_letter_outcome" is null
        and "retention_expires_at" is null
      ) or (
        "state" = 'leased'
        and "attempt_count" > 0
        and "lease_owner" is not null
        and "lease_token" is not null
        and "leased_at" is not null
        and "lease_expires_at" > "leased_at"
        and "completed_at" is null
        and "dead_lettered_at" is null
        and "dead_letter_reason" is null
        and "dead_letter_outcome" is null
        and "retention_expires_at" is null
      ) or (
        "state" = 'completed'
        and "lease_owner" is null
        and "lease_token" is null
        and "leased_at" is null
        and "lease_expires_at" is null
        and "completed_at" is not null
        and "dead_lettered_at" is null
        and "dead_letter_reason" is null
        and "dead_letter_outcome" is null
        and "retention_expires_at" > "completed_at"
      ) or (
        "state" = 'dead_letter'
        and "lease_owner" is null
        and "lease_token" is null
        and "leased_at" is null
        and "lease_expires_at" is null
        and "completed_at" is null
        and "dead_lettered_at" is not null
        and "dead_letter_reason" is not null
        and "dead_letter_outcome" is not null
        and "retention_expires_at" > "dead_lettered_at"
      ))
);
--> statement-breakpoint
CREATE TABLE "delivery_job_attempt" (
	"lease_token" uuid PRIMARY KEY,
	"job_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"lease_owner" varchar(160) NOT NULL,
	"leased_at" timestamp with time zone NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"outcome" "delivery_job_attempt_outcome" DEFAULT 'leased'::"delivery_job_attempt_outcome" NOT NULL,
	"failure_code" varchar(100),
	"next_available_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "delivery_job_attempt_number_check" CHECK ("attempt_number" > 0),
	CONSTRAINT "delivery_job_attempt_lease_check" CHECK ("lease_expires_at" > "leased_at"),
	CONSTRAINT "delivery_job_attempt_outcome_check" CHECK ((
        "outcome" = 'leased'
        and "failure_code" is null
        and "next_available_at" is null
        and "finished_at" is null
      ) or (
        "outcome" = 'completed'
        and "failure_code" is null
        and "next_available_at" is null
        and "finished_at" is not null
      ) or (
        "outcome" = 'retry_scheduled'
        and "failure_code" is not null
        and "next_available_at" is not null
        and "finished_at" is not null
      ) or (
        "outcome" in ('lease_expired', 'dead_lettered_failed', 'dead_lettered_unknown')
        and "failure_code" is not null
        and "next_available_at" is null
        and "finished_at" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "delivery_job_manual_requeue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"job_id" uuid NOT NULL,
	"requested_by" varchar(160) NOT NULL,
	"reason_code" varchar(100) NOT NULL,
	"previous_dead_letter_reason" "delivery_job_dead_letter_reason" NOT NULL,
	"previous_dead_letter_outcome" "delivery_job_dead_letter_outcome" NOT NULL,
	"previous_attempt_count" integer NOT NULL,
	"next_max_attempts" integer NOT NULL,
	"next_available_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_job_manual_requeue_requested_by_check" CHECK (length(btrim("requested_by")) > 0),
	CONSTRAINT "delivery_job_manual_requeue_reason_code_check" CHECK ("reason_code" ~ '^[a-z][a-z0-9_.:-]{0,99}$'),
	CONSTRAINT "delivery_job_manual_requeue_attempts_check" CHECK ("previous_attempt_count" > 0 and "next_max_attempts" > 0)
);
--> statement-breakpoint
CREATE TABLE "durable_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"scope_kind" "durable_event_scope_kind" NOT NULL,
	"scope_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"event_type" varchar(160) NOT NULL,
	"event_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"causal_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"committed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retention_expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "durable_event_sequence_check" CHECK ("sequence" > 0),
	CONSTRAINT "durable_event_type_not_blank_check" CHECK (length(btrim("event_type")) > 0),
	CONSTRAINT "durable_event_version_check" CHECK ("event_version" > 0),
	CONSTRAINT "durable_event_retention_check" CHECK ("retention_expires_at" > "committed_at")
);
--> statement-breakpoint
CREATE TABLE "durable_event_scope" (
	"scope_kind" "durable_event_scope_kind",
	"scope_id" text,
	"high_water_sequence" bigint DEFAULT 0 NOT NULL,
	"retention_floor_sequence" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "durable_event_scope_pkey" PRIMARY KEY("scope_kind","scope_id"),
	CONSTRAINT "durable_event_scope_id_not_blank_check" CHECK (length(btrim("scope_id")) > 0),
	CONSTRAINT "durable_event_scope_uuid_kind_check" CHECK ("scope_kind" = 'notification-user' or "scope_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "durable_event_scope_sequence_check" CHECK ("high_water_sequence" >= 0 and "retention_floor_sequence" >= 1 and "retention_floor_sequence" <= "high_water_sequence" + 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "command_idempotency_actor_command_key_unique_idx" ON "command_idempotency" ("actor_user_id","command_name","idempotency_key");--> statement-breakpoint
CREATE INDEX "command_idempotency_completed_retention_idx" ON "command_idempotency" ("retention_expires_at","id") WHERE "state" = 'completed';--> statement-breakpoint
CREATE INDEX "command_idempotency_in_progress_created_idx" ON "command_idempotency" ("created_at","id") WHERE "state" = 'in_progress';--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_job_lease_token_unique_idx" ON "delivery_job" ("lease_token") WHERE "lease_token" is not null;--> statement-breakpoint
CREATE INDEX "delivery_job_pending_claim_idx" ON "delivery_job" ("job_kind","job_version","available_at","created_at","id") WHERE "state" = 'pending';--> statement-breakpoint
CREATE INDEX "delivery_job_expired_lease_idx" ON "delivery_job" ("job_kind","job_version","lease_expires_at","id") WHERE "state" = 'leased';--> statement-breakpoint
CREATE INDEX "delivery_job_dead_letter_idx" ON "delivery_job" ("job_kind","job_version","dead_lettered_at","id") WHERE "state" = 'dead_letter';--> statement-breakpoint
CREATE INDEX "delivery_job_terminal_retention_idx" ON "delivery_job" ("retention_expires_at","id") WHERE "state" in ('completed', 'dead_letter');--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_job_attempt_job_number_unique_idx" ON "delivery_job_attempt" ("job_id","attempt_number");--> statement-breakpoint
CREATE INDEX "delivery_job_attempt_job_idx" ON "delivery_job_attempt" ("job_id","attempt_number");--> statement-breakpoint
CREATE INDEX "delivery_job_manual_requeue_job_idx" ON "delivery_job_manual_requeue" ("job_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "durable_event_scope_sequence_unique_idx" ON "durable_event" ("scope_kind","scope_id","sequence");--> statement-breakpoint
CREATE INDEX "durable_event_retention_idx" ON "durable_event" ("retention_expires_at","scope_kind","scope_id","sequence");--> statement-breakpoint
CREATE INDEX "durable_event_causal_id_idx" ON "durable_event" ("causal_id") WHERE "causal_id" is not null;--> statement-breakpoint
ALTER TABLE "delivery_job_attempt" ADD CONSTRAINT "delivery_job_attempt_job_id_delivery_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "delivery_job"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "delivery_job_manual_requeue" ADD CONSTRAINT "delivery_job_manual_requeue_job_id_delivery_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "delivery_job"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "durable_event" ADD CONSTRAINT "durable_event_scope_fkey" FOREIGN KEY ("scope_kind","scope_id") REFERENCES "durable_event_scope"("scope_kind","scope_id");
--> statement-breakpoint
CREATE FUNCTION "durable_event_scope_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'Durable event scope metadata cannot be deleted',
			CONSTRAINT = 'durable_event_scope_permanent_check';
	END IF;

	IF NEW.scope_kind IS DISTINCT FROM OLD.scope_kind
		OR NEW.scope_id IS DISTINCT FROM OLD.scope_id THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'Durable event scope identity is immutable',
			CONSTRAINT = 'durable_event_scope_identity_check';
	END IF;

	IF NEW.high_water_sequence < OLD.high_water_sequence THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'Durable event high-water sequence cannot decrease',
			CONSTRAINT = 'durable_event_scope_high_water_monotonic_check';
	END IF;

	IF NEW.retention_floor_sequence < OLD.retention_floor_sequence THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'Durable event retention floor cannot decrease',
			CONSTRAINT = 'durable_event_scope_retention_floor_monotonic_check';
	END IF;

	RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "durable_event_scope_guard"
BEFORE UPDATE OR DELETE
ON "durable_event_scope"
FOR EACH ROW
EXECUTE FUNCTION "durable_event_scope_guard"();
--> statement-breakpoint
CREATE FUNCTION "durable_event_insert_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	scope_high_water bigint;
	scope_retention_floor bigint;
BEGIN
	SELECT
		scope.high_water_sequence,
		scope.retention_floor_sequence
	INTO scope_high_water, scope_retention_floor
	FROM "durable_event_scope" scope
	WHERE scope.scope_kind = NEW.scope_kind
		AND scope.scope_id = NEW.scope_id
	FOR KEY SHARE;

	IF NOT FOUND THEN
		RAISE EXCEPTION USING
			ERRCODE = '23503',
			MESSAGE = 'Durable event scope metadata does not exist',
			CONSTRAINT = 'durable_event_scope_fkey';
	END IF;

	IF NEW.sequence <> scope_high_water OR NEW.sequence < scope_retention_floor THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'Durable event sequence was not allocated from the current scope high-water mark',
			CONSTRAINT = 'durable_event_sequence_allocation_check';
	END IF;

	RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "durable_event_insert_guard"
BEFORE INSERT
ON "durable_event"
FOR EACH ROW
EXECUTE FUNCTION "durable_event_insert_guard"();
--> statement-breakpoint
CREATE FUNCTION "durable_event_update_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION USING
		ERRCODE = '23514',
		MESSAGE = 'Durable events are immutable',
		CONSTRAINT = 'durable_event_immutable_check';
END
$$;
--> statement-breakpoint
CREATE TRIGGER "durable_event_update_guard"
BEFORE UPDATE
ON "durable_event"
FOR EACH ROW
EXECUTE FUNCTION "durable_event_update_guard"();
--> statement-breakpoint
CREATE FUNCTION "durable_event_after_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	UPDATE "durable_event_scope" scope
	SET
		retention_floor_sequence = greatest(
			scope.retention_floor_sequence,
			coalesce(
				(
					SELECT min(retained.sequence)
					FROM "durable_event" retained
					WHERE retained.scope_kind = scope.scope_kind
						AND retained.scope_id = scope.scope_id
				),
				scope.high_water_sequence + 1
			)
		),
		updated_at = clock_timestamp()
	WHERE (scope.scope_kind, scope.scope_id) IN (
		SELECT DISTINCT deleted.scope_kind, deleted.scope_id
		FROM deleted_events deleted
	);

	IF EXISTS (
		SELECT 1
		FROM "durable_event_scope" scope
		WHERE (scope.scope_kind, scope.scope_id) IN (
			SELECT DISTINCT deleted.scope_kind, deleted.scope_id
			FROM deleted_events deleted
		)
			AND (
				SELECT count(*)
				FROM "durable_event" retained
				WHERE retained.scope_kind = scope.scope_kind
					AND retained.scope_id = scope.scope_id
			) <> scope.high_water_sequence - scope.retention_floor_sequence + 1
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'Durable event cleanup must retain a contiguous sequence range',
			CONSTRAINT = 'durable_event_retained_range_contiguous_check';
	END IF;

	RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "durable_event_after_delete"
AFTER DELETE
ON "durable_event"
REFERENCING OLD TABLE AS deleted_events
FOR EACH STATEMENT
EXECUTE FUNCTION "durable_event_after_delete"();
