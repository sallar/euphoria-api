import { and, eq, inArray, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { DurableJsonObject } from "@/db/durable-schema";
import type { DatabaseTransaction } from "@/services/command-idempotency-service";

import { deliveryJob, deliveryJobAttempt, deliveryJobManualRequeue } from "@/db/durable-schema";
import { db } from "@/lib/db";

export type DeliveryJobFailure = {
  code?: unknown;
};

export type DeliveryJobTransitionErrorCode =
  | "delivery_job_invalid_transition"
  | "delivery_job_lease_lost"
  | "delivery_job_not_found";

export type DeliveryJobTransitionError = {
  code: DeliveryJobTransitionErrorCode;
  message: string;
  retryable: boolean;
};

export type DeliveryJobTransitionResult =
  | {
      ok: true;
      status:
        | "already_completed"
        | "already_dead_lettered"
        | "already_retried"
        | "completed"
        | "dead_lettered"
        | "retry_scheduled";
    }
  | {
      ok: false;
      error: DeliveryJobTransitionError;
    };

const failureCodePattern = /^[a-z][a-z0-9_.:-]{0,99}$/;

const deliveryJobErrors: Record<DeliveryJobTransitionErrorCode, DeliveryJobTransitionError> = {
  delivery_job_invalid_transition: {
    code: "delivery_job_invalid_transition",
    message: "Delivery job is not in the required state",
    retryable: false,
  },
  delivery_job_lease_lost: {
    code: "delivery_job_lease_lost",
    message: "Delivery job lease is no longer owned by this worker and fencing token",
    retryable: false,
  },
  delivery_job_not_found: {
    code: "delivery_job_not_found",
    message: "Delivery job does not exist",
    retryable: false,
  },
};

const assertPositiveInteger = (value: number, field: string) => {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`${field} must be a positive safe integer`);
};

const assertNonnegativeInteger = (value: number, field: string) => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${field} must be a nonnegative safe integer`);
};

const assertBoundedNonblankString = (value: string, field: string, maximumLength: number) => {
  if (!value.trim() || value.length > maximumLength)
    throw new TypeError(`${field} must be nonblank and at most ${maximumLength} characters`);
};

const assertValidDate = (value: Date, field: string) => {
  if (!(value instanceof Date) || Number.isNaN(value.getTime()))
    throw new TypeError(`${field} must be a valid date`);
};

export const sanitizeDeliveryJobFailureCode = (failure: unknown) => {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "code" in failure &&
    typeof failure.code === "string" &&
    failureCodePattern.test(failure.code)
  ) {
    return failure.code;
  }

  return "unspecified_failure";
};

const validateJobIdentity = ({ jobKind, jobVersion }: { jobKind: string; jobVersion: number }) => {
  assertBoundedNonblankString(jobKind, "jobKind", 120);
  assertPositiveInteger(jobVersion, "jobVersion");
};

export const enqueueDeliveryJobInTransaction = async ({
  availableInSeconds,
  jobKind,
  jobVersion,
  maxAttempts,
  payload,
  terminalRetentionSeconds,
  tx,
}: {
  availableInSeconds: number;
  jobKind: string;
  jobVersion: number;
  maxAttempts: number;
  payload: DurableJsonObject;
  terminalRetentionSeconds: number;
  tx: DatabaseTransaction;
}) => {
  validateJobIdentity({ jobKind, jobVersion });
  assertNonnegativeInteger(availableInSeconds, "availableInSeconds");
  assertPositiveInteger(maxAttempts, "maxAttempts");
  assertPositiveInteger(terminalRetentionSeconds, "terminalRetentionSeconds");

  const [created] = await tx
    .insert(deliveryJob)
    .values({
      jobKind,
      jobVersion,
      payload,
      availableAt: sql`clock_timestamp() + (${availableInSeconds} * interval '1 second')`,
      maxAttempts,
      terminalRetentionSeconds,
      updatedAt: sql`clock_timestamp()`,
    })
    .returning();

  if (!created) throw new Error("Delivery job could not be enqueued");
  return created;
};

export const enqueueDeliveryJob = ({
  availableInSeconds,
  jobKind,
  jobVersion,
  maxAttempts,
  payload,
  terminalRetentionSeconds,
}: {
  availableInSeconds: number;
  jobKind: string;
  jobVersion: number;
  maxAttempts: number;
  payload: DurableJsonObject;
  terminalRetentionSeconds: number;
}) =>
  db.transaction((tx) =>
    enqueueDeliveryJobInTransaction({
      availableInSeconds,
      jobKind,
      jobVersion,
      maxAttempts,
      payload,
      terminalRetentionSeconds,
      tx,
    }),
  );

const deadLetterExpiredFinalAttemptLeasesInTransaction = async ({
  jobKind,
  jobVersion,
  limit,
  tx,
}: {
  jobKind: string;
  jobVersion: number;
  limit: number;
  tx: DatabaseTransaction;
}) => {
  const expired = await tx
    .select({
      id: deliveryJob.id,
      leaseToken: deliveryJob.leaseToken,
    })
    .from(deliveryJob)
    .where(
      and(
        eq(deliveryJob.jobKind, jobKind),
        eq(deliveryJob.jobVersion, jobVersion),
        eq(deliveryJob.state, "leased"),
        sql`${deliveryJob.leaseExpiresAt} <= clock_timestamp()`,
        sql`${deliveryJob.attemptCount} >= ${deliveryJob.maxAttempts}`,
      ),
    )
    .orderBy(deliveryJob.leaseExpiresAt, deliveryJob.id)
    .for("update", { skipLocked: true })
    .limit(limit);

  const deadLetteredIds: string[] = [];
  for (const candidate of expired) {
    if (!candidate.leaseToken) throw new Error("Leased delivery job is missing its fencing token");

    const [deadLettered] = await tx
      .update(deliveryJob)
      .set({
        state: "dead_letter",
        leaseOwner: null,
        leaseToken: null,
        leasedAt: null,
        leaseExpiresAt: null,
        deadLetteredAt: sql`clock_timestamp()`,
        deadLetterReason: "lease_expired_after_final_claim",
        deadLetterOutcome: "unknown",
        lastFailureCode: "lease_expired_after_final_claim",
        lastFailureAt: sql`clock_timestamp()`,
        retentionExpiresAt: sql`clock_timestamp() + (${deliveryJob.terminalRetentionSeconds} * interval '1 second')`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(deliveryJob.id, candidate.id),
          eq(deliveryJob.state, "leased"),
          eq(deliveryJob.leaseToken, candidate.leaseToken),
          sql`${deliveryJob.leaseExpiresAt} <= clock_timestamp()`,
          sql`${deliveryJob.attemptCount} >= ${deliveryJob.maxAttempts}`,
        ),
      )
      .returning({ id: deliveryJob.id });

    if (!deadLettered) continue;

    const [closedAttempt] = await tx
      .update(deliveryJobAttempt)
      .set({
        outcome: "dead_lettered_unknown",
        failureCode: "lease_expired_after_final_claim",
        finishedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(deliveryJobAttempt.jobId, candidate.id),
          eq(deliveryJobAttempt.leaseToken, candidate.leaseToken),
          eq(deliveryJobAttempt.outcome, "leased"),
        ),
      )
      .returning({ leaseToken: deliveryJobAttempt.leaseToken });

    if (!closedAttempt) throw new Error("Final expired delivery-job attempt history is missing");

    deadLetteredIds.push(deadLettered.id);
  }

  return deadLetteredIds;
};

export const claimDeliveryJobsInTransaction = async ({
  jobKind,
  jobVersion,
  leaseDurationSeconds,
  leaseOwner,
  limit,
  tx,
}: {
  jobKind: string;
  jobVersion: number;
  leaseDurationSeconds: number;
  leaseOwner: string;
  limit: number;
  tx: DatabaseTransaction;
}) => {
  validateJobIdentity({ jobKind, jobVersion });
  assertBoundedNonblankString(leaseOwner, "leaseOwner", 160);
  assertPositiveInteger(leaseDurationSeconds, "leaseDurationSeconds");
  assertPositiveInteger(limit, "limit");

  const deadLetteredExpiredJobIds = await deadLetterExpiredFinalAttemptLeasesInTransaction({
    jobKind,
    jobVersion,
    limit,
    tx,
  });

  const candidates = await tx
    .select()
    .from(deliveryJob)
    .where(
      and(
        eq(deliveryJob.jobKind, jobKind),
        eq(deliveryJob.jobVersion, jobVersion),
        or(
          and(
            eq(deliveryJob.state, "pending"),
            sql`${deliveryJob.availableAt} <= clock_timestamp()`,
            sql`${deliveryJob.attemptCount} < ${deliveryJob.maxAttempts}`,
          ),
          and(
            eq(deliveryJob.state, "leased"),
            sql`${deliveryJob.leaseExpiresAt} <= clock_timestamp()`,
            sql`${deliveryJob.attemptCount} < ${deliveryJob.maxAttempts}`,
          ),
        ),
      ),
    )
    .orderBy(deliveryJob.availableAt, deliveryJob.createdAt, deliveryJob.id)
    .for("update", { skipLocked: true })
    .limit(limit);

  const jobs: (typeof deliveryJob.$inferSelect)[] = [];
  for (const candidate of candidates) {
    if (candidate.state === "leased") {
      if (!candidate.leaseToken)
        throw new Error("Leased delivery job is missing its fencing token");

      const [closedAttempt] = await tx
        .update(deliveryJobAttempt)
        .set({
          outcome: "lease_expired",
          failureCode: "lease_expired",
          finishedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(deliveryJobAttempt.jobId, candidate.id),
            eq(deliveryJobAttempt.leaseToken, candidate.leaseToken),
            eq(deliveryJobAttempt.outcome, "leased"),
          ),
        )
        .returning({ leaseToken: deliveryJobAttempt.leaseToken });

      if (!closedAttempt) throw new Error("Reclaimed delivery-job attempt history is missing");
    }

    const leaseToken = randomUUID();
    const [claimed] = await tx
      .update(deliveryJob)
      .set({
        state: "leased",
        attemptCount: sql`${deliveryJob.attemptCount} + 1`,
        leaseOwner,
        leaseToken,
        leasedAt: sql`clock_timestamp()`,
        leaseExpiresAt: sql`clock_timestamp() + (${leaseDurationSeconds} * interval '1 second')`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(deliveryJob.id, candidate.id))
      .returning();

    if (!claimed) throw new Error("Locked delivery job could not be claimed");
    if (!claimed.leaseToken || !claimed.leasedAt || !claimed.leaseExpiresAt)
      throw new Error("Claimed delivery job is missing lease metadata");

    await tx.insert(deliveryJobAttempt).values({
      leaseToken: claimed.leaseToken,
      jobId: claimed.id,
      attemptNumber: claimed.attemptCount,
      leaseOwner: claimed.leaseOwner as string,
      leasedAt: claimed.leasedAt,
      leaseExpiresAt: claimed.leaseExpiresAt,
    });

    jobs.push(claimed);
  }

  return {
    deadLetteredExpiredJobIds,
    jobs,
  };
};

export const claimDeliveryJobs = ({
  jobKind,
  jobVersion,
  leaseDurationSeconds,
  leaseOwner,
  limit,
}: {
  jobKind: string;
  jobVersion: number;
  leaseDurationSeconds: number;
  leaseOwner: string;
  limit: number;
}) =>
  db.transaction((tx) =>
    claimDeliveryJobsInTransaction({
      jobKind,
      jobVersion,
      leaseDurationSeconds,
      leaseOwner,
      limit,
      tx,
    }),
  );

const findIdempotentTransition = async ({
  expectedOutcomes,
  jobId,
  leaseToken,
  tx,
}: {
  expectedOutcomes: (typeof deliveryJobAttempt.$inferSelect.outcome)[];
  jobId: string;
  leaseToken: string;
  tx: DatabaseTransaction;
}) => {
  const [attempt] = await tx
    .select({ outcome: deliveryJobAttempt.outcome })
    .from(deliveryJobAttempt)
    .where(
      and(
        eq(deliveryJobAttempt.jobId, jobId),
        eq(deliveryJobAttempt.leaseToken, leaseToken),
        inArray(deliveryJobAttempt.outcome, expectedOutcomes),
      ),
    )
    .limit(1);

  return attempt;
};

export const completeDeliveryJob = async ({
  jobId,
  leaseOwner,
  leaseToken,
}: {
  jobId: string;
  leaseOwner: string;
  leaseToken: string;
}): Promise<DeliveryJobTransitionResult> => {
  assertBoundedNonblankString(leaseOwner, "leaseOwner", 160);

  return db.transaction(async (tx) => {
    const [completed] = await tx
      .update(deliveryJob)
      .set({
        state: "completed",
        leaseOwner: null,
        leaseToken: null,
        leasedAt: null,
        leaseExpiresAt: null,
        completedAt: sql`clock_timestamp()`,
        retentionExpiresAt: sql`clock_timestamp() + (${deliveryJob.terminalRetentionSeconds} * interval '1 second')`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(deliveryJob.id, jobId),
          eq(deliveryJob.state, "leased"),
          eq(deliveryJob.leaseOwner, leaseOwner),
          eq(deliveryJob.leaseToken, leaseToken),
          sql`${deliveryJob.leaseExpiresAt} > clock_timestamp()`,
        ),
      )
      .returning({ id: deliveryJob.id });

    if (completed) {
      const [closedAttempt] = await tx
        .update(deliveryJobAttempt)
        .set({
          outcome: "completed",
          finishedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(deliveryJobAttempt.jobId, jobId),
            eq(deliveryJobAttempt.leaseToken, leaseToken),
            eq(deliveryJobAttempt.leaseOwner, leaseOwner),
            eq(deliveryJobAttempt.outcome, "leased"),
          ),
        )
        .returning({ leaseToken: deliveryJobAttempt.leaseToken });

      if (!closedAttempt) throw new Error("Completed delivery-job attempt history is missing");

      return {
        ok: true,
        status: "completed",
      };
    }

    if (
      await findIdempotentTransition({
        expectedOutcomes: ["completed"],
        jobId,
        leaseToken,
        tx,
      })
    ) {
      return {
        ok: true,
        status: "already_completed",
      };
    }

    const [existing] = await tx
      .select({ id: deliveryJob.id })
      .from(deliveryJob)
      .where(eq(deliveryJob.id, jobId))
      .limit(1);

    return existing
      ? {
          ok: false,
          error: deliveryJobErrors.delivery_job_lease_lost,
        }
      : {
          ok: false,
          error: deliveryJobErrors.delivery_job_not_found,
        };
  });
};

export const retryDeliveryJob = async ({
  availableAt,
  failure,
  jobId,
  leaseOwner,
  leaseToken,
}: {
  availableAt: Date;
  failure: DeliveryJobFailure | unknown;
  jobId: string;
  leaseOwner: string;
  leaseToken: string;
}): Promise<DeliveryJobTransitionResult> => {
  assertValidDate(availableAt, "availableAt");
  assertBoundedNonblankString(leaseOwner, "leaseOwner", 160);
  const failureCode = sanitizeDeliveryJobFailureCode(failure);

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        attemptCount: deliveryJob.attemptCount,
        leaseIsCurrent: sql<boolean>`${deliveryJob.leaseExpiresAt} > clock_timestamp()`,
        leaseOwner: deliveryJob.leaseOwner,
        leaseToken: deliveryJob.leaseToken,
        maxAttempts: deliveryJob.maxAttempts,
        state: deliveryJob.state,
      })
      .from(deliveryJob)
      .where(eq(deliveryJob.id, jobId))
      .for("update")
      .limit(1);

    if (!current)
      return {
        ok: false,
        error: deliveryJobErrors.delivery_job_not_found,
      };

    if (
      current.state !== "leased" ||
      current.leaseOwner !== leaseOwner ||
      current.leaseToken !== leaseToken ||
      !current.leaseIsCurrent
    ) {
      const prior = await findIdempotentTransition({
        expectedOutcomes: ["dead_lettered_failed", "retry_scheduled"],
        jobId,
        leaseToken,
        tx,
      });
      if (prior?.outcome === "retry_scheduled")
        return {
          ok: true,
          status: "already_retried",
        };
      if (prior?.outcome === "dead_lettered_failed")
        return {
          ok: true,
          status: "already_dead_lettered",
        };

      return {
        ok: false,
        error: deliveryJobErrors.delivery_job_lease_lost,
      };
    }

    if (current.attemptCount < current.maxAttempts) {
      const [retried] = await tx
        .update(deliveryJob)
        .set({
          state: "pending",
          availableAt,
          leaseOwner: null,
          leaseToken: null,
          leasedAt: null,
          leaseExpiresAt: null,
          lastFailureCode: failureCode,
          lastFailureAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(deliveryJob.id, jobId),
            eq(deliveryJob.state, "leased"),
            eq(deliveryJob.leaseOwner, leaseOwner),
            eq(deliveryJob.leaseToken, leaseToken),
            sql`${deliveryJob.leaseExpiresAt} > clock_timestamp()`,
          ),
        )
        .returning({ id: deliveryJob.id });

      if (!retried)
        return {
          ok: false,
          error: deliveryJobErrors.delivery_job_lease_lost,
        };

      const [closedAttempt] = await tx
        .update(deliveryJobAttempt)
        .set({
          outcome: "retry_scheduled",
          failureCode,
          nextAvailableAt: availableAt,
          finishedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(deliveryJobAttempt.jobId, jobId),
            eq(deliveryJobAttempt.leaseToken, leaseToken),
            eq(deliveryJobAttempt.leaseOwner, leaseOwner),
            eq(deliveryJobAttempt.outcome, "leased"),
          ),
        )
        .returning({ leaseToken: deliveryJobAttempt.leaseToken });

      if (!closedAttempt) throw new Error("Retried delivery-job attempt history is missing");

      return {
        ok: true,
        status: "retry_scheduled",
      };
    }

    const [deadLettered] = await tx
      .update(deliveryJob)
      .set({
        state: "dead_letter",
        leaseOwner: null,
        leaseToken: null,
        leasedAt: null,
        leaseExpiresAt: null,
        deadLetteredAt: sql`clock_timestamp()`,
        deadLetterReason: "attempts_exhausted",
        deadLetterOutcome: "failed",
        lastFailureCode: failureCode,
        lastFailureAt: sql`clock_timestamp()`,
        retentionExpiresAt: sql`clock_timestamp() + (${deliveryJob.terminalRetentionSeconds} * interval '1 second')`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(deliveryJob.id, jobId),
          eq(deliveryJob.state, "leased"),
          eq(deliveryJob.leaseOwner, leaseOwner),
          eq(deliveryJob.leaseToken, leaseToken),
          sql`${deliveryJob.leaseExpiresAt} > clock_timestamp()`,
        ),
      )
      .returning({ id: deliveryJob.id });

    if (!deadLettered)
      return {
        ok: false,
        error: deliveryJobErrors.delivery_job_lease_lost,
      };

    const [closedAttempt] = await tx
      .update(deliveryJobAttempt)
      .set({
        outcome: "dead_lettered_failed",
        failureCode,
        finishedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(deliveryJobAttempt.jobId, jobId),
          eq(deliveryJobAttempt.leaseToken, leaseToken),
          eq(deliveryJobAttempt.leaseOwner, leaseOwner),
          eq(deliveryJobAttempt.outcome, "leased"),
        ),
      )
      .returning({ leaseToken: deliveryJobAttempt.leaseToken });

    if (!closedAttempt) throw new Error("Exhausted delivery-job attempt history is missing");

    return {
      ok: true,
      status: "dead_lettered",
    };
  });
};

export const deadLetterDeliveryJob = async ({
  failure,
  jobId,
  leaseOwner,
  leaseToken,
}: {
  failure: DeliveryJobFailure | unknown;
  jobId: string;
  leaseOwner: string;
  leaseToken: string;
}): Promise<DeliveryJobTransitionResult> => {
  assertBoundedNonblankString(leaseOwner, "leaseOwner", 160);
  const failureCode = sanitizeDeliveryJobFailureCode(failure);

  return db.transaction(async (tx) => {
    const [deadLettered] = await tx
      .update(deliveryJob)
      .set({
        state: "dead_letter",
        leaseOwner: null,
        leaseToken: null,
        leasedAt: null,
        leaseExpiresAt: null,
        deadLetteredAt: sql`clock_timestamp()`,
        deadLetterReason: "permanent_failure",
        deadLetterOutcome: "failed",
        lastFailureCode: failureCode,
        lastFailureAt: sql`clock_timestamp()`,
        retentionExpiresAt: sql`clock_timestamp() + (${deliveryJob.terminalRetentionSeconds} * interval '1 second')`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(deliveryJob.id, jobId),
          eq(deliveryJob.state, "leased"),
          eq(deliveryJob.leaseOwner, leaseOwner),
          eq(deliveryJob.leaseToken, leaseToken),
          sql`${deliveryJob.leaseExpiresAt} > clock_timestamp()`,
        ),
      )
      .returning({ id: deliveryJob.id });

    if (deadLettered) {
      const [closedAttempt] = await tx
        .update(deliveryJobAttempt)
        .set({
          outcome: "dead_lettered_failed",
          failureCode,
          finishedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(deliveryJobAttempt.jobId, jobId),
            eq(deliveryJobAttempt.leaseToken, leaseToken),
            eq(deliveryJobAttempt.leaseOwner, leaseOwner),
            eq(deliveryJobAttempt.outcome, "leased"),
          ),
        )
        .returning({ leaseToken: deliveryJobAttempt.leaseToken });

      if (!closedAttempt) throw new Error("Dead-lettered delivery-job attempt history is missing");

      return {
        ok: true,
        status: "dead_lettered",
      };
    }

    if (
      await findIdempotentTransition({
        expectedOutcomes: ["dead_lettered_failed"],
        jobId,
        leaseToken,
        tx,
      })
    ) {
      return {
        ok: true,
        status: "already_dead_lettered",
      };
    }

    const [existing] = await tx
      .select({ id: deliveryJob.id })
      .from(deliveryJob)
      .where(eq(deliveryJob.id, jobId))
      .limit(1);

    return existing
      ? {
          ok: false,
          error: deliveryJobErrors.delivery_job_lease_lost,
        }
      : {
          ok: false,
          error: deliveryJobErrors.delivery_job_not_found,
        };
  });
};

export const manuallyRequeueDeliveryJob = async ({
  availableInSeconds,
  jobId,
  maxAttempts,
  reasonCode,
  requestedBy,
}: {
  availableInSeconds: number;
  jobId: string;
  maxAttempts: number;
  reasonCode: string;
  requestedBy: string;
}) => {
  assertNonnegativeInteger(availableInSeconds, "availableInSeconds");
  assertPositiveInteger(maxAttempts, "maxAttempts");
  assertBoundedNonblankString(requestedBy, "requestedBy", 160);
  if (!failureCodePattern.test(reasonCode))
    throw new TypeError("reasonCode must be a sanitized machine-readable code");

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(deliveryJob)
      .where(eq(deliveryJob.id, jobId))
      .for("update")
      .limit(1);

    if (!current)
      return {
        ok: false as const,
        error: deliveryJobErrors.delivery_job_not_found,
      };
    if (
      current.state !== "dead_letter" ||
      !current.deadLetterReason ||
      !current.deadLetterOutcome
    ) {
      return {
        ok: false as const,
        error: deliveryJobErrors.delivery_job_invalid_transition,
      };
    }
    if (maxAttempts <= current.attemptCount) {
      return {
        ok: false as const,
        error: deliveryJobErrors.delivery_job_invalid_transition,
      };
    }

    const [audit] = await tx
      .insert(deliveryJobManualRequeue)
      .values({
        jobId,
        requestedBy,
        reasonCode,
        previousDeadLetterReason: current.deadLetterReason,
        previousDeadLetterOutcome: current.deadLetterOutcome,
        previousAttemptCount: current.attemptCount,
        nextMaxAttempts: maxAttempts,
        nextAvailableAt: sql`clock_timestamp() + (${availableInSeconds} * interval '1 second')`,
      })
      .returning();

    if (!audit) throw new Error("Delivery job manual requeue audit could not be written");

    const [requeued] = await tx
      .update(deliveryJob)
      .set({
        state: "pending",
        availableAt: audit.nextAvailableAt,
        maxAttempts,
        completedAt: null,
        deadLetteredAt: null,
        deadLetterReason: null,
        deadLetterOutcome: null,
        lastFailureCode: null,
        lastFailureAt: null,
        retentionExpiresAt: null,
        manualRequeueCount: sql`${deliveryJob.manualRequeueCount} + 1`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(and(eq(deliveryJob.id, jobId), eq(deliveryJob.state, "dead_letter")))
      .returning();

    if (!requeued) throw new Error("Locked dead-letter delivery job could not be requeued");

    return {
      ok: true as const,
      audit,
      job: requeued,
    };
  });
};

export const listDeliveryJobDeadLetters = ({
  jobKind,
  jobVersion,
  limit,
}: {
  jobKind: string;
  jobVersion: number;
  limit: number;
}) => {
  validateJobIdentity({ jobKind, jobVersion });
  assertPositiveInteger(limit, "limit");

  return db
    .select({
      id: deliveryJob.id,
      jobKind: deliveryJob.jobKind,
      jobVersion: deliveryJob.jobVersion,
      state: deliveryJob.state,
      attemptCount: deliveryJob.attemptCount,
      maxAttempts: deliveryJob.maxAttempts,
      deadLetteredAt: deliveryJob.deadLetteredAt,
      deadLetterReason: deliveryJob.deadLetterReason,
      deadLetterOutcome: deliveryJob.deadLetterOutcome,
      lastFailureCode: deliveryJob.lastFailureCode,
      manualRequeueCount: deliveryJob.manualRequeueCount,
    })
    .from(deliveryJob)
    .where(
      and(
        eq(deliveryJob.jobKind, jobKind),
        eq(deliveryJob.jobVersion, jobVersion),
        eq(deliveryJob.state, "dead_letter"),
      ),
    )
    .orderBy(deliveryJob.deadLetteredAt, deliveryJob.id)
    .limit(limit);
};

export const cleanupTerminalDeliveryJobs = async ({ batchSize }: { batchSize: number }) => {
  assertPositiveInteger(batchSize, "batchSize");

  return db.transaction(async (tx) => {
    const expired = await tx
      .select({ id: deliveryJob.id })
      .from(deliveryJob)
      .where(
        and(
          inArray(deliveryJob.state, ["completed", "dead_letter"]),
          sql`${deliveryJob.retentionExpiresAt} <= clock_timestamp()`,
        ),
      )
      .orderBy(deliveryJob.retentionExpiresAt, deliveryJob.id)
      .for("update", { skipLocked: true })
      .limit(batchSize);

    if (!expired.length) return [];

    return tx
      .delete(deliveryJob)
      .where(
        inArray(
          deliveryJob.id,
          expired.map(({ id }) => id),
        ),
      )
      .returning({ id: deliveryJob.id });
  });
};
