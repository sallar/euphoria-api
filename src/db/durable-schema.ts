import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export type DurableJsonPrimitive = boolean | null | number | string;
export type DurableJsonValue =
  | DurableJsonPrimitive
  | DurableJsonValue[]
  | { [key: string]: DurableJsonValue };
export type DurableJsonObject = { [key: string]: DurableJsonValue };

export const commandIdempotencyStateValues = ["in_progress", "completed"] as const;
export const commandIdempotencyOutcomeValues = ["succeeded", "rejected"] as const;
export const durableEventScopeKindValues = [
  "chat-profile",
  "chat-conversation",
  "notification-user",
] as const;
export const deliveryJobStateValues = ["pending", "leased", "completed", "dead_letter"] as const;
export const deliveryJobDeadLetterReasonValues = [
  "permanent_failure",
  "attempts_exhausted",
  "lease_expired_after_final_claim",
] as const;
export const deliveryJobDeadLetterOutcomeValues = ["failed", "unknown"] as const;
export const deliveryJobAttemptOutcomeValues = [
  "leased",
  "completed",
  "retry_scheduled",
  "lease_expired",
  "dead_lettered_failed",
  "dead_lettered_unknown",
] as const;

export const commandIdempotencyStateEnum = pgEnum(
  "command_idempotency_state",
  commandIdempotencyStateValues,
);
export const commandIdempotencyOutcomeEnum = pgEnum(
  "command_idempotency_outcome",
  commandIdempotencyOutcomeValues,
);
export const durableEventScopeKindEnum = pgEnum(
  "durable_event_scope_kind",
  durableEventScopeKindValues,
);
export const deliveryJobStateEnum = pgEnum("delivery_job_state", deliveryJobStateValues);
export const deliveryJobDeadLetterReasonEnum = pgEnum(
  "delivery_job_dead_letter_reason",
  deliveryJobDeadLetterReasonValues,
);
export const deliveryJobDeadLetterOutcomeEnum = pgEnum(
  "delivery_job_dead_letter_outcome",
  deliveryJobDeadLetterOutcomeValues,
);
export const deliveryJobAttemptOutcomeEnum = pgEnum(
  "delivery_job_attempt_outcome",
  deliveryJobAttemptOutcomeValues,
);

export const commandIdempotency = pgTable(
  "command_idempotency",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorUserId: text("actor_user_id").notNull(),
    commandName: varchar("command_name", { length: 120 }).notNull(),
    commandVersion: integer("command_version").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    requestFingerprint: varchar("request_fingerprint", { length: 64 }).notNull(),
    state: commandIdempotencyStateEnum("state").default("in_progress").notNull(),
    outcome: commandIdempotencyOutcomeEnum("outcome"),
    result: jsonb("result").$type<{ value: DurableJsonValue }>(),
    resultReference: jsonb("result_reference").$type<DurableJsonObject>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    retentionExpiresAt: timestamp("retention_expires_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("command_idempotency_actor_command_key_unique_idx").on(
      table.actorUserId,
      table.commandName,
      table.idempotencyKey,
    ),
    index("command_idempotency_completed_retention_idx")
      .on(table.retentionExpiresAt, table.id)
      .where(sql`${table.state} = 'completed'`),
    index("command_idempotency_in_progress_created_idx")
      .on(table.createdAt, table.id)
      .where(sql`${table.state} = 'in_progress'`),
    check("command_idempotency_command_version_check", sql`${table.commandVersion} > 0`),
    check(
      "command_idempotency_key_not_blank_check",
      sql`length(btrim(${table.idempotencyKey})) > 0`,
    ),
    check(
      "command_idempotency_fingerprint_check",
      sql`${table.requestFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "command_idempotency_state_check",
      sql`(
        ${table.state} = 'in_progress'
        and ${table.outcome} is null
        and ${table.result} is null
        and ${table.resultReference} is null
        and ${table.completedAt} is null
        and ${table.retentionExpiresAt} is null
      ) or (
        ${table.state} = 'completed'
        and ${table.outcome} is not null
        and ((${table.result} is not null)::integer + (${table.resultReference} is not null)::integer) = 1
        and ${table.completedAt} is not null
        and ${table.retentionExpiresAt} > ${table.completedAt}
      )`,
    ),
  ],
);

export const durableEventScope = pgTable(
  "durable_event_scope",
  {
    scopeKind: durableEventScopeKindEnum("scope_kind").notNull(),
    scopeId: text("scope_id").notNull(),
    highWaterSequence: bigint("high_water_sequence", { mode: "bigint" }).default(0n).notNull(),
    retentionFloorSequence: bigint("retention_floor_sequence", { mode: "bigint" })
      .default(1n)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scopeKind, table.scopeId] }),
    check("durable_event_scope_id_not_blank_check", sql`length(btrim(${table.scopeId})) > 0`),
    check(
      "durable_event_scope_uuid_kind_check",
      sql`${table.scopeKind} = 'notification-user' or ${table.scopeId} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      "durable_event_scope_sequence_check",
      sql`${table.highWaterSequence} >= 0 and ${table.retentionFloorSequence} >= 1 and ${table.retentionFloorSequence} <= ${table.highWaterSequence} + 1`,
    ),
  ],
);

export const durableEvent = pgTable(
  "durable_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scopeKind: durableEventScopeKindEnum("scope_kind").notNull(),
    scopeId: text("scope_id").notNull(),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    eventType: varchar("event_type", { length: 160 }).notNull(),
    eventVersion: integer("event_version").notNull(),
    payload: jsonb("payload").$type<DurableJsonObject>().notNull(),
    causalId: uuid("causal_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }).defaultNow().notNull(),
    retentionExpiresAt: timestamp("retention_expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.scopeKind, table.scopeId],
      foreignColumns: [durableEventScope.scopeKind, durableEventScope.scopeId],
      name: "durable_event_scope_fkey",
    }),
    uniqueIndex("durable_event_scope_sequence_unique_idx").on(
      table.scopeKind,
      table.scopeId,
      table.sequence,
    ),
    index("durable_event_retention_idx").on(
      table.retentionExpiresAt,
      table.scopeKind,
      table.scopeId,
      table.sequence,
    ),
    index("durable_event_causal_id_idx")
      .on(table.causalId)
      .where(sql`${table.causalId} is not null`),
    check("durable_event_sequence_check", sql`${table.sequence} > 0`),
    check("durable_event_type_not_blank_check", sql`length(btrim(${table.eventType})) > 0`),
    check("durable_event_version_check", sql`${table.eventVersion} > 0`),
    check("durable_event_retention_check", sql`${table.retentionExpiresAt} > ${table.committedAt}`),
  ],
);

export const deliveryJob = pgTable(
  "delivery_job",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobKind: varchar("job_kind", { length: 120 }).notNull(),
    jobVersion: integer("job_version").notNull(),
    payload: jsonb("payload").$type<DurableJsonObject>().notNull(),
    state: deliveryJobStateEnum("state").default("pending").notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
    maxAttempts: integer("max_attempts").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    terminalRetentionSeconds: integer("terminal_retention_seconds").notNull(),
    leaseOwner: varchar("lease_owner", { length: 160 }),
    leaseToken: uuid("lease_token"),
    leasedAt: timestamp("leased_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
    deadLetterReason: deliveryJobDeadLetterReasonEnum("dead_letter_reason"),
    deadLetterOutcome: deliveryJobDeadLetterOutcomeEnum("dead_letter_outcome"),
    lastFailureCode: varchar("last_failure_code", { length: 100 }),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    retentionExpiresAt: timestamp("retention_expires_at", { withTimezone: true }),
    manualRequeueCount: integer("manual_requeue_count").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("delivery_job_lease_token_unique_idx")
      .on(table.leaseToken)
      .where(sql`${table.leaseToken} is not null`),
    index("delivery_job_pending_claim_idx")
      .on(table.jobKind, table.jobVersion, table.availableAt, table.createdAt, table.id)
      .where(sql`${table.state} = 'pending'`),
    index("delivery_job_expired_lease_idx")
      .on(table.jobKind, table.jobVersion, table.leaseExpiresAt, table.id)
      .where(sql`${table.state} = 'leased'`),
    index("delivery_job_dead_letter_idx")
      .on(table.jobKind, table.jobVersion, table.deadLetteredAt, table.id)
      .where(sql`${table.state} = 'dead_letter'`),
    index("delivery_job_terminal_retention_idx")
      .on(table.retentionExpiresAt, table.id)
      .where(sql`${table.state} in ('completed', 'dead_letter')`),
    check("delivery_job_kind_not_blank_check", sql`length(btrim(${table.jobKind})) > 0`),
    check("delivery_job_version_check", sql`${table.jobVersion} > 0`),
    check("delivery_job_max_attempts_check", sql`${table.maxAttempts} > 0`),
    check(
      "delivery_job_attempt_count_check",
      sql`${table.attemptCount} >= 0 and ${table.attemptCount} <= ${table.maxAttempts}`,
    ),
    check(
      "delivery_job_terminal_retention_seconds_check",
      sql`${table.terminalRetentionSeconds} > 0`,
    ),
    check("delivery_job_manual_requeue_count_check", sql`${table.manualRequeueCount} >= 0`),
    check(
      "delivery_job_failure_code_check",
      sql`${table.lastFailureCode} is null or ${table.lastFailureCode} ~ '^[a-z][a-z0-9_.:-]{0,99}$'`,
    ),
    check(
      "delivery_job_state_check",
      sql`(
        ${table.state} = 'pending'
        and ${table.leaseOwner} is null
        and ${table.leaseToken} is null
        and ${table.leasedAt} is null
        and ${table.leaseExpiresAt} is null
        and ${table.completedAt} is null
        and ${table.deadLetteredAt} is null
        and ${table.deadLetterReason} is null
        and ${table.deadLetterOutcome} is null
        and ${table.retentionExpiresAt} is null
      ) or (
        ${table.state} = 'leased'
        and ${table.attemptCount} > 0
        and ${table.leaseOwner} is not null
        and ${table.leaseToken} is not null
        and ${table.leasedAt} is not null
        and ${table.leaseExpiresAt} > ${table.leasedAt}
        and ${table.completedAt} is null
        and ${table.deadLetteredAt} is null
        and ${table.deadLetterReason} is null
        and ${table.deadLetterOutcome} is null
        and ${table.retentionExpiresAt} is null
      ) or (
        ${table.state} = 'completed'
        and ${table.leaseOwner} is null
        and ${table.leaseToken} is null
        and ${table.leasedAt} is null
        and ${table.leaseExpiresAt} is null
        and ${table.completedAt} is not null
        and ${table.deadLetteredAt} is null
        and ${table.deadLetterReason} is null
        and ${table.deadLetterOutcome} is null
        and ${table.retentionExpiresAt} > ${table.completedAt}
      ) or (
        ${table.state} = 'dead_letter'
        and ${table.leaseOwner} is null
        and ${table.leaseToken} is null
        and ${table.leasedAt} is null
        and ${table.leaseExpiresAt} is null
        and ${table.completedAt} is null
        and ${table.deadLetteredAt} is not null
        and ${table.deadLetterReason} is not null
        and ${table.deadLetterOutcome} is not null
        and ${table.retentionExpiresAt} > ${table.deadLetteredAt}
      )`,
    ),
  ],
);

export const deliveryJobAttempt = pgTable(
  "delivery_job_attempt",
  {
    leaseToken: uuid("lease_token").primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => deliveryJob.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    leaseOwner: varchar("lease_owner", { length: 160 }).notNull(),
    leasedAt: timestamp("leased_at", { withTimezone: true }).notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
    outcome: deliveryJobAttemptOutcomeEnum("outcome").default("leased").notNull(),
    failureCode: varchar("failure_code", { length: 100 }),
    nextAvailableAt: timestamp("next_available_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("delivery_job_attempt_job_number_unique_idx").on(table.jobId, table.attemptNumber),
    index("delivery_job_attempt_job_idx").on(table.jobId, table.attemptNumber),
    check("delivery_job_attempt_number_check", sql`${table.attemptNumber} > 0`),
    check("delivery_job_attempt_lease_check", sql`${table.leaseExpiresAt} > ${table.leasedAt}`),
    check(
      "delivery_job_attempt_failure_code_check",
      sql`${table.failureCode} is null or ${table.failureCode} ~ '^[a-z][a-z0-9_.:-]{0,99}$'`,
    ),
    check(
      "delivery_job_attempt_outcome_check",
      sql`(
        ${table.outcome} = 'leased'
        and ${table.failureCode} is null
        and ${table.nextAvailableAt} is null
        and ${table.finishedAt} is null
      ) or (
        ${table.outcome} = 'completed'
        and ${table.failureCode} is null
        and ${table.nextAvailableAt} is null
        and ${table.finishedAt} is not null
      ) or (
        ${table.outcome} = 'retry_scheduled'
        and ${table.failureCode} is not null
        and ${table.nextAvailableAt} is not null
        and ${table.finishedAt} is not null
      ) or (
        ${table.outcome} in ('lease_expired', 'dead_lettered_failed', 'dead_lettered_unknown')
        and ${table.failureCode} is not null
        and ${table.nextAvailableAt} is null
        and ${table.finishedAt} is not null
      )`,
    ),
  ],
);

export const deliveryJobManualRequeue = pgTable(
  "delivery_job_manual_requeue",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => deliveryJob.id, { onDelete: "cascade" }),
    requestedBy: varchar("requested_by", { length: 160 }).notNull(),
    reasonCode: varchar("reason_code", { length: 100 }).notNull(),
    previousDeadLetterReason: deliveryJobDeadLetterReasonEnum(
      "previous_dead_letter_reason",
    ).notNull(),
    previousDeadLetterOutcome: deliveryJobDeadLetterOutcomeEnum(
      "previous_dead_letter_outcome",
    ).notNull(),
    previousAttemptCount: integer("previous_attempt_count").notNull(),
    nextMaxAttempts: integer("next_max_attempts").notNull(),
    nextAvailableAt: timestamp("next_available_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("delivery_job_manual_requeue_job_idx").on(table.jobId, table.createdAt),
    check(
      "delivery_job_manual_requeue_requested_by_check",
      sql`length(btrim(${table.requestedBy})) > 0`,
    ),
    check(
      "delivery_job_manual_requeue_reason_code_check",
      sql`${table.reasonCode} ~ '^[a-z][a-z0-9_.:-]{0,99}$'`,
    ),
    check(
      "delivery_job_manual_requeue_attempts_check",
      sql`${table.previousAttemptCount} > 0 and ${table.nextMaxAttempts} > 0`,
    ),
  ],
);
