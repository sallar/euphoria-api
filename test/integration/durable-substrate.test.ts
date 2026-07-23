import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import {
  commandIdempotency,
  deliveryJob,
  deliveryJobAttempt,
  deliveryJobManualRequeue,
  durableEvent,
  durableEventScope,
} from "@/db/durable-schema";
import { notification } from "@/db/notification-schema";
import { db } from "@/lib/db";
import {
  cleanupCompletedIdempotencyRecords,
  listNonterminalIdempotencyDiagnostics,
  runIdempotentCommand,
} from "@/services/command-idempotency-service";
import {
  claimDeliveryJobs,
  completeDeliveryJob,
  enqueueDeliveryJob,
  enqueueDeliveryJobInTransaction,
  listDeliveryJobDeadLetters,
  manuallyRequeueDeliveryJob,
  retryDeliveryJob,
} from "@/services/delivery-job-service";
import {
  appendDurableEvents,
  appendDurableEventsInTransaction,
  authorizeDurableEventScope,
  createDurableEventCausalId,
  ensureDurableEventScopeInTransaction,
  pruneExpiredDurableEvents,
  validateDurableEventCheckpoint,
  type DurableEventScope,
} from "@/services/durable-event-service";
import { createProfileForUser } from "@/services/profile-membership-service";

import { createIntegrationHarness, type IntegrationHarness } from "./harness";

const integrationTest = process.env.RUN_INTEGRATION_TESTS === "1" ? test : test.skip;

const insertUser = async (harness: IntegrationHarness, prefix: string) => {
  const id = `${prefix}-${randomUUID()}`;
  const now = new Date();
  await harness.postgres`
    insert into public."user" (
      id, name, email, email_verified, created_at, updated_at
    )
    values (
      ${id},
      ${prefix},
      ${`${id}@example.test`},
      true,
      ${now},
      ${now}
    )
  `;
  return id;
};

const cleanupFixtures = async ({
  actorUserIds = [],
  harness,
  jobKinds = [],
  profileIds = [],
  scopes = [],
  userIds = [],
}: {
  actorUserIds?: string[];
  harness: IntegrationHarness;
  jobKinds?: string[];
  profileIds?: string[];
  scopes?: DurableEventScope[];
  userIds?: string[];
}) => {
  try {
    for (const scope of scopes) {
      await harness.postgres`
        delete from public.durable_event
        where scope_kind = ${scope.kind}
          and scope_id = ${scope.id}
      `;
    }
    for (const jobKind of jobKinds) {
      await harness.postgres`
        delete from public.delivery_job
        where job_kind = ${jobKind}
      `;
    }
    for (const actorUserId of actorUserIds) {
      await harness.postgres`
        delete from public.command_idempotency
        where actor_user_id = ${actorUserId}
      `;
    }
    for (const profileId of profileIds) {
      await harness.postgres`delete from public.profile where id = ${profileId}`;
    }
    for (const userId of userIds) {
      await harness.postgres`delete from public."user" where id = ${userId}`;
    }
  } finally {
    await harness.cleanup();
  }
};

const createProfile = async (userId: string, name: string) => {
  const result = await createProfileForUser({
    userId,
    profileInput: {
      profileType: "solo",
      name,
      bio: `${name} F3 authorization fixture`,
      gender: "man",
      genderTags: ["cis_man"],
      genderInterests: ["woman"],
      orientation: "heterosexual",
      orientationInterests: ["heterosexual"],
      relationshipTypes: ["dating"],
      location: {
        x: 24.94,
        y: 60.17,
      },
      country: "FI",
      dateOfBirth: "1990-01-01",
    },
  });
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
};

describe("F3 command idempotency against migrated PostgreSQL", () => {
  integrationTest(
    "serializes identical claims, stores one canonical outcome, and detects conflicts",
    async () => {
      const harness = await createIntegrationHarness("f3_idempotency");
      const actorUserId = await insertUser(harness, "f3-idempotency");
      const jobKind = `f3-idempotency-${randomUUID()}`;
      const scope = {
        kind: "notification-user" as const,
        id: actorUserId,
      };
      let executionCount = 0;

      const execute = () =>
        runIdempotentCommand({
          actorUserId,
          commandName: "fixture.atomic-command",
          commandVersion: 1,
          idempotencyKey: "same-key",
          normalizedRequest: {
            nested: {
              second: 2,
              first: 1,
            },
          },
          retentionSeconds: 3_600,
          execute: async (tx) => {
            executionCount += 1;
            const [createdNotification] = await tx
              .insert(notification)
              .values({
                recipientUserId: actorUserId,
                type: "system",
                title: "F3 command",
                body: "Canonical command effect",
              })
              .returning({ id: notification.id });

            if (!createdNotification) throw new Error("Notification fixture was not created");

            await appendDurableEventsInTransaction({
              tx,
              events: [
                {
                  scope,
                  eventType: "fixture.command.completed",
                  eventVersion: 1,
                  payload: {
                    notificationId: createdNotification.id,
                  },
                  retentionSeconds: 3_600,
                },
              ],
            });
            await enqueueDeliveryJobInTransaction({
              tx,
              jobKind,
              jobVersion: 1,
              payload: {
                notificationId: createdNotification.id,
              },
              availableInSeconds: 0,
              maxAttempts: 3,
              terminalRetentionSeconds: 3_600,
            });
            await Bun.sleep(75);

            return {
              outcome: "succeeded" as const,
              result: {
                notificationId: createdNotification.id,
              },
            };
          },
        });

      try {
        const results = await Promise.all([execute(), execute()]);
        expect(executionCount).toBe(1);
        expect(results.every((result) => result.ok)).toBe(true);
        if (!results[0]?.ok || !results[1]?.ok)
          throw new Error("Expected both idempotent claims to resolve");
        expect(results[0].recordId).toBe(results[1].recordId);
        expect(results[0].outcome).toEqual(results[1].outcome);
        expect(
          results
            .map((result) => {
              if (!result.ok) throw new Error("Expected a successful idempotency result");
              return result.replayed;
            })
            .sort(),
        ).toEqual([false, true]);

        const [effects] = await db
          .select({
            notifications: sql<number>`count(distinct ${notification.id})::integer`,
            events: sql<number>`count(distinct ${durableEvent.id})::integer`,
            jobs: sql<number>`count(distinct ${deliveryJob.id})::integer`,
          })
          .from(notification)
          .leftJoin(
            durableEvent,
            and(eq(durableEvent.scopeKind, scope.kind), eq(durableEvent.scopeId, scope.id)),
          )
          .leftJoin(deliveryJob, eq(deliveryJob.jobKind, jobKind))
          .where(eq(notification.recipientUserId, actorUserId));
        expect(effects).toEqual({
          notifications: 1,
          events: 1,
          jobs: 1,
        });

        let conflictingExecutionRan = false;
        const conflict = await runIdempotentCommand({
          actorUserId,
          commandName: "fixture.atomic-command",
          commandVersion: 1,
          idempotencyKey: "same-key",
          normalizedRequest: {
            nested: {
              first: 999,
              second: 2,
            },
          },
          retentionSeconds: 3_600,
          execute: async () => {
            conflictingExecutionRan = true;
            return {
              outcome: "succeeded",
              result: null,
            };
          },
        });
        expect(conflictingExecutionRan).toBe(false);
        expect(conflict).toEqual({
          ok: false,
          error: {
            code: "idempotency_conflict",
            message: "Idempotency key was already used for a different command request",
            retryable: false,
          },
        });
      } finally {
        await cleanupFixtures({
          actorUserIds: [actorUserId],
          harness,
          jobKinds: [jobKind],
          scopes: [scope],
          userIds: [actorUserId],
        });
      }
    },
    30_000,
  );

  integrationTest(
    "keeps expired completed records authoritative until explicit cleanup",
    async () => {
      const harness = await createIntegrationHarness("f3_idempotency_expiry");
      const actorUserId = `f3-idempotency-expiry-${randomUUID()}`;
      let executionCount = 0;
      const input = {
        actorUserId,
        commandName: "fixture.expiry",
        commandVersion: 1,
        idempotencyKey: "expiry-key",
        normalizedRequest: {
          value: "stable",
        },
        retentionSeconds: 3_600,
        execute: async () => {
          executionCount += 1;
          return {
            outcome: "succeeded" as const,
            result: {
              executionCount,
            },
          };
        },
      };

      try {
        const first = await runIdempotentCommand(input);
        expect(first.ok && first.replayed).toBe(false);

        await harness.postgres`
          update public.command_idempotency
          set
            completed_at = clock_timestamp() - interval '2 seconds',
            retention_expires_at = clock_timestamp() - interval '1 second',
            updated_at = clock_timestamp()
          where actor_user_id = ${actorUserId}
            and command_name = ${input.commandName}
            and idempotency_key = ${input.idempotencyKey}
        `;

        const expiredButPresent = await runIdempotentCommand(input);
        expect(executionCount).toBe(1);
        expect(expiredButPresent.ok && expiredButPresent.replayed).toBe(true);
        if (!first.ok || !expiredButPresent.ok)
          throw new Error("Expected stored idempotent outcomes");
        expect(expiredButPresent.outcome).toEqual(first.outcome);

        const removed = await cleanupCompletedIdempotencyRecords({ batchSize: 100 });
        expect(removed.map(({ id }) => id)).toContain(first.recordId);

        const afterCleanup = await runIdempotentCommand(input);
        expect(afterCleanup.ok && afterCleanup.replayed).toBe(false);
        expect(executionCount).toBe(2);

        const [stuck] = await db
          .insert(commandIdempotency)
          .values({
            actorUserId,
            commandName: "fixture.stuck-command",
            commandVersion: 1,
            idempotencyKey: "stuck-key",
            requestFingerprint: "0".repeat(64),
            createdAt: sql`clock_timestamp() - interval '2 seconds'`,
            updatedAt: sql`clock_timestamp() - interval '2 seconds'`,
          })
          .returning({ id: commandIdempotency.id });
        if (!stuck) throw new Error("Expected nonterminal diagnostic fixture");

        const diagnostics = await listNonterminalIdempotencyDiagnostics({
          olderThanSeconds: 1,
          limit: 100,
        });
        expect(diagnostics).toContainEqual(
          expect.objectContaining({
            id: stuck.id,
            actorUserId,
            commandName: "fixture.stuck-command",
            commandVersion: 1,
          }),
        );
        await cleanupCompletedIdempotencyRecords({ batchSize: 100 });
        expect(
          await db
            .select({ id: commandIdempotency.id })
            .from(commandIdempotency)
            .where(eq(commandIdempotency.id, stuck.id)),
        ).toEqual([{ id: stuck.id }]);
      } finally {
        await cleanupFixtures({
          actorUserIds: [actorUserId],
          harness,
        });
      }
    },
    30_000,
  );

  integrationTest(
    "rolls back the domain change, claim, events, scope metadata, and job together",
    async () => {
      const harness = await createIntegrationHarness("f3_atomic_rollback");
      const actorUserId = await insertUser(harness, "f3-rollback");
      const jobKind = `f3-rollback-${randomUUID()}`;
      const scope = {
        kind: "notification-user" as const,
        id: actorUserId,
      };

      try {
        await expect(
          runIdempotentCommand({
            actorUserId,
            commandName: "fixture.rollback",
            commandVersion: 1,
            idempotencyKey: "rollback-key",
            normalizedRequest: {
              fail: true,
            },
            retentionSeconds: 3_600,
            execute: async (tx) => {
              await tx.insert(notification).values({
                recipientUserId: actorUserId,
                type: "system",
                title: "Must roll back",
                body: "Must roll back",
              });
              await appendDurableEventsInTransaction({
                tx,
                events: [
                  {
                    scope,
                    eventType: "fixture.must-rollback",
                    eventVersion: 1,
                    payload: {
                      private: false,
                    },
                    retentionSeconds: 3_600,
                  },
                ],
              });
              await enqueueDeliveryJobInTransaction({
                tx,
                jobKind,
                jobVersion: 1,
                payload: {
                  reference: "must-roll-back",
                },
                availableInSeconds: 0,
                maxAttempts: 3,
                terminalRetentionSeconds: 3_600,
              });
              throw new Error("injected command failure");
            },
          }),
        ).rejects.toThrow("injected command failure");

        expect(
          await db
            .select({ id: notification.id })
            .from(notification)
            .where(eq(notification.recipientUserId, actorUserId)),
        ).toEqual([]);
        expect(
          await db
            .select({ id: commandIdempotency.id })
            .from(commandIdempotency)
            .where(eq(commandIdempotency.actorUserId, actorUserId)),
        ).toEqual([]);
        expect(
          await db
            .select({ id: durableEvent.id })
            .from(durableEvent)
            .where(and(eq(durableEvent.scopeKind, scope.kind), eq(durableEvent.scopeId, scope.id))),
        ).toEqual([]);
        expect(
          await db
            .select({ scopeId: durableEventScope.scopeId })
            .from(durableEventScope)
            .where(
              and(
                eq(durableEventScope.scopeKind, scope.kind),
                eq(durableEventScope.scopeId, scope.id),
              ),
            ),
        ).toEqual([]);
        expect(
          await db
            .select({ id: deliveryJob.id })
            .from(deliveryJob)
            .where(eq(deliveryJob.jobKind, jobKind)),
        ).toEqual([]);
      } finally {
        await cleanupFixtures({
          actorUserIds: [actorUserId],
          harness,
          jobKinds: [jobKind],
          scopes: [scope],
          userIds: [actorUserId],
        });
      }
    },
    30_000,
  );
});

describe("F3 durable scoped events against migrated PostgreSQL", () => {
  integrationTest(
    "authorizes only the notification user or an active F2 profile participant",
    async () => {
      const harness = await createIntegrationHarness("f3_event_authorization");
      const firstUserId = await insertUser(harness, "f3-event-auth-one");
      const secondUserId = await insertUser(harness, "f3-event-auth-two");
      const firstProfile = await createProfile(firstUserId, "F3 Auth One");
      const secondProfile = await createProfile(secondUserId, "F3 Auth Two");
      const [profileOneId, profileTwoId] = [firstProfile.id, secondProfile.id].sort();
      const conversationId = randomUUID();

      try {
        await harness.postgres`
          insert into public.chat_conversation (
            id, profile_one_id, profile_two_id
          )
          values (
            ${conversationId},
            ${profileOneId},
            ${profileTwoId}
          )
        `;

        expect(
          await authorizeDurableEventScope({
            authenticatedUserId: firstUserId,
            scope: {
              kind: "notification-user",
              id: firstUserId,
            },
          }),
        ).toEqual({ ok: true });
        expect(
          await authorizeDurableEventScope({
            authenticatedUserId: secondUserId,
            scope: {
              kind: "notification-user",
              id: firstUserId,
            },
          }),
        ).toEqual({
          ok: false,
          error: {
            code: "durable_scope_forbidden",
            message: "Authenticated user cannot access this durable event scope",
          },
        });
        expect(
          await authorizeDurableEventScope({
            authenticatedUserId: firstUserId,
            scope: {
              kind: "chat-profile",
              id: firstProfile.id,
            },
          }),
        ).toEqual({ ok: true });
        expect(
          await authorizeDurableEventScope({
            authenticatedUserId: secondUserId,
            scope: {
              kind: "chat-profile",
              id: firstProfile.id,
            },
          }),
        ).toEqual({
          ok: false,
          error: {
            code: "durable_scope_forbidden",
            message: "Authenticated user cannot access this durable event scope",
          },
        });
        expect(
          await authorizeDurableEventScope({
            authenticatedUserId: firstUserId,
            scope: {
              kind: "chat-conversation",
              id: conversationId,
            },
          }),
        ).toEqual({ ok: true });
        expect(
          await authorizeDurableEventScope({
            authenticatedUserId: secondUserId,
            scope: {
              kind: "chat-conversation",
              id: conversationId,
            },
          }),
        ).toEqual({ ok: true });

        await harness.postgres`
          update public.profile
          set deleted_at = clock_timestamp()
          where id = ${firstProfile.id}
        `;
        expect(
          await authorizeDurableEventScope({
            authenticatedUserId: firstUserId,
            scope: {
              kind: "chat-profile",
              id: firstProfile.id,
            },
          }),
        ).toEqual({
          ok: false,
          error: {
            code: "durable_scope_forbidden",
            message: "Authenticated user cannot access this durable event scope",
          },
        });
      } finally {
        await cleanupFixtures({
          harness,
          profileIds: [firstProfile.id, secondProfile.id],
          userIds: [firstUserId, secondUserId],
        });
      }
    },
    30_000,
  );

  integrationTest(
    "allocates concurrent per-scope sequences and independent cross-scope sequences",
    async () => {
      const harness = await createIntegrationHarness("f3_event_sequence");
      const sharedScope = {
        kind: "chat-profile" as const,
        id: randomUUID(),
      };
      const separateScopeOne = {
        kind: "notification-user" as const,
        id: `f3-event-one-${randomUUID()}`,
      };
      const separateScopeTwo = {
        kind: "notification-user" as const,
        id: `f3-event-two-${randomUUID()}`,
      };
      const scopes = [sharedScope, separateScopeOne, separateScopeTwo];

      try {
        const concurrent = await Promise.all(
          Array.from({ length: 20 }, (_, index) =>
            appendDurableEvents({
              events: [
                {
                  scope: sharedScope,
                  eventType: "fixture.concurrent",
                  eventVersion: 1,
                  payload: {
                    writer: index,
                  },
                  retentionSeconds: 3_600,
                },
              ],
            }),
          ),
        );
        const sequences = concurrent
          .flat()
          .map(({ sequence }) => sequence)
          .sort((left, right) => Number(left - right));
        expect(sequences).toEqual(Array.from({ length: 20 }, (_, index) => BigInt(index + 1)));

        const [scopeOneEvents, scopeTwoEvents] = await Promise.all([
          appendDurableEvents({
            events: [
              {
                scope: separateScopeOne,
                eventType: "fixture.scope-one",
                eventVersion: 1,
                payload: {},
                retentionSeconds: 3_600,
              },
            ],
          }),
          appendDurableEvents({
            events: [
              {
                scope: separateScopeTwo,
                eventType: "fixture.scope-two",
                eventVersion: 1,
                payload: {},
                retentionSeconds: 3_600,
              },
            ],
          }),
        ]);
        expect(scopeOneEvents[0]?.sequence).toBe(1n);
        expect(scopeTwoEvents[0]?.sequence).toBe(1n);
      } finally {
        await cleanupFixtures({
          harness,
          scopes,
        });
      }
    },
    30_000,
  );

  integrationTest(
    "shares causal IDs across scopes and maintains floor/high-water boundaries",
    async () => {
      const harness = await createIntegrationHarness("f3_event_retention");
      const newScope = {
        kind: "notification-user" as const,
        id: `f3-new-scope-${randomUUID()}`,
      };
      const retentionScope = {
        kind: "notification-user" as const,
        id: `f3-retention-${randomUUID()}`,
      };
      const otherScope = {
        kind: "chat-conversation" as const,
        id: randomUUID(),
      };
      const emptyAfterPruneScope = {
        kind: "notification-user" as const,
        id: `f3-empty-after-prune-${randomUUID()}`,
      };
      const scopes = [newScope, retentionScope, otherScope, emptyAfterPruneScope];

      try {
        await db.transaction((tx) => ensureDurableEventScopeInTransaction(tx, newScope));
        expect(
          await validateDurableEventCheckpoint({ scope: newScope, afterSequence: 0n }),
        ).toEqual({
          ok: true,
          retentionFloor: 1n,
          highWater: 0n,
        });

        const causalId = createDurableEventCausalId();
        const causalEvents = await db.transaction((tx) =>
          appendDurableEventsInTransaction({
            tx,
            causalId,
            events: [
              {
                scope: retentionScope,
                eventType: "fixture.multi-scope",
                eventVersion: 1,
                payload: {
                  side: "one",
                },
                retentionSeconds: 1,
              },
              {
                scope: otherScope,
                eventType: "fixture.multi-scope",
                eventVersion: 1,
                payload: {
                  side: "two",
                },
                retentionSeconds: 3_600,
              },
            ],
          }),
        );
        expect(causalEvents).toHaveLength(2);
        expect(causalEvents.every((event) => event.causalId === causalId)).toBe(true);

        await appendDurableEvents({
          events: [
            {
              scope: emptyAfterPruneScope,
              eventType: "fixture.only-event",
              eventVersion: 1,
              payload: {},
              retentionSeconds: 1,
            },
          ],
        });

        for (let sequence = 2; sequence <= 5; sequence += 1) {
          const [event] = await appendDurableEvents({
            events: [
              {
                scope: retentionScope,
                eventType: "fixture.retained-boundary",
                eventVersion: 1,
                payload: {
                  sequence,
                },
                retentionSeconds: 1,
              },
            ],
          });
          expect(event?.sequence).toBe(BigInt(sequence));
        }

        try {
          await harness.postgres`
            delete from public.durable_event
            where scope_kind = ${retentionScope.kind}
              and scope_id = ${retentionScope.id}
              and sequence = 3
          `;
          throw new Error("Expected non-prefix event deletion to be rejected");
        } catch (error) {
          expect(error).toMatchObject({
            constraint: "durable_event_retained_range_contiguous_check",
          });
        }

        await Bun.sleep(1_250);
        const [sixth] = await appendDurableEvents({
          events: [
            {
              scope: retentionScope,
              eventType: "fixture.retained-boundary",
              eventVersion: 1,
              payload: {
                sequence: 6,
              },
              retentionSeconds: 3_600,
            },
          ],
        });
        expect(sixth?.sequence).toBe(6n);

        const pruned = await pruneExpiredDurableEvents({ batchSize: 100 });
        expect(
          pruned
            .filter(({ scopeId }) => scopeId === retentionScope.id)
            .map(({ sequence }) => sequence)
            .sort((left, right) => Number(left - right)),
        ).toEqual([1n, 2n, 3n, 4n, 5n]);
        expect(
          pruned
            .filter(({ scopeId }) => scopeId === emptyAfterPruneScope.id)
            .map(({ sequence }) => sequence),
        ).toEqual([1n]);

        const [metadata] = await db
          .select()
          .from(durableEventScope)
          .where(
            and(
              eq(durableEventScope.scopeKind, retentionScope.kind),
              eq(durableEventScope.scopeId, retentionScope.id),
            ),
          );
        expect(metadata).toMatchObject({
          highWaterSequence: 6n,
          retentionFloorSequence: 6n,
        });
        expect(
          await validateDurableEventCheckpoint({
            scope: emptyAfterPruneScope,
            afterSequence: 1n,
          }),
        ).toEqual({
          ok: true,
          retentionFloor: 2n,
          highWater: 1n,
        });
        expect(
          await validateDurableEventCheckpoint({
            scope: emptyAfterPruneScope,
            afterSequence: 0n,
          }),
        ).toEqual({
          ok: false,
          error: {
            code: "durable_checkpoint_before_retention",
            message: "Durable event checkpoint is older than retained history",
            scope: emptyAfterPruneScope,
            retentionFloor: 2n,
            highWater: 1n,
          },
        });
        expect(
          await validateDurableEventCheckpoint({
            scope: retentionScope,
            afterSequence: 5n,
          }),
        ).toEqual({
          ok: true,
          retentionFloor: 6n,
          highWater: 6n,
        });
        expect(
          await validateDurableEventCheckpoint({
            scope: retentionScope,
            afterSequence: 4n,
          }),
        ).toEqual({
          ok: false,
          error: {
            code: "durable_checkpoint_before_retention",
            message: "Durable event checkpoint is older than retained history",
            scope: retentionScope,
            retentionFloor: 6n,
            highWater: 6n,
          },
        });
        expect(
          await validateDurableEventCheckpoint({
            scope: retentionScope,
            afterSequence: 7n,
          }),
        ).toEqual({
          ok: false,
          error: {
            code: "durable_checkpoint_ahead",
            message: "Durable event checkpoint is ahead of the scope high-water mark",
            scope: retentionScope,
            retentionFloor: 6n,
            highWater: 6n,
          },
        });
      } finally {
        await cleanupFixtures({
          harness,
          scopes,
        });
      }
    },
    30_000,
  );
});

describe("F3 leased delivery jobs against migrated PostgreSQL", () => {
  integrationTest(
    "prevents concurrent ownership, fences stale workers, reclaims leases, and completes idempotently",
    async () => {
      const harness = await createIntegrationHarness("f3_job_claim");
      const jobKind = `f3-job-claim-${randomUUID()}`;

      try {
        const singleOwnerJob = await enqueueDeliveryJob({
          jobKind,
          jobVersion: 1,
          payload: {
            reference: "single-owner",
          },
          availableInSeconds: 0,
          maxAttempts: 3,
          terminalRetentionSeconds: 3_600,
        });
        const concurrentClaims = await Promise.all([
          claimDeliveryJobs({
            jobKind,
            jobVersion: 1,
            leaseOwner: "worker-one",
            leaseDurationSeconds: 60,
            limit: 1,
          }),
          claimDeliveryJobs({
            jobKind,
            jobVersion: 1,
            leaseOwner: "worker-two",
            leaseDurationSeconds: 60,
            limit: 1,
          }),
        ]);
        const owned = concurrentClaims.flatMap(({ jobs }) => jobs);
        expect(owned).toHaveLength(1);
        expect(owned[0]?.id).toBe(singleOwnerJob.id);
        expect(new Set(owned.map(({ leaseOwner }) => leaseOwner)).size).toBe(1);

        const nonExpiredSteal = await claimDeliveryJobs({
          jobKind,
          jobVersion: 1,
          leaseOwner: "worker-three",
          leaseDurationSeconds: 60,
          limit: 1,
        });
        expect(nonExpiredSteal.jobs).toEqual([]);

        const reclaimableJob = await enqueueDeliveryJob({
          jobKind,
          jobVersion: 1,
          payload: {
            reference: "reclaimable",
          },
          availableInSeconds: 0,
          maxAttempts: 3,
          terminalRetentionSeconds: 3_600,
        });
        const firstClaim = await claimDeliveryJobs({
          jobKind,
          jobVersion: 1,
          leaseOwner: "crashed-worker",
          leaseDurationSeconds: 1,
          limit: 1,
        });
        const firstLease = firstClaim.jobs[0];
        expect(firstLease?.id).toBe(reclaimableJob.id);
        if (!firstLease?.leaseToken) throw new Error("Expected first fencing token");

        await Bun.sleep(1_250);
        const reclaimed = await claimDeliveryJobs({
          jobKind,
          jobVersion: 1,
          leaseOwner: "recovery-worker",
          leaseDurationSeconds: 60,
          limit: 1,
        });
        const secondLease = reclaimed.jobs[0];
        expect(secondLease?.id).toBe(reclaimableJob.id);
        expect(secondLease?.attemptCount).toBe(2);
        expect(secondLease?.leaseToken).not.toBe(firstLease.leaseToken);
        if (!secondLease?.leaseToken) throw new Error("Expected reclaimed fencing token");

        expect(
          await completeDeliveryJob({
            jobId: reclaimableJob.id,
            leaseOwner: "crashed-worker",
            leaseToken: firstLease.leaseToken,
          }),
        ).toEqual({
          ok: false,
          error: {
            code: "delivery_job_lease_lost",
            message: "Delivery job lease is no longer owned by this worker and fencing token",
            retryable: false,
          },
        });

        expect(
          await completeDeliveryJob({
            jobId: reclaimableJob.id,
            leaseOwner: "recovery-worker",
            leaseToken: secondLease.leaseToken,
          }),
        ).toEqual({
          ok: true,
          status: "completed",
        });
        expect(
          await completeDeliveryJob({
            jobId: reclaimableJob.id,
            leaseOwner: "recovery-worker",
            leaseToken: secondLease.leaseToken,
          }),
        ).toEqual({
          ok: true,
          status: "already_completed",
        });

        const attempts = await db
          .select({
            attemptNumber: deliveryJobAttempt.attemptNumber,
            outcome: deliveryJobAttempt.outcome,
          })
          .from(deliveryJobAttempt)
          .where(eq(deliveryJobAttempt.jobId, reclaimableJob.id))
          .orderBy(deliveryJobAttempt.attemptNumber);
        expect(attempts).toEqual([
          {
            attemptNumber: 1,
            outcome: "lease_expired",
          },
          {
            attemptNumber: 2,
            outcome: "completed",
          },
        ]);
      } finally {
        await cleanupFixtures({
          harness,
          jobKinds: [jobKind],
        });
      }
    },
    30_000,
  );

  integrationTest(
    "respects retry availability, sanitizes failures, and exposes terminal dead letters",
    async () => {
      const harness = await createIntegrationHarness("f3_job_retry");
      const jobKind = `f3-job-retry-${randomUUID()}`;

      try {
        const retryJob = await enqueueDeliveryJob({
          jobKind,
          jobVersion: 1,
          payload: {
            reference: "retry",
          },
          availableInSeconds: 0,
          maxAttempts: 2,
          terminalRetentionSeconds: 3_600,
        });
        const [firstLease] = (
          await claimDeliveryJobs({
            jobKind,
            jobVersion: 1,
            leaseOwner: "retry-worker",
            leaseDurationSeconds: 60,
            limit: 1,
          })
        ).jobs;
        if (!firstLease?.leaseToken) throw new Error("Expected retry fencing token");

        const nextAvailableAt = new Date(Date.now() + 750);
        const failureWithSecrets = {
          code: "provider.timeout",
          authorization: "Bearer do-not-store",
          body: {
            password: "private-body",
          },
        };
        expect(
          await retryDeliveryJob({
            jobId: retryJob.id,
            leaseOwner: "retry-worker",
            leaseToken: firstLease.leaseToken,
            availableAt: nextAvailableAt,
            failure: failureWithSecrets,
          }),
        ).toEqual({
          ok: true,
          status: "retry_scheduled",
        });
        expect(
          await retryDeliveryJob({
            jobId: retryJob.id,
            leaseOwner: "retry-worker",
            leaseToken: firstLease.leaseToken,
            availableAt: nextAvailableAt,
            failure: failureWithSecrets,
          }),
        ).toEqual({
          ok: true,
          status: "already_retried",
        });

        expect(
          (
            await claimDeliveryJobs({
              jobKind,
              jobVersion: 1,
              leaseOwner: "too-early-worker",
              leaseDurationSeconds: 60,
              limit: 1,
            })
          ).jobs,
        ).toEqual([]);

        await Bun.sleep(900);
        const [finalLease] = (
          await claimDeliveryJobs({
            jobKind,
            jobVersion: 1,
            leaseOwner: "final-worker",
            leaseDurationSeconds: 60,
            limit: 1,
          })
        ).jobs;
        expect(finalLease?.attemptCount).toBe(2);
        if (!finalLease?.leaseToken) throw new Error("Expected final fencing token");

        const exhausted = await retryDeliveryJob({
          jobId: retryJob.id,
          leaseOwner: "final-worker",
          leaseToken: finalLease.leaseToken,
          availableAt: new Date(Date.now() + 1_000),
          failure: {
            code: "provider.unavailable",
            requestBody: "do-not-store-private-request",
          },
        });
        expect(exhausted).toEqual({
          ok: true,
          status: "dead_lettered",
        });
        expect(
          await retryDeliveryJob({
            jobId: retryJob.id,
            leaseOwner: "final-worker",
            leaseToken: finalLease.leaseToken,
            availableAt: new Date(Date.now() + 1_000),
            failure: {
              code: "provider.unavailable",
            },
          }),
        ).toEqual({
          ok: true,
          status: "already_dead_lettered",
        });

        const deadLetters = await listDeliveryJobDeadLetters({
          jobKind,
          jobVersion: 1,
          limit: 10,
        });
        expect(deadLetters).toEqual([
          expect.objectContaining({
            id: retryJob.id,
            state: "dead_letter",
            attemptCount: 2,
            maxAttempts: 2,
            deadLetterReason: "attempts_exhausted",
            deadLetterOutcome: "failed",
            lastFailureCode: "provider.unavailable",
          }),
        ]);

        const [storedFailureMetadata] = await harness.postgres<
          {
            serialized: string;
          }[]
        >`
          select jsonb_build_object(
            'job_failure', job.last_failure_code,
            'attempt_failures', coalesce(
              jsonb_agg(attempt.failure_code order by attempt.attempt_number),
              '[]'::jsonb
            )
          )::text as serialized
          from public.delivery_job job
          left join public.delivery_job_attempt attempt on attempt.job_id = job.id
          where job.id = ${retryJob.id}
          group by job.id
        `;
        expect(storedFailureMetadata?.serialized).not.toContain("do-not-store");
        expect(storedFailureMetadata?.serialized).not.toContain("private");
      } finally {
        await cleanupFixtures({
          harness,
          jobKinds: [jobKind],
        });
      }
    },
    30_000,
  );

  integrationTest(
    "dead-letters a crashed final attempt as unknown and audits manual requeue",
    async () => {
      const harness = await createIntegrationHarness("f3_job_final_lease");
      const jobKind = `f3-job-final-${randomUUID()}`;

      try {
        const job = await enqueueDeliveryJob({
          jobKind,
          jobVersion: 1,
          payload: {
            reference: "unknown-outcome",
          },
          availableInSeconds: 0,
          maxAttempts: 1,
          terminalRetentionSeconds: 3_600,
        });
        const [finalLease] = (
          await claimDeliveryJobs({
            jobKind,
            jobVersion: 1,
            leaseOwner: "crashed-final-worker",
            leaseDurationSeconds: 1,
            limit: 1,
          })
        ).jobs;
        expect(finalLease?.attemptCount).toBe(1);
        if (!finalLease?.leaseToken) throw new Error("Expected final-attempt fencing token");

        await Bun.sleep(1_250);
        expect(
          await completeDeliveryJob({
            jobId: job.id,
            leaseOwner: "crashed-final-worker",
            leaseToken: finalLease.leaseToken,
          }),
        ).toEqual({
          ok: false,
          error: {
            code: "delivery_job_lease_lost",
            message: "Delivery job lease is no longer owned by this worker and fencing token",
            retryable: false,
          },
        });
        const afterCrash = await claimDeliveryJobs({
          jobKind,
          jobVersion: 1,
          leaseOwner: "recovery-scanner",
          leaseDurationSeconds: 60,
          limit: 1,
        });
        expect(afterCrash.jobs).toEqual([]);
        expect(afterCrash.deadLetteredExpiredJobIds).toEqual([job.id]);

        const [deadLetter] = await db.select().from(deliveryJob).where(eq(deliveryJob.id, job.id));
        expect(deadLetter).toMatchObject({
          state: "dead_letter",
          attemptCount: 1,
          maxAttempts: 1,
          deadLetterReason: "lease_expired_after_final_claim",
          deadLetterOutcome: "unknown",
          lastFailureCode: "lease_expired_after_final_claim",
        });

        const requeued = await manuallyRequeueDeliveryJob({
          jobId: job.id,
          requestedBy: "operator-fixture",
          reasonCode: "operator.reviewed_unknown_outcome",
          availableInSeconds: 0,
          maxAttempts: 2,
        });
        expect(requeued.ok).toBe(true);
        if (!requeued.ok) throw new Error("Expected audited manual requeue");
        expect(requeued.job).toMatchObject({
          state: "pending",
          attemptCount: 1,
          maxAttempts: 2,
          manualRequeueCount: 1,
          deadLetterReason: null,
          deadLetterOutcome: null,
        });

        const audits = await db
          .select()
          .from(deliveryJobManualRequeue)
          .where(eq(deliveryJobManualRequeue.jobId, job.id));
        expect(audits).toEqual([
          expect.objectContaining({
            requestedBy: "operator-fixture",
            reasonCode: "operator.reviewed_unknown_outcome",
            previousDeadLetterReason: "lease_expired_after_final_claim",
            previousDeadLetterOutcome: "unknown",
            previousAttemptCount: 1,
            nextMaxAttempts: 2,
          }),
        ]);

        const [requeuedLease] = (
          await claimDeliveryJobs({
            jobKind,
            jobVersion: 1,
            leaseOwner: "manual-requeue-worker",
            leaseDurationSeconds: 60,
            limit: 1,
          })
        ).jobs;
        expect(requeuedLease).toMatchObject({
          id: job.id,
          attemptCount: 2,
          maxAttempts: 2,
        });
      } finally {
        await cleanupFixtures({
          harness,
          jobKinds: [jobKind],
        });
      }
    },
    30_000,
  );
});
