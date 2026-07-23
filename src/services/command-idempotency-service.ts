import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";

import type { DurableJsonObject, DurableJsonValue } from "@/db/durable-schema";

import { commandIdempotency } from "@/db/durable-schema";
import { db } from "@/lib/db";

export type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type CommandOutcome =
  | {
      outcome: "rejected" | "succeeded";
      result: DurableJsonValue;
    }
  | {
      outcome: "rejected" | "succeeded";
      resultReference: DurableJsonObject;
    };

export type CommandIdempotencyErrorCode = "idempotency_conflict" | "idempotency_in_progress";

export type CommandIdempotencyError = {
  code: CommandIdempotencyErrorCode;
  message: string;
  retryable: boolean;
};

export type IdempotentCommandResult =
  | {
      ok: true;
      recordId: string;
      replayed: boolean;
      outcome: CommandOutcome;
    }
  | {
      ok: false;
      error: CommandIdempotencyError;
    };

const idempotencyErrors: Record<CommandIdempotencyErrorCode, CommandIdempotencyError> = {
  idempotency_conflict: {
    code: "idempotency_conflict",
    message: "Idempotency key was already used for a different command request",
    retryable: false,
  },
  idempotency_in_progress: {
    code: "idempotency_in_progress",
    message: "Idempotent command has not reached a terminal outcome",
    retryable: true,
  },
};

const assertPositiveInteger = (value: number, field: string) => {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`${field} must be a positive safe integer`);
};

const assertBoundedNonblankString = (value: string, field: string, maximumLength: number) => {
  if (!value.trim() || value.length > maximumLength)
    throw new TypeError(`${field} must be nonblank and at most ${maximumLength} characters`);
};

const canonicalizeJsonValue = (value: DurableJsonValue, ancestors: Set<object>): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Command fingerprint input must be finite");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }

  if (typeof value !== "object")
    throw new TypeError("Command fingerprint input must contain only JSON values");
  if (ancestors.has(value)) throw new TypeError("Command fingerprint input cannot be cyclic");

  ancestors.add(value);
  try {
    if (Array.isArray(value))
      return `[${value.map((entry) => canonicalizeJsonValue(entry, ancestors)).join(",")}]`;

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError("Command fingerprint objects must be plain JSON objects");

    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalizeJsonValue(value[key] as DurableJsonValue, ancestors)}`,
      )
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
};

export const canonicalizeCommandRequest = (value: DurableJsonValue) =>
  canonicalizeJsonValue(value, new Set());

export const createCommandRequestFingerprint = ({
  commandName,
  commandVersion,
  normalizedRequest,
}: {
  commandName: string;
  commandVersion: number;
  normalizedRequest: DurableJsonValue;
}) => {
  assertBoundedNonblankString(commandName, "commandName", 120);
  assertPositiveInteger(commandVersion, "commandVersion");

  const canonicalRequest = canonicalizeCommandRequest({
    command: commandName,
    request: normalizedRequest,
    version: commandVersion,
  });

  return createHash("sha256")
    .update("euphoria-command-fingerprint-v1\0")
    .update(canonicalRequest)
    .digest("hex");
};

const normalizeCommandOutcome = (outcome: CommandOutcome): CommandOutcome => {
  const hasResult = "result" in outcome;
  const hasResultReference = "resultReference" in outcome;
  if (hasResult === hasResultReference)
    throw new TypeError("Command outcome must contain exactly one result or resultReference");

  if (outcome.outcome !== "succeeded" && outcome.outcome !== "rejected")
    throw new TypeError("Command outcome is invalid");

  if (hasResult) {
    canonicalizeCommandRequest(outcome.result);
    return {
      outcome: outcome.outcome,
      result: outcome.result,
    };
  }

  canonicalizeCommandRequest(outcome.resultReference);
  return {
    outcome: outcome.outcome,
    resultReference: outcome.resultReference,
  };
};

const storedCommandOutcome = (
  row: Pick<typeof commandIdempotency.$inferSelect, "outcome" | "result" | "resultReference">,
): CommandOutcome => {
  if (!row.outcome) throw new Error("Completed idempotency record has no outcome");
  if (row.result !== null)
    return {
      outcome: row.outcome,
      result: row.result.value,
    };
  if (row.resultReference !== null)
    return {
      outcome: row.outcome,
      resultReference: row.resultReference,
    };
  throw new Error("Completed idempotency record has no stored result");
};

export const runIdempotentCommand = async ({
  actorUserId,
  commandName,
  commandVersion,
  idempotencyKey,
  normalizedRequest,
  retentionSeconds,
  execute,
}: {
  actorUserId: string;
  commandName: string;
  commandVersion: number;
  idempotencyKey: string;
  normalizedRequest: DurableJsonValue;
  retentionSeconds: number;
  execute: (tx: DatabaseTransaction) => Promise<CommandOutcome>;
}): Promise<IdempotentCommandResult> => {
  assertBoundedNonblankString(actorUserId, "actorUserId", 1024);
  assertBoundedNonblankString(commandName, "commandName", 120);
  assertBoundedNonblankString(idempotencyKey, "idempotencyKey", 255);
  assertPositiveInteger(commandVersion, "commandVersion");
  assertPositiveInteger(retentionSeconds, "retentionSeconds");

  const requestFingerprint = createCommandRequestFingerprint({
    commandName,
    commandVersion,
    normalizedRequest,
  });

  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .insert(commandIdempotency)
      .values({
        actorUserId,
        commandName,
        commandVersion,
        idempotencyKey,
        requestFingerprint,
      })
      .onConflictDoNothing({
        target: [
          commandIdempotency.actorUserId,
          commandIdempotency.commandName,
          commandIdempotency.idempotencyKey,
        ],
      })
      .returning({ id: commandIdempotency.id });

    if (!claimed) {
      const [existing] = await tx
        .select({
          id: commandIdempotency.id,
          commandVersion: commandIdempotency.commandVersion,
          requestFingerprint: commandIdempotency.requestFingerprint,
          state: commandIdempotency.state,
          outcome: commandIdempotency.outcome,
          result: commandIdempotency.result,
          resultReference: commandIdempotency.resultReference,
        })
        .from(commandIdempotency)
        .where(
          and(
            eq(commandIdempotency.actorUserId, actorUserId),
            eq(commandIdempotency.commandName, commandName),
            eq(commandIdempotency.idempotencyKey, idempotencyKey),
          ),
        )
        .for("update")
        .limit(1);

      if (!existing) throw new Error("Idempotency conflict row disappeared during claim");

      if (
        existing.commandVersion !== commandVersion ||
        existing.requestFingerprint !== requestFingerprint
      ) {
        return {
          ok: false,
          error: idempotencyErrors.idempotency_conflict,
        };
      }

      if (existing.state !== "completed") {
        return {
          ok: false,
          error: idempotencyErrors.idempotency_in_progress,
        };
      }

      return {
        ok: true,
        recordId: existing.id,
        replayed: true,
        outcome: storedCommandOutcome(existing),
      };
    }

    const outcome = normalizeCommandOutcome(await execute(tx));
    const [completed] = await tx
      .update(commandIdempotency)
      .set({
        state: "completed",
        outcome: outcome.outcome,
        result: "result" in outcome ? { value: outcome.result } : null,
        resultReference: "resultReference" in outcome ? outcome.resultReference : null,
        completedAt: sql`clock_timestamp()`,
        retentionExpiresAt: sql`clock_timestamp() + (${retentionSeconds} * interval '1 second')`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(eq(commandIdempotency.id, claimed.id), eq(commandIdempotency.state, "in_progress")),
      )
      .returning({ id: commandIdempotency.id });

    if (!completed) throw new Error("Idempotency claim could not be completed");

    return {
      ok: true,
      recordId: completed.id,
      replayed: false,
      outcome,
    };
  });
};

export const cleanupCompletedIdempotencyRecords = async ({ batchSize }: { batchSize: number }) => {
  assertPositiveInteger(batchSize, "batchSize");

  return db.transaction(async (tx) => {
    const expired = await tx
      .select({ id: commandIdempotency.id })
      .from(commandIdempotency)
      .where(
        and(
          eq(commandIdempotency.state, "completed"),
          sql`${commandIdempotency.retentionExpiresAt} <= clock_timestamp()`,
        ),
      )
      .orderBy(commandIdempotency.retentionExpiresAt, commandIdempotency.id)
      .for("update", { skipLocked: true })
      .limit(batchSize);

    if (!expired.length) return [];

    return tx
      .delete(commandIdempotency)
      .where(
        inArray(
          commandIdempotency.id,
          expired.map(({ id }) => id),
        ),
      )
      .returning({ id: commandIdempotency.id });
  });
};

export const listNonterminalIdempotencyDiagnostics = async ({
  olderThanSeconds,
  limit,
}: {
  olderThanSeconds: number;
  limit: number;
}) => {
  assertPositiveInteger(olderThanSeconds, "olderThanSeconds");
  assertPositiveInteger(limit, "limit");

  return db
    .select({
      id: commandIdempotency.id,
      actorUserId: commandIdempotency.actorUserId,
      commandName: commandIdempotency.commandName,
      commandVersion: commandIdempotency.commandVersion,
      createdAt: commandIdempotency.createdAt,
      updatedAt: commandIdempotency.updatedAt,
    })
    .from(commandIdempotency)
    .where(
      and(
        eq(commandIdempotency.state, "in_progress"),
        sql`${commandIdempotency.createdAt} <= clock_timestamp() - (${olderThanSeconds} * interval '1 second')`,
      ),
    )
    .orderBy(commandIdempotency.createdAt, commandIdempotency.id)
    .limit(limit);
};
