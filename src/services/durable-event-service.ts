import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { DurableJsonObject } from "@/db/durable-schema";
import type { DatabaseTransaction } from "@/services/command-idempotency-service";

import { chatConversation } from "@/db/chat-schema";
import { durableEvent, durableEventScope } from "@/db/durable-schema";
import { profile, profileUser } from "@/db/profile-schema";
import { db } from "@/lib/db";

export type DurableEventScope =
  | {
      kind: "chat-conversation";
      id: string;
    }
  | {
      kind: "chat-profile";
      id: string;
    }
  | {
      kind: "notification-user";
      id: string;
    };

export type DurableScopeAuthorizationError = {
  code: "durable_scope_forbidden" | "durable_scope_invalid";
  message: string;
};

export type DurableCheckpointError = {
  code: "durable_checkpoint_ahead" | "durable_checkpoint_before_retention";
  message: string;
  scope: DurableEventScope;
  retentionFloor: bigint;
  highWater: bigint;
};

export type DurableEventInput = {
  scope: DurableEventScope;
  eventType: string;
  eventVersion: number;
  payload: DurableJsonObject;
  retentionSeconds: number;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const assertPositiveInteger = (value: number, field: string) => {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`${field} must be a positive safe integer`);
};

const assertScope = (scope: DurableEventScope) => {
  if (
    scope.kind !== "chat-profile" &&
    scope.kind !== "chat-conversation" &&
    scope.kind !== "notification-user"
  ) {
    throw new TypeError("Durable event scope kind is not approved");
  }
  if (!scope.id.trim()) throw new TypeError("Durable event scope ID cannot be blank");
  if (scope.kind !== "notification-user" && !uuidPattern.test(scope.id))
    throw new TypeError("Chat durable event scope ID must be a UUID");
};

const assertEventInput = (event: DurableEventInput) => {
  assertScope(event.scope);
  if (!event.eventType.trim() || event.eventType.length > 160)
    throw new TypeError("eventType must be nonblank and at most 160 characters");
  assertPositiveInteger(event.eventVersion, "eventVersion");
  assertPositiveInteger(event.retentionSeconds, "retentionSeconds");
};

export const createDurableEventCausalId = () => randomUUID();

export const authorizeDurableEventScopeInTransaction = async ({
  authenticatedUserId,
  scope,
  tx,
}: {
  authenticatedUserId: string;
  scope: DurableEventScope;
  tx: DatabaseTransaction;
}): Promise<
  | {
      ok: true;
    }
  | {
      ok: false;
      error: DurableScopeAuthorizationError;
    }
> => {
  try {
    assertScope(scope);
  } catch {
    return {
      ok: false,
      error: {
        code: "durable_scope_invalid",
        message: "Durable event scope is invalid",
      },
    };
  }

  if (scope.kind === "notification-user") {
    return scope.id === authenticatedUserId
      ? { ok: true }
      : {
          ok: false,
          error: {
            code: "durable_scope_forbidden",
            message: "Authenticated user cannot access this durable event scope",
          },
        };
  }

  const [membership] =
    scope.kind === "chat-profile"
      ? await tx
          .select({ profileId: profileUser.profileId })
          .from(profileUser)
          .innerJoin(profile, eq(profile.id, profileUser.profileId))
          .where(
            and(
              eq(profileUser.profileId, scope.id),
              eq(profileUser.userId, authenticatedUserId),
              isNull(profile.deletedAt),
            ),
          )
          .limit(1)
      : await tx
          .select({ profileId: profileUser.profileId })
          .from(chatConversation)
          .innerJoin(
            profileUser,
            or(
              eq(profileUser.profileId, chatConversation.profileOneId),
              eq(profileUser.profileId, chatConversation.profileTwoId),
            ),
          )
          .innerJoin(profile, eq(profile.id, profileUser.profileId))
          .where(
            and(
              eq(chatConversation.id, scope.id),
              eq(profileUser.userId, authenticatedUserId),
              isNull(profile.deletedAt),
            ),
          )
          .limit(1);

  return membership
    ? { ok: true }
    : {
        ok: false,
        error: {
          code: "durable_scope_forbidden",
          message: "Authenticated user cannot access this durable event scope",
        },
      };
};

export const authorizeDurableEventScope = ({
  authenticatedUserId,
  scope,
}: {
  authenticatedUserId: string;
  scope: DurableEventScope;
}) =>
  db.transaction((tx) =>
    authorizeDurableEventScopeInTransaction({
      authenticatedUserId,
      scope,
      tx,
    }),
  );

export const ensureDurableEventScopeInTransaction = async (
  tx: DatabaseTransaction,
  scope: DurableEventScope,
) => {
  assertScope(scope);

  await tx
    .insert(durableEventScope)
    .values({
      scopeKind: scope.kind,
      scopeId: scope.id,
      highWaterSequence: 0n,
      retentionFloorSequence: 1n,
      updatedAt: sql`clock_timestamp()`,
    })
    .onConflictDoNothing({
      target: [durableEventScope.scopeKind, durableEventScope.scopeId],
    });

  const [metadata] = await tx
    .select()
    .from(durableEventScope)
    .where(
      and(eq(durableEventScope.scopeKind, scope.kind), eq(durableEventScope.scopeId, scope.id)),
    )
    .limit(1);

  if (!metadata) throw new Error("Durable event scope metadata could not be created");
  return metadata;
};

export const appendDurableEventsInTransaction = async ({
  causalId,
  events,
  tx,
}: {
  causalId?: string | null;
  events: DurableEventInput[];
  tx: DatabaseTransaction;
}) => {
  if (causalId !== undefined && causalId !== null && !uuidPattern.test(causalId))
    throw new TypeError("causalId must be a UUID");
  if (!events.length) return [];

  for (const event of events) assertEventInput(event);

  const appended: (typeof durableEvent.$inferSelect)[] = [];
  for (const event of events) {
    const [allocated] = await tx
      .insert(durableEventScope)
      .values({
        scopeKind: event.scope.kind,
        scopeId: event.scope.id,
        highWaterSequence: 1n,
        retentionFloorSequence: 1n,
        updatedAt: sql`clock_timestamp()`,
      })
      .onConflictDoUpdate({
        target: [durableEventScope.scopeKind, durableEventScope.scopeId],
        set: {
          highWaterSequence: sql`${durableEventScope.highWaterSequence} + 1`,
          updatedAt: sql`clock_timestamp()`,
        },
      })
      .returning({
        highWaterSequence: durableEventScope.highWaterSequence,
      });

    if (!allocated) throw new Error("Durable event sequence could not be allocated");

    const [created] = await tx
      .insert(durableEvent)
      .values({
        scopeKind: event.scope.kind,
        scopeId: event.scope.id,
        sequence: allocated.highWaterSequence,
        eventType: event.eventType,
        eventVersion: event.eventVersion,
        payload: event.payload,
        causalId: causalId ?? null,
        occurredAt: sql`clock_timestamp()`,
        committedAt: sql`clock_timestamp()`,
        retentionExpiresAt: sql`clock_timestamp() + (${event.retentionSeconds} * interval '1 second')`,
      })
      .returning();

    if (!created) throw new Error("Durable event could not be appended");
    appended.push(created);
  }

  return appended;
};

export const appendDurableEvents = ({
  causalId,
  events,
}: {
  causalId?: string | null;
  events: DurableEventInput[];
}) =>
  db.transaction((tx) =>
    appendDurableEventsInTransaction({
      causalId,
      events,
      tx,
    }),
  );

export const getAuthorizedDurableEventScopeMetadata = async ({
  authenticatedUserId,
  scope,
}: {
  authenticatedUserId: string;
  scope: DurableEventScope;
}) =>
  db.transaction(async (tx) => {
    const authorization = await authorizeDurableEventScopeInTransaction({
      authenticatedUserId,
      scope,
      tx,
    });
    if (!authorization.ok) return authorization;

    return {
      ok: true as const,
      metadata: await ensureDurableEventScopeInTransaction(tx, scope),
    };
  });

export const validateDurableEventCheckpoint = async ({
  afterSequence,
  scope,
}: {
  afterSequence: bigint;
  scope: DurableEventScope;
}): Promise<
  | {
      ok: true;
      retentionFloor: bigint;
      highWater: bigint;
    }
  | {
      ok: false;
      error: DurableCheckpointError;
    }
> => {
  if (afterSequence < 0n) throw new TypeError("afterSequence cannot be negative");

  return db.transaction(async (tx) => {
    const metadata = await ensureDurableEventScopeInTransaction(tx, scope);
    const highWater = metadata.highWaterSequence;
    const retentionFloor = metadata.retentionFloorSequence;

    if (afterSequence < retentionFloor - 1n) {
      return {
        ok: false,
        error: {
          code: "durable_checkpoint_before_retention",
          message: "Durable event checkpoint is older than retained history",
          scope,
          retentionFloor,
          highWater,
        },
      };
    }

    if (afterSequence > highWater) {
      return {
        ok: false,
        error: {
          code: "durable_checkpoint_ahead",
          message: "Durable event checkpoint is ahead of the scope high-water mark",
          scope,
          retentionFloor,
          highWater,
        },
      };
    }

    return {
      ok: true,
      retentionFloor,
      highWater,
    };
  });
};

export const pruneExpiredDurableEvents = async ({ batchSize }: { batchSize: number }) => {
  assertPositiveInteger(batchSize, "batchSize");

  return db.transaction(async (tx) => {
    const [cleanupLock] = await tx.execute<{
      acquired: boolean;
    }>(
      sql`select pg_try_advisory_xact_lock(
        hashtextextended('euphoria.f3.durable_event_cleanup', 0)
      ) as acquired`,
    );
    if (!cleanupLock?.acquired) return [];

    const expired = await tx
      .select({ id: durableEvent.id })
      .from(durableEvent)
      .where(
        sql`${durableEvent.retentionExpiresAt} <= clock_timestamp()
          and not exists (
            select 1
            from durable_event retained_prefix
            where retained_prefix.scope_kind = ${durableEvent.scopeKind}
              and retained_prefix.scope_id = ${durableEvent.scopeId}
              and retained_prefix.sequence < ${durableEvent.sequence}
              and retained_prefix.retention_expires_at > clock_timestamp()
          )`,
      )
      .orderBy(durableEvent.scopeKind, durableEvent.scopeId, durableEvent.sequence)
      .for("update", { skipLocked: true })
      .limit(batchSize);

    if (!expired.length) return [];

    return tx
      .delete(durableEvent)
      .where(
        inArray(
          durableEvent.id,
          expired.map(({ id }) => id),
        ),
      )
      .returning({
        id: durableEvent.id,
        scopeKind: durableEvent.scopeKind,
        scopeId: durableEvent.scopeId,
        sequence: durableEvent.sequence,
      });
  });
};
