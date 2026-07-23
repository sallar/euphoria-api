-- Manual pre-producer rollback for the F3 durable substrate.
-- This file is intentionally not run by drizzle-kit. Execute it only after
-- confirming that no F4/F5 producer has been enabled and after taking a backup.

DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM public.command_idempotency LIMIT 1)
		OR EXISTS (SELECT 1 FROM public.durable_event_scope LIMIT 1)
		OR EXISTS (SELECT 1 FROM public.delivery_job LIMIT 1) THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'F3 rollback requires empty command, event-scope, and job tables';
	END IF;
END
$$;

DROP TRIGGER IF EXISTS durable_event_after_delete ON public.durable_event;
DROP TRIGGER IF EXISTS durable_event_update_guard ON public.durable_event;
DROP TRIGGER IF EXISTS durable_event_insert_guard ON public.durable_event;
DROP TRIGGER IF EXISTS durable_event_scope_guard ON public.durable_event_scope;

DROP FUNCTION IF EXISTS public.durable_event_after_delete();
DROP FUNCTION IF EXISTS public.durable_event_update_guard();
DROP FUNCTION IF EXISTS public.durable_event_insert_guard();
DROP FUNCTION IF EXISTS public.durable_event_scope_guard();

DROP TABLE public.delivery_job_manual_requeue;
DROP TABLE public.delivery_job_attempt;
DROP TABLE public.delivery_job;
DROP TABLE public.durable_event;
DROP TABLE public.durable_event_scope;
DROP TABLE public.command_idempotency;

DROP TYPE public.delivery_job_attempt_outcome;
DROP TYPE public.delivery_job_dead_letter_outcome;
DROP TYPE public.delivery_job_dead_letter_reason;
DROP TYPE public.delivery_job_state;
DROP TYPE public.durable_event_scope_kind;
DROP TYPE public.command_idempotency_outcome;
DROP TYPE public.command_idempotency_state;
