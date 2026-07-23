import { describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { application } from "@/app";
import {
  CHAT_MESSAGE_SEND_COMMAND_NAME,
  NOTIFICATION_PUSH_DELIVERY_JOB_KIND,
  type TransactionalChatPolicy,
} from "@/config/transactional-chat-policy";
import { betterAuth } from "@/lib/auth";
import {
  getChatConversation,
  getChatUnreadCount,
  listChatMessages,
  markChatConversationRead,
  sendTextMessage,
  setMessageReaction,
  setProfileReactionAndSyncConversation,
  type ChatTransactionFailurePoint,
} from "@/services/chat-service";
import { chatSockets } from "@/services/chat-sockets";
import {
  createCommandRequestFingerprint,
  runIdempotentCommand,
} from "@/services/command-idempotency-service";
import { createProfileForUser } from "@/services/profile-membership-service";

import { createIntegrationHarness, type IntegrationHarness } from "./harness";

const integrationTest = process.env.RUN_INTEGRATION_TESTS === "1" ? test : test.skip;
const policy = {
  commandRetentionSeconds: 2_592_000,
  eventRetentionSeconds: 2_592_000,
  pushJobAvailableInSeconds: 0,
  pushJobMaxAttempts: 8,
  pushJobTerminalRetentionSeconds: 2_592_000,
} as const satisfies TransactionalChatPolicy;

const profileInput = (name: string) => ({
  profileType: "solo" as const,
  name,
  bio: `${name} transactional chat integration fixture`,
  gender: "man" as const,
  genderTags: ["cis_man" as const],
  genderInterests: ["woman" as const],
  orientation: "heterosexual" as const,
  orientationInterests: ["heterosexual" as const],
  relationshipTypes: ["dating" as const],
  location: { x: 24.94, y: 60.17 },
  country: "FI",
  dateOfBirth: "1990-01-01",
});

type TransactionalChatFixture = {
  conversationId: string;
  harness: IntegrationHarness;
  profileIds: Set<string>;
  profileOneId: string;
  profileTwoId: string;
  userIds: Set<string>;
  userOneId: string;
  userTwoId: string;
};

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

const createProfile = async (userId: string, name: string) => {
  const result = await createProfileForUser({
    profileInput: profileInput(name),
    userId,
  });
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
};

const createMatchedFixture = async (suite: string): Promise<TransactionalChatFixture> => {
  const harness = await createIntegrationHarness(suite);
  const userOneId = await insertUser(harness, `${suite}-one`);
  const userTwoId = await insertUser(harness, `${suite}-two`);
  const first = await createProfile(userOneId, `${suite} One`);
  const second = await createProfile(userTwoId, `${suite} Two`);
  const [profileOneId, profileTwoId] = [first.id, second.id].sort();
  const [conversation] = await harness.postgres`
    insert into public.chat_conversation (profile_one_id, profile_two_id)
    values (${profileOneId}, ${profileTwoId})
    returning id
  `;

  await harness.postgres`
    insert into public.profile_reaction (profile_id, target_profile_id, reaction)
    values
      (${first.id}, ${second.id}, 'like'),
      (${second.id}, ${first.id}, 'like')
  `;

  return {
    conversationId: conversation!.id,
    harness,
    profileIds: new Set([first.id, second.id]),
    profileOneId: first.id,
    profileTwoId: second.id,
    userIds: new Set([userOneId, userTwoId]),
    userOneId,
    userTwoId,
  };
};

const cleanupFixture = async (fixture: TransactionalChatFixture) => {
  try {
    await fixture.harness.postgres`
      delete from public.delivery_job
      where job_kind = ${NOTIFICATION_PUSH_DELIVERY_JOB_KIND}
    `;
    for (const userId of fixture.userIds) {
      await fixture.harness.postgres`
        delete from public.command_idempotency
        where actor_user_id = ${userId}
      `;
    }
    for (const scopeId of [fixture.conversationId, ...fixture.profileIds, ...fixture.userIds]) {
      await fixture.harness.postgres`
        delete from public.durable_event where scope_id = ${scopeId}
      `;
    }
    for (const profileId of fixture.profileIds) {
      await fixture.harness.postgres`delete from public.profile where id = ${profileId}`;
    }
    for (const userId of fixture.userIds) {
      await fixture.harness.postgres`delete from public."user" where id = ${userId}`;
    }
  } finally {
    await fixture.harness.cleanup();
  }
};

const createSessionToken = async (userId: string) => {
  const authContext = await betterAuth.$context;
  return (await authContext.internalAdapter.createSession(userId)).token;
};

const sendRestMessage = ({
  conversationId,
  idempotencyKey,
  profileId,
  text,
  token,
}: {
  conversationId: string;
  idempotencyKey?: string;
  profileId: string;
  text: string;
  token: string;
}) =>
  application.handle(
    new Request(
      `http://localhost/api/chat/profiles/${profileId}/conversations/${conversationId}/messages`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
        },
        body: JSON.stringify({ text }),
      },
    ),
  );

type SocketEvent = Record<string, any>;
type DeliveryRow = {
  channel: string;
  id: string;
  pushTokenId: string | null;
  status: string;
};
type DurableEventRow = {
  causalId: string;
  eventType: string;
  eventVersion: number;
  payload: Record<string, any>;
  retentionSeconds: number;
  scopeId: string;
  scopeKind: string;
  sequence: number;
};

const countGraphemes = (value: string) => {
  const Segmenter = (
    Intl as unknown as {
      Segmenter: new (
        locale: undefined,
        options: { granularity: "grapheme" },
      ) => { segment: (text: string) => Iterable<unknown> };
    }
  ).Segmenter;
  return Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(value)).length;
};

const hasOwn = (value: object, property: PropertyKey) =>
  Object.prototype.hasOwnProperty.call(value, property);

const connectChatSocket = async ({
  port,
  profileId,
  token,
}: {
  port: number;
  profileId: string;
  token: string;
}) => {
  const queued: SocketEvent[] = [];
  const waiters: Array<{
    predicate: (event: SocketEvent) => boolean;
    resolve: (event: SocketEvent) => void;
  }> = [];
  const BunWebSocket = WebSocket as unknown as {
    new (url: string, options: Bun.WebSocketOptions): WebSocket;
  };
  const socket = new BunWebSocket(`ws://127.0.0.1:${port}/api/chat/profiles/${profileId}/ws`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  socket.addEventListener("message", ({ data }) => {
    const event = JSON.parse(String(data)) as SocketEvent;
    const waiterIndex = waiters.findIndex(({ predicate }) => predicate(event));
    if (waiterIndex === -1) {
      queued.push(event);
      return;
    }
    const [waiter] = waiters.splice(waiterIndex, 1);
    waiter!.resolve(event);
  });

  const next = (
    predicate: (event: SocketEvent) => boolean,
    timeoutMilliseconds = 5_000,
  ): Promise<SocketEvent> => {
    const queuedIndex = queued.findIndex(predicate);
    if (queuedIndex !== -1) return Promise.resolve(queued.splice(queuedIndex, 1)[0]!);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for WebSocket event")),
        timeoutMilliseconds,
      );
      waiters.push({
        predicate,
        resolve: (event) => {
          clearTimeout(timeout);
          resolve(event);
        },
      });
    });
  };

  await next((event) => event.type === "connected");
  return { next, socket };
};

const sendDirect = ({
  fixture,
  idempotencyKey = randomUUID(),
  profileId = fixture.profileOneId,
  replyToMessageId,
  text,
  userId = fixture.userOneId,
  failureInjector,
}: {
  failureInjector?: (point: ChatTransactionFailurePoint) => Promise<void> | void;
  fixture: TransactionalChatFixture;
  idempotencyKey?: string;
  profileId?: string;
  replyToMessageId?: string;
  text: string;
  userId?: string;
}) =>
  sendTextMessage({
    conversationId: fixture.conversationId,
    failureInjector,
    idempotencyKey,
    policy,
    profileId,
    replyToMessageId,
    text,
    userId,
  });

describe("F4 transactional chat correctness against migrated PostgreSQL", () => {
  integrationTest(
    "converges REST, WebSocket, reconnect, concurrent, actor-scoped, and conflicting claims",
    async () => {
      const fixture = await createMatchedFixture("transactional_chat_command");
      const peerSocketId = `transactional-chat-peer-${randomUUID()}`;
      const peerEvents: SocketEvent[] = [];
      chatSockets.add({
        id: peerSocketId,
        profileId: fixture.profileTwoId,
        send: (event) => peerEvents.push(event),
        userId: fixture.userTwoId,
      });
      chatSockets.subscribe(peerSocketId, fixture.conversationId);

      let listening = false;
      let webSocket: WebSocket | undefined;
      try {
        const token = await createSessionToken(fixture.userOneId);

        const missing = await sendRestMessage({
          conversationId: fixture.conversationId,
          profileId: fixture.profileOneId,
          text: "missing key",
          token,
        });
        expect(missing.status).toBe(400);
        expect(await missing.json()).toEqual({
          code: "idempotency_key_required",
          message: "Idempotency-Key is required",
        });

        const malformed = await sendRestMessage({
          conversationId: fixture.conversationId,
          idempotencyKey: randomUUID().toUpperCase(),
          profileId: fixture.profileOneId,
          text: "malformed key",
          token,
        });
        expect(malformed.status).toBe(400);
        expect(await malformed.json()).toEqual({
          code: "invalid_idempotency_key",
          message: "Idempotency-Key must be a canonical lowercase RFC 4122 UUID",
        });
        for (const invalidText of ["   ", "x".repeat(4_001)]) {
          const invalidMessage = await sendRestMessage({
            conversationId: fixture.conversationId,
            idempotencyKey: randomUUID(),
            profileId: fixture.profileOneId,
            text: invalidText,
            token,
          });
          expect(invalidMessage.status).toBe(422);
          expect(await invalidMessage.json()).toEqual({
            code: "invalid_message",
            message: "Message text is invalid",
          });
        }
        const [preclaimCount] = await fixture.harness.postgres`
          select count(*)::integer as count
          from public.command_idempotency
          where actor_user_id = ${fixture.userOneId}
        `;
        expect(preclaimCount!.count).toBe(0);

        const restKey = randomUUID();
        const firstRest = await sendRestMessage({
          conversationId: fixture.conversationId,
          idempotencyKey: restKey,
          profileId: fixture.profileOneId,
          text: "  REST canonical  ",
          token,
        });
        expect(firstRest.status).toBe(201);
        expect(firstRest.headers.get("Idempotency-Replayed")).toBe("false");
        const firstRestMessage = await firstRest.json();

        const replayRest = await sendRestMessage({
          conversationId: fixture.conversationId,
          idempotencyKey: restKey,
          profileId: fixture.profileOneId,
          text: "REST canonical",
          token,
        });
        expect(replayRest.status).toBe(201);
        expect(replayRest.headers.get("Idempotency-Replayed")).toBe("true");
        expect(await replayRest.json()).toEqual(firstRestMessage);

        application.listen({ hostname: "127.0.0.1", port: 0 });
        listening = true;
        const port = application.server?.port;
        if (!port) throw new Error("transactional chat integration WebSocket server did not start");
        const origin = await connectChatSocket({
          port,
          profileId: fixture.profileOneId,
          token,
        });
        webSocket = origin.socket;

        origin.socket.send(
          JSON.stringify({
            type: "send_message",
            conversationId: fixture.conversationId,
            text: "Missing WebSocket key",
            clientMessageId: "missing-key-origin",
          }),
        );
        expect(
          await origin.next(
            (event) => event.type === "error" && event.clientMessageId === "missing-key-origin",
          ),
        ).toMatchObject({
          code: "idempotency_key_required",
          clientMessageId: "missing-key-origin",
        });

        const malformedWsKey = randomUUID().toUpperCase();
        origin.socket.send(
          JSON.stringify({
            type: "send_message",
            conversationId: fixture.conversationId,
            text: "Malformed WebSocket key",
            idempotencyKey: malformedWsKey,
            clientMessageId: "malformed-key-origin",
          }),
        );
        expect(
          await origin.next(
            (event) => event.type === "error" && event.clientMessageId === "malformed-key-origin",
          ),
        ).toMatchObject({
          code: "invalid_idempotency_key",
          idempotencyKey: malformedWsKey,
          clientMessageId: "malformed-key-origin",
        });

        const wsKey = randomUUID();
        origin.socket.send(
          JSON.stringify({
            type: "send_message",
            conversationId: fixture.conversationId,
            text: "WebSocket canonical",
            idempotencyKey: wsKey,
            clientMessageId: "origin-one",
          }),
        );
        const firstWs = await origin.next(
          (event) => event.type === "send_message_result" && event.idempotencyKey === wsKey,
        );
        expect(firstWs).toMatchObject({
          type: "send_message_result",
          command: "chat.message.send",
          commandVersion: 1,
          idempotencyKey: wsKey,
          clientMessageId: "origin-one",
          replayed: false,
          result: { status: "succeeded" },
        });

        origin.socket.send(
          JSON.stringify({
            type: "send_message",
            conversationId: fixture.conversationId,
            text: "WebSocket canonical",
            idempotencyKey: wsKey,
            clientMessageId: "origin-two",
          }),
        );
        const replayWs = await origin.next(
          (event) =>
            event.type === "send_message_result" &&
            event.idempotencyKey === wsKey &&
            event.clientMessageId === "origin-two",
        );
        expect(replayWs.replayed).toBeTrue();
        expect(replayWs.result.message).toEqual(firstWs.result.message);

        const rejectedWsKey = randomUUID();
        const rejectedWsTarget = randomUUID();
        for (const [clientMessageId, replayed] of [
          ["rejected-origin-one", false],
          ["rejected-origin-two", true],
        ] as const) {
          origin.socket.send(
            JSON.stringify({
              type: "send_message",
              conversationId: fixture.conversationId,
              text: "Rejected WebSocket command",
              replyToMessageId: rejectedWsTarget,
              idempotencyKey: rejectedWsKey,
              clientMessageId,
            }),
          );
          expect(
            await origin.next(
              (event) =>
                event.type === "send_message_result" && event.clientMessageId === clientMessageId,
            ),
          ).toMatchObject({
            idempotencyKey: rejectedWsKey,
            clientMessageId,
            replayed,
            result: {
              status: "rejected",
              error: { code: "invalid_reply_target" },
            },
          });
        }

        const crossTransportKey = randomUUID();
        const crossRest = await sendRestMessage({
          conversationId: fixture.conversationId,
          idempotencyKey: crossTransportKey,
          profileId: fixture.profileOneId,
          text: "Cross transport",
          token,
        });
        const crossRestMessage = await crossRest.json();
        origin.socket.send(
          JSON.stringify({
            type: "send_message",
            conversationId: fixture.conversationId,
            text: "Cross transport",
            idempotencyKey: crossTransportKey,
            clientMessageId: "cross-origin",
          }),
        );
        const crossWs = await origin.next(
          (event) =>
            event.type === "send_message_result" && event.idempotencyKey === crossTransportKey,
        );
        expect(crossWs.replayed).toBeTrue();
        expect(crossWs.result.message).toEqual(crossRestMessage);

        const concurrentKey = randomUUID();
        const concurrent = await Promise.all([
          sendDirect({ fixture, idempotencyKey: concurrentKey, text: "Concurrent once" }),
          sendDirect({ fixture, idempotencyKey: concurrentKey, text: "Concurrent once" }),
        ]);
        expect(concurrent.every((result) => result.ok)).toBeTrue();
        const concurrentSuccesses = concurrent.filter((result) => result.ok);
        expect(concurrentSuccesses.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
        expect(new Set(concurrentSuccesses.map(({ data }) => data.id)).size).toBe(1);

        for (const changed of [
          { text: "different text" },
          { text: "REST canonical", replyToMessageId: randomUUID() },
          { text: "REST canonical", conversationId: randomUUID() },
          { text: "REST canonical", profileId: randomUUID() },
        ]) {
          const result = await sendTextMessage({
            conversationId: changed.conversationId ?? fixture.conversationId,
            idempotencyKey: restKey,
            policy,
            profileId: changed.profileId ?? fixture.profileOneId,
            replyToMessageId: changed.replyToMessageId,
            text: changed.text,
            userId: fixture.userOneId,
          });
          expect(result).toMatchObject({
            ok: false,
            code: "idempotency_conflict",
            httpStatus: 409,
          });
        }

        let versionTwoExecuted = false;
        const versionConflict = await runIdempotentCommand({
          actorUserId: fixture.userOneId,
          commandName: CHAT_MESSAGE_SEND_COMMAND_NAME,
          commandVersion: 2,
          idempotencyKey: restKey,
          normalizedRequest: {
            conversationId: fixture.conversationId,
            actorProfileId: fixture.profileOneId,
            text: "REST canonical",
            replyToMessageId: null,
          },
          retentionSeconds: policy.commandRetentionSeconds,
          execute: async () => {
            versionTwoExecuted = true;
            return { outcome: "succeeded", result: { impossible: true } };
          },
        });
        expect(versionConflict).toMatchObject({
          ok: false,
          error: { code: "idempotency_conflict" },
        });
        expect(versionTwoExecuted).toBeFalse();

        const independentActor = await sendDirect({
          fixture,
          idempotencyKey: restKey,
          profileId: fixture.profileTwoId,
          text: "Independent authenticated actor",
          userId: fixture.userTwoId,
        });
        expect(independentActor.ok).toBeTrue();
        const [sameRawKeyClaims] = await fixture.harness.postgres`
          select count(*)::integer as count
          from public.command_idempotency
          where command_name = ${CHAT_MESSAGE_SEND_COMMAND_NAME}
            and idempotency_key = ${restKey}
        `;
        expect(sameRawKeyClaims!.count).toBe(2);

        const rejectedKey = randomUUID();
        const invalidReplyTargetId = randomUUID();
        const rejected = await sendDirect({
          fixture,
          idempotencyKey: rejectedKey,
          replyToMessageId: invalidReplyTargetId,
          text: "Invalid reply",
        });
        const rejectedReplay = await sendDirect({
          fixture,
          idempotencyKey: rejectedKey,
          replyToMessageId: invalidReplyTargetId,
          text: "Invalid reply",
        });
        expect(rejected).toMatchObject({
          ok: false,
          code: "invalid_reply_target",
          httpStatus: 422,
          replayed: false,
          terminalCommandResult: true,
        });
        expect(rejectedReplay).toMatchObject({
          ok: false,
          code: "invalid_reply_target",
          httpStatus: 422,
          replayed: true,
          terminalCommandResult: true,
        });
        // A different retry body must conflict, even if the first terminal result was rejected.
        const rejectedConflict = await sendDirect({
          fixture,
          idempotencyKey: rejectedKey,
          replyToMessageId: randomUUID(),
          text: "Invalid reply",
        });
        expect(rejectedConflict).toMatchObject({
          ok: false,
          code: "idempotency_conflict",
          httpStatus: 409,
        });

        const inProgressKey = randomUUID();
        const fingerprint = createCommandRequestFingerprint({
          commandName: CHAT_MESSAGE_SEND_COMMAND_NAME,
          commandVersion: 1,
          normalizedRequest: {
            conversationId: fixture.conversationId,
            actorProfileId: fixture.profileOneId,
            text: "In progress",
            replyToMessageId: null,
          },
        });
        await fixture.harness.postgres`
          insert into public.command_idempotency (
            actor_user_id,
            command_name,
            command_version,
            idempotency_key,
            request_fingerprint
          )
          values (
            ${fixture.userOneId},
            ${CHAT_MESSAGE_SEND_COMMAND_NAME},
            1,
            ${inProgressKey},
            ${fingerprint}
          )
        `;
        const inProgress = await sendRestMessage({
          conversationId: fixture.conversationId,
          idempotencyKey: inProgressKey,
          profileId: fixture.profileOneId,
          text: "In progress",
          token,
        });
        expect(inProgress.status).toBe(409);
        expect(inProgress.headers.get("Retry-After")).toBe("1");
        expect(await inProgress.json()).toMatchObject({ code: "idempotency_in_progress" });

        const canonicalPeerMessages = peerEvents.filter(({ type }) => type === "message");
        expect(canonicalPeerMessages).toHaveLength(5);
        for (const event of canonicalPeerMessages) {
          expect(JSON.stringify(event)).not.toContain("clientMessageId");
          expect(JSON.stringify(event)).not.toContain("idempotencyKey");
        }
        const [durableLeakCount] = await fixture.harness.postgres`
          select count(*)::integer as count
          from public.durable_event
          where scope_id in (
            ${fixture.conversationId},
            ${fixture.profileOneId},
            ${fixture.profileTwoId},
            ${fixture.userOneId},
            ${fixture.userTwoId}
          )
            and (
              payload::text like '%clientMessageId%'
              or payload::text like '%idempotencyKey%'
              or payload::text like '%origin-one%'
              or payload::text like '%origin-two%'
            )
        `;
        expect(durableLeakCount!.count).toBe(0);
      } finally {
        webSocket?.close();
        if (listening) application.server?.stop(true);
        chatSockets.remove(peerSocketId);
        await cleanupFixture(fixture);
      }
    },
    30_000,
  );

  integrationTest(
    "rolls back every atomic boundary and creates canonical notifications and minimal jobs without provider I/O",
    async () => {
      const fixture = await createMatchedFixture("transactional_chat_rollback");
      const activeSocketId = `transactional-chat-active-${randomUUID()}`;
      chatSockets.add({
        id: activeSocketId,
        profileId: fixture.profileTwoId,
        send: () => undefined,
        userId: fixture.userTwoId,
      });
      chatSockets.subscribe(activeSocketId, fixture.conversationId);
      const fetchSpy = spyOn(globalThis, "fetch");

      try {
        await fixture.harness.postgres`
          insert into public.user_push_token (
            user_id, provider, token, platform, enabled
          )
          values
            (${fixture.userTwoId}, 'expo', ${`ExponentPushToken[${randomUUID()}]`}, 'ios', true),
            (${fixture.userTwoId}, 'expo', ${`ExponentPushToken[${randomUUID()}]`}, 'android', true)
        `;

        const snapshot = async () => {
          const [row] = await fixture.harness.postgres`
            select
              (select count(*)::integer from public.chat_message
                where conversation_id = ${fixture.conversationId}) as messages,
              (select count(*)::integer from public.chat_conversation_read_state
                where conversation_id = ${fixture.conversationId}) as reads,
              (select count(*)::integer from public.notification
                where type = 'message'
                  and data->>'conversationId' = ${fixture.conversationId}) as notifications,
              (select count(*)::integer from public.notification_delivery delivery
                inner join public.notification notice on notice.id = delivery.notification_id
                where notice.data->>'conversationId' = ${fixture.conversationId}) as deliveries,
              (select count(*)::integer from public.command_idempotency
                where actor_user_id = ${fixture.userOneId}
                  and command_name = ${CHAT_MESSAGE_SEND_COMMAND_NAME}) as commands,
              (select count(*)::integer from public.durable_event
                where scope_id in (
                  ${fixture.conversationId},
                  ${fixture.profileOneId},
                  ${fixture.profileTwoId},
                  ${fixture.userOneId},
                  ${fixture.userTwoId}
                )) as events,
              (select count(*)::integer from public.durable_event_scope
                where scope_id in (
                  ${fixture.conversationId},
                  ${fixture.profileOneId},
                  ${fixture.profileTwoId},
                  ${fixture.userOneId},
                  ${fixture.userTwoId}
                )) as scopes,
              (select count(*)::integer from public.delivery_job
                where job_kind = ${NOTIFICATION_PUSH_DELIVERY_JOB_KIND}) as jobs,
              (select last_message_at::text from public.chat_conversation
                where id = ${fixture.conversationId}) as "lastMessageAt"
          `;
          return row;
        };

        const baseline = await snapshot();
        const points: ChatTransactionFailurePoint[] = [
          "after_idempotency_claim",
          "after_common_lock",
          "after_authorization",
          "after_match_validation",
          "after_reply_validation",
          "after_message_insert",
          "after_sender_read",
          "after_conversation_projection",
          "after_notification_state",
          "after_delivery_jobs",
          "after_durable_events",
          "before_idempotency_outcome",
          "after_idempotency_outcome",
        ];
        for (const point of points) {
          const failure = new Error(`injected:${point}`);
          await expect(
            sendDirect({
              fixture,
              text: `Rollback ${point}`,
              failureInjector: (current) => {
                if (current === point) throw failure;
              },
            }),
          ).rejects.toBe(failure);
          expect(await snapshot()).toEqual(baseline);
        }

        const result = await sendDirect({
          fixture,
          text: "Notification while recipient is actively viewing",
        });
        expect(result.ok).toBeTrue();
        if (!result.ok) throw new Error(result.message);

        const notifications = await fixture.harness.postgres`
          select id
          from public.notification
          where type = 'message'
            and recipient_user_id = ${fixture.userTwoId}
            and data->>'messageId' = ${result.data.id}
        `;
        expect(notifications).toHaveLength(1);
        const deliveries = (await fixture.harness.postgres`
          select delivery.id, delivery.channel, delivery.status, delivery.push_token_id as "pushTokenId"
          from public.notification_delivery delivery
          where delivery.notification_id = ${notifications[0]!.id}
          order by delivery.id
        `) as DeliveryRow[];
        expect(deliveries).toHaveLength(2);
        expect(deliveries.every(({ channel }) => channel === "push")).toBeTrue();
        expect(deliveries.every(({ pushTokenId }) => Boolean(pushTokenId))).toBeTrue();
        const [inAppDeliveries] = await fixture.harness.postgres`
          select count(*)::integer as count
          from public.notification_delivery
          where notification_id = ${notifications[0]!.id}
            and channel = 'in_app'
        `;
        expect(inAppDeliveries!.count).toBe(0);

        const jobs = (await fixture.harness.postgres`
          select
            payload,
            job_version as "jobVersion",
            max_attempts as "maxAttempts",
            terminal_retention_seconds as "terminalRetentionSeconds",
            state,
            (available_at <= clock_timestamp()) as available
          from public.delivery_job
          where job_kind = ${NOTIFICATION_PUSH_DELIVERY_JOB_KIND}
          order by id
        `) as Array<{
          available: boolean;
          jobVersion: number;
          maxAttempts: number;
          payload: { notificationDeliveryId: string };
          state: string;
          terminalRetentionSeconds: number;
        }>;
        expect(jobs).toHaveLength(2);
        for (const job of jobs) {
          expect(Object.keys(job.payload)).toEqual(["notificationDeliveryId"]);
          expect(deliveries.map(({ id }) => id)).toContain(job.payload.notificationDeliveryId);
          expect(job).toMatchObject({
            jobVersion: 1,
            maxAttempts: 8,
            terminalRetentionSeconds: 2_592_000,
            state: "pending",
            available: true,
          });
        }

        const causalEvents = (await fixture.harness.postgres`
          select
            scope_kind as "scopeKind",
            scope_id as "scopeId",
            sequence::integer,
            event_type as "eventType",
            event_version as "eventVersion",
            causal_id as "causalId",
            payload,
            extract(epoch from retention_expires_at - committed_at)::integer as "retentionSeconds"
          from public.durable_event
          where causal_id = (
            select causal_id
            from public.durable_event
            where event_type = 'chat.message.created'
              and payload->'message'->>'id' = ${result.data.id}
          )
          order by scope_kind, scope_id, sequence
        `) as DurableEventRow[];
        expect(causalEvents).toHaveLength(6);
        expect(new Set(causalEvents.map(({ causalId }) => causalId)).size).toBe(1);
        expect(causalEvents.every(({ eventVersion }) => eventVersion === 1)).toBeTrue();
        expect(
          causalEvents.every(({ retentionSeconds }) => retentionSeconds === 2_592_000),
        ).toBeTrue();

        const conversationEvents = causalEvents
          .filter(({ scopeKind }) => scopeKind === "chat-conversation")
          .sort((left, right) => left.sequence - right.sequence);
        expect(conversationEvents.map(({ eventType }) => eventType)).toEqual([
          "chat.message.created",
          "chat.conversation.read",
        ]);
        const recipientProfileEvents = causalEvents
          .filter(
            ({ scopeKind, scopeId }) =>
              scopeKind === "chat-profile" && scopeId === fixture.profileTwoId,
          )
          .sort((left, right) => left.sequence - right.sequence);
        expect(recipientProfileEvents.map(({ eventType }) => eventType)).toEqual([
          "chat.conversation.upsert",
          "chat.unread.aggregate",
        ]);
        expect(
          causalEvents
            .filter(({ scopeKind }) => scopeKind === "notification-user")
            .map(({ eventType }) => eventType),
        ).toEqual(["notification.created"]);

        const [commandPolicy] = await fixture.harness.postgres`
          select
            outcome,
            extract(epoch from retention_expires_at - completed_at)::integer as "retentionSeconds"
          from public.command_idempotency
          where actor_user_id = ${fixture.userOneId}
            and result->'value'->'message'->>'id' = ${result.data.id}
        `;
        expect(commandPolicy).toMatchObject({
          outcome: "succeeded",
          retentionSeconds: 2_592_000,
        });
        const [jsonStorage] = await fixture.harness.postgres`
          select
            jsonb_typeof(notice.data) as "notificationData",
            jsonb_typeof(job.payload) as "jobPayload",
            jsonb_typeof(event.payload) as "eventPayload",
            jsonb_typeof(command.result) as "commandResult"
          from public.notification notice
          inner join public.notification_delivery delivery
            on delivery.notification_id = notice.id
          inner join public.delivery_job job
            on job.payload->>'notificationDeliveryId' = delivery.id::text
          inner join public.durable_event event
            on event.event_type = 'chat.message.created'
            and event.payload->'message'->>'id' = ${result.data.id}
          inner join public.command_idempotency command
            on command.result->'value'->'message'->>'id' = ${result.data.id}
          where notice.id = ${notifications[0]!.id}
          limit 1
        `;
        expect(jsonStorage).toEqual({
          notificationData: "object",
          jobPayload: "object",
          eventPayload: "object",
          commandResult: "object",
        });
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
        chatSockets.remove(activeSocketId);
        await cleanupFixture(fixture);
      }
    },
    30_000,
  );

  integrationTest(
    "keeps reply summaries bounded and reads and authoritative unread state monotonic",
    async () => {
      const fixture = await createMatchedFixture("transactional_chat_read_reply");
      try {
        const targetText = `${"👨‍👩‍👧‍👦".repeat(170)}tail`;
        const target = await sendDirect({
          fixture,
          profileId: fixture.profileTwoId,
          text: targetText,
          userId: fixture.userTwoId,
        });
        expect(target.ok).toBeTrue();
        if (!target.ok) throw new Error(target.message);
        expect(target.data.replySummary).toBeNull();
        expect(hasOwn(target.data, "replySummary")).toBeTrue();

        const reply = await sendDirect({
          fixture,
          replyToMessageId: target.data.id,
          text: "Bounded reply",
        });
        expect(reply.ok).toBeTrue();
        if (!reply.ok) throw new Error(reply.message);
        expect(reply.data.replySummary).toMatchObject({
          messageId: target.data.id,
          senderProfileId: fixture.profileTwoId,
          messageType: "text",
          state: "available",
          preview: { kind: "text", truncated: true },
        });
        const preview = reply.data.replySummary?.preview;
        if (!preview || preview.kind !== "text") throw new Error("Expected text reply preview");
        expect(countGraphemes(preview.text)).toBe(160);
        expect(JSON.stringify(reply.data.replySummary)).not.toContain("url");
        expect(JSON.stringify(reply.data.replySummary)).not.toContain("name");

        const [replyEvent] = await fixture.harness.postgres`
          select payload->'message'->'replySummary' as summary
          from public.durable_event
          where event_type = 'chat.message.created'
            and payload->'message'->>'id' = ${reply.data.id}
        `;
        expect(replyEvent!.summary).toEqual(JSON.parse(JSON.stringify(reply.data.replySummary)));

        const [imageTarget] = await fixture.harness.postgres`
          insert into public.chat_message (
            conversation_id,
            sender_profile_id,
            message_type,
            content,
            attachments
          )
          values (
            ${fixture.conversationId},
            ${fixture.profileTwoId},
            'image',
            null,
            '[]'::jsonb
          )
          returning id
        `;
        const imageReply = await sendDirect({
          fixture,
          replyToMessageId: imageTarget!.id,
          text: "Image reply",
        });
        expect(imageReply.ok).toBeTrue();
        if (!imageReply.ok) throw new Error(imageReply.message);
        expect(imageReply.data.replySummary).toEqual({
          messageId: imageTarget!.id,
          senderProfileId: fixture.profileTwoId,
          messageType: "image",
          state: "available",
          preview: { kind: "image" },
        });

        const malformedReplyId = randomUUID();
        await fixture.harness.postgres`
          insert into public.chat_message (
            id,
            conversation_id,
            sender_profile_id,
            message_type,
            content,
            reply_to_message_id,
            reply_summary
          )
          values (
            ${malformedReplyId},
            ${fixture.conversationId},
            ${fixture.profileOneId},
            'text',
            'Malformed legacy reply summary',
            ${imageTarget!.id},
            ${{
              messageId: imageTarget!.id,
              senderProfileId: fixture.profileTwoId,
              messageType: "image",
              state: "available",
              preview: {},
            }}
          )
        `;
        const malformedMessages = await listChatMessages({
          conversationId: fixture.conversationId,
          profileId: fixture.profileOneId,
          userId: fixture.userOneId,
        });
        expect(malformedMessages.ok).toBeTrue();
        if (!malformedMessages.ok) throw new Error(malformedMessages.message);
        const malformedSummary = malformedMessages.data.data.find(
          ({ id }) => id === malformedReplyId,
        )?.replySummary;
        expect(malformedSummary).toEqual({
          messageId: imageTarget!.id,
          senderProfileId: fixture.profileTwoId,
          messageType: "image",
          state: "unavailable",
        });
        expect(hasOwn(malformedSummary!, "preview")).toBeFalse();

        await fixture.harness.postgres`
          update public.chat_message
          set deleted_at = clock_timestamp()
          where id = ${target.data.id}
        `;
        let messages = await listChatMessages({
          conversationId: fixture.conversationId,
          profileId: fixture.profileOneId,
          userId: fixture.userOneId,
        });
        expect(messages.ok).toBeTrue();
        if (!messages.ok) throw new Error(messages.message);
        const deletedSummary = messages.data.data.find(
          ({ id }) => id === reply.data.id,
        )?.replySummary;
        expect(deletedSummary).toEqual({
          messageId: target.data.id,
          senderProfileId: fixture.profileTwoId,
          messageType: "text",
          state: "deleted",
        });
        expect(hasOwn(deletedSummary!, "preview")).toBeFalse();
        expect(JSON.stringify(deletedSummary)).not.toContain('"preview"');

        await fixture.harness.postgres`
          delete from public.chat_message where id = ${target.data.id}
        `;
        messages = await listChatMessages({
          conversationId: fixture.conversationId,
          profileId: fixture.profileOneId,
          userId: fixture.userOneId,
        });
        if (!messages.ok) throw new Error(messages.message);
        const unavailableSummary = messages.data.data.find(
          ({ id }) => id === reply.data.id,
        )?.replySummary;
        expect(unavailableSummary).toEqual({
          messageId: target.data.id,
          senderProfileId: fixture.profileTwoId,
          messageType: "text",
          state: "unavailable",
        });
        expect(hasOwn(unavailableSummary!, "preview")).toBeFalse();
        expect(JSON.stringify(unavailableSummary)).not.toContain('"preview"');

        const incoming = [];
        for (const text of ["Incoming one", "Incoming two", "Incoming three"]) {
          const result = await sendDirect({
            fixture,
            profileId: fixture.profileTwoId,
            text,
            userId: fixture.userTwoId,
          });
          if (!result.ok) throw new Error(result.message);
          incoming.push(result.data);
        }
        expect(
          await getChatUnreadCount({
            profileId: fixture.profileOneId,
            userId: fixture.userOneId,
          }),
        ).toEqual({ ok: true, data: { count: 3 } });

        const [oldest, middle, newest] = incoming;
        await Promise.all([
          markChatConversationRead({
            conversationId: fixture.conversationId,
            messageId: middle!.id,
            policy,
            profileId: fixture.profileOneId,
            userId: fixture.userOneId,
          }),
          markChatConversationRead({
            conversationId: fixture.conversationId,
            messageId: oldest!.id,
            policy,
            profileId: fixture.profileOneId,
            userId: fixture.userOneId,
          }),
          markChatConversationRead({
            conversationId: fixture.conversationId,
            messageId: newest!.id,
            policy,
            profileId: fixture.profileOneId,
            userId: fixture.userOneId,
          }),
        ]);
        await markChatConversationRead({
          conversationId: fixture.conversationId,
          messageId: oldest!.id,
          policy,
          profileId: fixture.profileOneId,
          userId: fixture.userOneId,
        });
        const [position] = await fixture.harness.postgres`
          select
            last_read_message_id as "lastReadMessageId",
            last_read_message_created_at as "lastReadMessageCreatedAt"
          from public.chat_conversation_read_state
          where conversation_id = ${fixture.conversationId}
            and profile_id = ${fixture.profileOneId}
        `;
        expect(position!.lastReadMessageId).toBe(newest!.id);
        expect(new Date(position!.lastReadMessageCreatedAt).toISOString()).toBe(
          newest!.createdAt.toISOString(),
        );

        const conversation = await getChatConversation({
          conversationId: fixture.conversationId,
          profileId: fixture.profileOneId,
          userId: fixture.userOneId,
        });
        expect(conversation.ok).toBeTrue();
        if (!conversation.ok) throw new Error(conversation.message);
        expect(conversation.data.participantReadPositions).toHaveLength(2);
        expect(
          conversation.data.participantReadPositions.map(({ profileId }) => profileId),
        ).toEqual([fixture.profileOneId, fixture.profileTwoId].sort());
        expect(conversation.data.readState.unreadCount).toBe(0);
        const peerConversation = await getChatConversation({
          conversationId: fixture.conversationId,
          profileId: fixture.profileTwoId,
          userId: fixture.userTwoId,
        });
        expect(peerConversation.ok).toBeTrue();
        if (!peerConversation.ok) throw new Error(peerConversation.message);
        expect(peerConversation.data.participantReadPositions).toEqual(
          conversation.data.participantReadPositions,
        );

        const outsiderUserId = await insertUser(fixture.harness, "transactional-chat-outsider");
        fixture.userIds.add(outsiderUserId);
        const outsider = await createProfile(outsiderUserId, "Transactional Chat Outsider");
        fixture.profileIds.add(outsider.id);
        expect(
          await getChatConversation({
            conversationId: fixture.conversationId,
            profileId: outsider.id,
            userId: outsiderUserId,
          }),
        ).toEqual({
          ok: false,
          code: "conversation_not_found",
          message: "Conversation not found",
        });

        const finalIncoming = await sendDirect({
          fixture,
          profileId: fixture.profileTwoId,
          text: "Unread through unlike and rematch",
          userId: fixture.userTwoId,
        });
        if (!finalIncoming.ok) throw new Error(finalIncoming.message);
        const unlike = await setProfileReactionAndSyncConversation({
          policy,
          profileId: fixture.profileOneId,
          reaction: "unlike",
          targetProfileId: fixture.profileTwoId,
          userId: fixture.userOneId,
        });
        expect(unlike).toMatchObject({ ok: true, matched: false });
        expect(
          await getChatUnreadCount({
            profileId: fixture.profileOneId,
            userId: fixture.userOneId,
          }),
        ).toEqual({ ok: true, data: { count: 1 } });
        const unreadToken = await createSessionToken(fixture.userOneId);
        const unreadResponse = await application.handle(
          new Request(`http://localhost/api/chat/profiles/${fixture.profileOneId}/unread-count`, {
            headers: { authorization: `Bearer ${unreadToken}` },
          }),
        );
        expect(unreadResponse.status).toBe(200);
        expect(await unreadResponse.json()).toEqual({ count: 1 });
        const historicalMessages = await listChatMessages({
          conversationId: fixture.conversationId,
          profileId: fixture.profileOneId,
          userId: fixture.userOneId,
        });
        expect(historicalMessages.ok).toBeTrue();

        const rematch = await setProfileReactionAndSyncConversation({
          policy,
          profileId: fixture.profileOneId,
          reaction: "like",
          targetProfileId: fixture.profileTwoId,
          userId: fixture.userOneId,
        });
        expect(rematch).toMatchObject({ ok: true, matched: true });
        expect(
          await getChatUnreadCount({
            profileId: fixture.profileOneId,
            userId: fixture.userOneId,
          }),
        ).toEqual({ ok: true, data: { count: 1 } });

        const readFinal = await markChatConversationRead({
          conversationId: fixture.conversationId,
          messageId: finalIncoming.data.id,
          policy,
          profileId: fixture.profileOneId,
          userId: fixture.userOneId,
        });
        expect(readFinal.ok).toBeTrue();
        expect(
          await getChatUnreadCount({
            profileId: fixture.profileOneId,
            userId: fixture.userOneId,
          }),
        ).toEqual({ ok: true, data: { count: 0 } });
        const [storedAggregate] = await fixture.harness.postgres`
          select payload
          from public.durable_event
          where scope_kind = 'chat-profile'
            and scope_id = ${fixture.profileOneId}
            and event_type = 'chat.unread.aggregate'
          order by sequence desc
          limit 1
        `;
        expect(storedAggregate!.payload).toEqual({
          profileId: fixture.profileOneId,
          count: 0,
        });
      } finally {
        await cleanupFixture(fixture);
      }
    },
    30_000,
  );

  integrationTest(
    "normalizes only mutable legacy reply-summary JSONB with the forward migration",
    async () => {
      const fixture = await createMatchedFixture("transactional_chat_reply_migration");
      try {
        const rowIds = {
          availableObject: randomUUID(),
          availableNull: randomUUID(),
          availableMissing: randomUUID(),
          availableInvalid: randomUUID(),
          deleted: randomUUID(),
          unavailable: randomUUID(),
          nonObject: randomUUID(),
        };
        const identity = {
          messageId: randomUUID(),
          senderProfileId: fixture.profileTwoId,
          messageType: "text",
        };
        const summaries = {
          availableObject: {
            ...identity,
            state: "available",
            preview: { kind: "text", text: "preserved", truncated: false },
          },
          availableNull: { ...identity, state: "available", preview: null },
          availableMissing: { ...identity, state: "available" },
          availableInvalid: { ...identity, state: "available", preview: "invalid" },
          deleted: { ...identity, state: "deleted", preview: null },
          unavailable: {
            ...identity,
            state: "unavailable",
            preview: { kind: "text", text: "remove me", truncated: false },
          },
        };

        for (const [shape, id] of Object.entries(rowIds)) {
          const replySummary =
            shape === "nonObject" ? ["guarded"] : summaries[shape as keyof typeof summaries];
          await fixture.harness.postgres`
            insert into public.chat_message (
              id,
              conversation_id,
              sender_profile_id,
              message_type,
              content,
              reply_summary
            )
            values (
              ${id},
              ${fixture.conversationId},
              ${fixture.profileOneId},
              'text',
              ${`migration fixture ${shape}`},
              ${replySummary}
            )
          `;
        }

        const migrationSql = await Bun.file(
          new URL(
            "../../drizzle/20260723233434_chat_reply_summary_preview_optional/migration.sql",
            import.meta.url,
          ),
        ).text();
        await fixture.harness.postgres.unsafe(migrationSql);
        const firstPass = (await fixture.harness.postgres`
          select id, reply_summary as "replySummary"
          from public.chat_message
          where id in (
            ${rowIds.availableObject},
            ${rowIds.availableNull},
            ${rowIds.availableMissing},
            ${rowIds.availableInvalid},
            ${rowIds.deleted},
            ${rowIds.unavailable},
            ${rowIds.nonObject}
          )
          order by id
        `) as Array<{ id: string; replySummary: unknown }>;

        await fixture.harness.postgres.unsafe(migrationSql);
        const secondPass = (await fixture.harness.postgres`
          select id, reply_summary as "replySummary"
          from public.chat_message
          where id in (
            ${rowIds.availableObject},
            ${rowIds.availableNull},
            ${rowIds.availableMissing},
            ${rowIds.availableInvalid},
            ${rowIds.deleted},
            ${rowIds.unavailable},
            ${rowIds.nonObject}
          )
          order by id
        `) as Array<{ id: string; replySummary: unknown }>;
        expect(secondPass).toEqual(firstPass);

        const byId = new Map(firstPass.map((row) => [row.id, row.replySummary]));
        expect(byId.get(rowIds.availableObject)).toEqual(summaries.availableObject);
        for (const id of [rowIds.availableNull, rowIds.availableMissing, rowIds.availableInvalid]) {
          const summary = byId.get(id) as Record<string, unknown>;
          expect(summary.state).toBe("unavailable");
          expect(hasOwn(summary, "preview")).toBeFalse();
        }
        for (const id of [rowIds.deleted, rowIds.unavailable]) {
          const summary = byId.get(id) as Record<string, unknown>;
          expect(hasOwn(summary, "preview")).toBeFalse();
        }
        expect(byId.get(rowIds.nonObject)).toEqual(["guarded"]);
      } finally {
        await cleanupFixture(fixture);
      }
    },
    30_000,
  );

  integrationTest(
    "serializes send and reaction mutations with unlike and emits convergence events on unlike and rematch",
    async () => {
      const fixture = await createMatchedFixture("transactional_chat_lock");
      try {
        let sendLocked!: () => void;
        let releaseSend!: () => void;
        const sendHasLock = new Promise<void>((resolve) => (sendLocked = resolve));
        const sendRelease = new Promise<void>((resolve) => (releaseSend = resolve));
        const sending = sendDirect({
          fixture,
          text: "Send wins common lock",
          failureInjector: async (point) => {
            if (point !== "after_common_lock") return;
            sendLocked();
            await sendRelease;
          },
        });
        await sendHasLock;
        let unlikeSettled = false;
        const unlikeAfterSend = setProfileReactionAndSyncConversation({
          policy,
          profileId: fixture.profileOneId,
          reaction: "unlike",
          targetProfileId: fixture.profileTwoId,
          userId: fixture.userOneId,
        }).finally(() => {
          unlikeSettled = true;
        });
        await Bun.sleep(40);
        expect(unlikeSettled).toBeFalse();
        releaseSend();
        const [sent, unliked] = await Promise.all([sending, unlikeAfterSend]);
        expect(sent.ok).toBeTrue();
        expect(unliked).toMatchObject({ ok: true, matched: false });
        if (!sent.ok) throw new Error(sent.message);

        const staleSend = await sendDirect({
          fixture,
          text: "Must not commit while unmatched",
        });
        expect(staleSend).toMatchObject({
          ok: false,
          code: "conversation_not_matched",
          httpStatus: 409,
        });

        const firstRematch = await setProfileReactionAndSyncConversation({
          policy,
          profileId: fixture.profileOneId,
          reaction: "like",
          targetProfileId: fixture.profileTwoId,
          userId: fixture.userOneId,
        });
        expect(firstRematch).toMatchObject({ ok: true, matched: true });
        expect(
          await setMessageReaction({
            conversationId: fixture.conversationId,
            emoji: "   ",
            messageId: sent.data.id,
            policy,
            profileId: fixture.profileTwoId,
            reacted: true,
            userId: fixture.userTwoId,
          }),
        ).toEqual({
          ok: false,
          code: "invalid_reaction",
          message: "Reaction is invalid",
        });
        expect(
          await setMessageReaction({
            conversationId: fixture.conversationId,
            emoji: "❤️",
            messageId: randomUUID(),
            policy,
            profileId: fixture.profileTwoId,
            reacted: true,
            userId: fixture.userTwoId,
          }),
        ).toEqual({
          ok: false,
          code: "message_not_found",
          message: "Message not found",
        });

        let reactionLocked!: () => void;
        let releaseReaction!: () => void;
        const reactionHasLock = new Promise<void>((resolve) => (reactionLocked = resolve));
        const reactionRelease = new Promise<void>((resolve) => (releaseReaction = resolve));
        const reacting = setMessageReaction({
          conversationId: fixture.conversationId,
          emoji: "🔥",
          failureInjector: async (point) => {
            if (point !== "after_common_lock") return;
            reactionLocked();
            await reactionRelease;
          },
          messageId: sent.data.id,
          policy,
          profileId: fixture.profileTwoId,
          reacted: true,
          userId: fixture.userTwoId,
        });
        await reactionHasLock;
        let reactionUnlikeSettled = false;
        const unlikeAfterReaction = setProfileReactionAndSyncConversation({
          policy,
          profileId: fixture.profileOneId,
          reaction: "unlike",
          targetProfileId: fixture.profileTwoId,
          userId: fixture.userOneId,
        }).finally(() => {
          reactionUnlikeSettled = true;
        });
        await Bun.sleep(40);
        expect(reactionUnlikeSettled).toBeFalse();
        releaseReaction();
        const [reaction, secondUnlike] = await Promise.all([reacting, unlikeAfterReaction]);
        expect(reaction.ok).toBeTrue();
        expect(secondUnlike).toMatchObject({ ok: true, matched: false });

        await setProfileReactionAndSyncConversation({
          policy,
          profileId: fixture.profileOneId,
          reaction: "like",
          targetProfileId: fixture.profileTwoId,
          userId: fixture.userOneId,
        });
        const [reactionEventsBefore] = await fixture.harness.postgres`
          select count(*)::integer as count
          from public.durable_event
          where scope_kind = 'chat-conversation'
            and scope_id = ${fixture.conversationId}
            and event_type = 'chat.reaction.state'
        `;
        const reactionNoOp = await setMessageReaction({
          conversationId: fixture.conversationId,
          emoji: "🔥",
          messageId: sent.data.id,
          policy,
          profileId: fixture.profileTwoId,
          reacted: true,
          userId: fixture.userTwoId,
        });
        expect(reactionNoOp.ok).toBeTrue();
        const [reactionEventsAfter] = await fixture.harness.postgres`
          select count(*)::integer as count
          from public.durable_event
          where scope_kind = 'chat-conversation'
            and scope_id = ${fixture.conversationId}
            and event_type = 'chat.reaction.state'
        `;
        expect(reactionEventsAfter!.count).toBe(reactionEventsBefore!.count);

        const unlikeWins = await setProfileReactionAndSyncConversation({
          policy,
          profileId: fixture.profileOneId,
          reaction: "unlike",
          targetProfileId: fixture.profileTwoId,
          userId: fixture.userOneId,
        });
        expect(unlikeWins).toMatchObject({ ok: true, matched: false });
        const staleReaction = await setMessageReaction({
          conversationId: fixture.conversationId,
          emoji: "❤️",
          messageId: sent.data.id,
          policy,
          profileId: fixture.profileTwoId,
          reacted: true,
          userId: fixture.userTwoId,
        });
        expect(staleReaction).toEqual({
          ok: false,
          code: "conversation_not_matched",
          message: "Conversation is not currently matched",
        });

        const stateCausalIds = (await fixture.harness.postgres`
          select causal_id as "causalId"
          from public.durable_event
          where scope_kind = 'chat-conversation'
            and scope_id = ${fixture.conversationId}
            and event_type = 'chat.conversation.state'
          order by sequence
        `) as Array<{ causalId: string }>;
        expect(stateCausalIds.length).toBeGreaterThanOrEqual(5);
        for (const { causalId } of stateCausalIds) {
          const converged = (await fixture.harness.postgres`
            select
              scope_kind as "scopeKind",
              scope_id as "scopeId",
              sequence::integer,
              event_type as "eventType",
              payload
            from public.durable_event
            where causal_id = ${causalId}
            order by scope_kind, scope_id, sequence
          `) as Array<
            Pick<DurableEventRow, "eventType" | "payload" | "scopeId" | "scopeKind" | "sequence">
          >;
          expect(converged).toHaveLength(3);
          expect(converged.map(({ eventType }) => eventType).sort()).toEqual([
            "chat.conversation.state",
            "chat.conversation.upsert",
            "chat.conversation.upsert",
          ]);
          expect(
            converged
              .filter(({ scopeKind }) => scopeKind === "chat-profile")
              .map(({ scopeId }) => scopeId)
              .sort(),
          ).toEqual([fixture.profileOneId, fixture.profileTwoId].sort());
          expect(
            converged.find(({ eventType }) => eventType === "chat.conversation.state")?.payload,
          ).toMatchObject({ conversationId: fixture.conversationId });
        }

        const scopeSequences = (await fixture.harness.postgres`
          select scope_kind as "scopeKind", scope_id as "scopeId", sequence::integer
          from public.durable_event
          where scope_id in (
            ${fixture.conversationId},
            ${fixture.profileOneId},
            ${fixture.profileTwoId}
          )
          order by scope_kind, scope_id, sequence
        `) as Array<Pick<DurableEventRow, "scopeId" | "scopeKind" | "sequence">>;
        const byScope = new Map<string, number[]>();
        for (const event of scopeSequences) {
          const key = `${event.scopeKind}/${event.scopeId}`;
          const sequences = byScope.get(key) ?? [];
          sequences.push(event.sequence);
          byScope.set(key, sequences);
        }
        expect(byScope.size).toBe(3);
        for (const sequences of byScope.values()) {
          expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
          expect(new Set(sequences).size).toBe(sequences.length);
        }
      } finally {
        await cleanupFixture(fixture);
      }
    },
    30_000,
  );
});
