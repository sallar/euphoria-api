import { describe, expect, test } from "bun:test";

import { CursorError } from "@/lib/cursor";
import { listChatConversations, listChatMessages } from "@/services/chat-service";
import { listProfileFeed } from "@/services/feed-service";
import { listNotifications } from "@/services/notification-service";

import { createIntegrationHarness } from "./harness";

const integrationTest = process.env.RUN_INTEGRATION_TESTS === "1" ? test : test.skip;

const actorUserId = "cursor-integration-actor";
const peerUserId = "cursor-integration-peer";
const actorProfileId = "10000000-0000-4000-8000-000000000001";
const peerProfileIds = [
  "20000000-0000-4000-8000-000000000001",
  "20000000-0000-4000-8000-000000000002",
  "20000000-0000-4000-8000-000000000003",
  "20000000-0000-4000-8000-000000000004",
  "20000000-0000-4000-8000-000000000005",
] as const;
const conversationIds = [
  "30000000-0000-4000-8000-000000000001",
  "30000000-0000-4000-8000-000000000002",
  "30000000-0000-4000-8000-000000000003",
  "30000000-0000-4000-8000-000000000004",
  "30000000-0000-4000-8000-000000000005",
] as const;
const messageIds = [
  "40000000-0000-4000-8000-000000000001",
  "40000000-0000-4000-8000-000000000002",
  "40000000-0000-4000-8000-000000000003",
  "40000000-0000-4000-8000-000000000004",
  "40000000-0000-4000-8000-000000000005",
] as const;
const notificationIds = [
  "50000000-0000-4000-8000-000000000001",
  "50000000-0000-4000-8000-000000000002",
  "50000000-0000-4000-8000-000000000003",
  "50000000-0000-4000-8000-000000000004",
  "50000000-0000-4000-8000-000000000005",
] as const;
const tiedTimestamp = "2026-07-23T12:00:00.123456Z";
const olderTimestamp = "2026-07-22T12:00:00.654321Z";

const expectExactlyOnce = (actual: string[], expected: readonly string[]) => {
  expect(actual).toHaveLength(expected.length);
  expect(new Set(actual).size).toBe(actual.length);
  expect(new Set(actual)).toEqual(new Set(expected));
};

const expectCursorFailure = async (operation: () => Promise<unknown>) => {
  try {
    await operation();
    throw new Error("Expected cursor decoding to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(CursorError);
    expect((error as CursorError).status).toBe(400);
    expect((error as CursorError).message).toBe("Cursor is invalid for this request");
  }
};

describe("F1 cursor pagination against migrated PostgreSQL", () => {
  integrationTest(
    "traverses tie-heavy feed, conversation, message, and notification fixtures exactly once",
    async () => {
      process.env.CURSOR_SIGNING_SECRET = "cursor-integration-signing-secret";
      const harness = await createIntegrationHarness("cursor_pagination");
      const now = new Date("2026-07-23T15:00:00.000Z");

      try {
        await harness.postgres`
          insert into public."user" (
            id, name, email, email_verified, created_at, updated_at
          )
          values
            (
              ${actorUserId},
              ${"Cursor Actor"},
              ${`cursor-actor-${process.pid}@example.test`},
              true,
              ${now},
              ${now}
            ),
            (
              ${peerUserId},
              ${"Cursor Peer"},
              ${`cursor-peer-${process.pid}@example.test`},
              true,
              ${now},
              ${now}
            )
        `;
        await harness.postgres`
          insert into public.profile (
            id,
            profile_type,
            name,
            gender,
            gender_interests,
            orientation,
            orientation_interests,
            relationship_types,
            location,
            country,
            date_of_birth
          )
          values (
            ${actorProfileId},
            'solo',
            ${"Cursor Actor Profile"},
            'man',
            array['woman']::profile_gender[],
            'heterosexual',
            array['heterosexual']::profile_orientation[],
            array['dating']::profile_relationship_type[],
            st_setsrid(st_makepoint(24.94, 60.17), 4326)::geography,
            'FI',
            '1990-01-01'
          )
        `;

        for (const [index, profileId] of peerProfileIds.entries()) {
          const longitude = index < 3 ? 24.94 : 24.95;
          await harness.postgres`
            insert into public.profile (
              id,
              profile_type,
              name,
              gender,
              gender_interests,
              orientation,
              orientation_interests,
              relationship_types,
              location,
              country,
              date_of_birth
            )
            values (
              ${profileId},
              'solo',
              ${`Cursor Peer ${index + 1}`},
              'woman',
              array['man']::profile_gender[],
              'heterosexual',
              array['heterosexual']::profile_orientation[],
              array['dating']::profile_relationship_type[],
              st_setsrid(st_makepoint(${longitude}, 60.17), 4326)::geography,
              'FI',
              '1990-01-01'
            )
          `;
        }

        await harness.postgres`
          insert into public.profile_user (profile_id, user_id, role)
          values
            (${actorProfileId}, ${actorUserId}, 'owner'),
            (${peerProfileIds[0]}, ${peerUserId}, 'owner')
        `;

        for (const [index, conversationId] of conversationIds.entries()) {
          await harness.postgres`
            insert into public.chat_conversation (
              id,
              profile_one_id,
              profile_two_id,
              last_message_at,
              created_at,
              updated_at
            )
            values (
              ${conversationId},
              ${actorProfileId},
              ${peerProfileIds[index]!},
              ${tiedTimestamp},
              ${tiedTimestamp},
              ${tiedTimestamp}
            )
          `;
        }

        for (const [index, messageId] of messageIds.entries()) {
          const createdAt = index < 4 ? tiedTimestamp : olderTimestamp;
          await harness.postgres`
            insert into public.chat_message (
              id,
              conversation_id,
              sender_profile_id,
              message_type,
              content,
              created_at,
              updated_at
            )
            values (
              ${messageId},
              ${conversationIds[0]},
              ${actorProfileId},
              'text',
              ${`Cursor message ${index + 1}`},
              ${createdAt},
              ${createdAt}
            )
          `;
        }

        for (const [index, notificationId] of notificationIds.entries()) {
          const createdAt = index < 4 ? tiedTimestamp : olderTimestamp;
          await harness.postgres`
            insert into public.notification (
              id,
              recipient_user_id,
              type,
              title,
              body,
              read_at,
              created_at,
              updated_at
            )
            values (
              ${notificationId},
              ${actorUserId},
              'system',
              ${`Cursor notification ${index + 1}`},
              ${"Cursor pagination fixture"},
              ${index === 1 ? now : null},
              ${createdAt},
              ${createdAt}
            )
          `;
        }

        const feedIds: string[] = [];
        const feedDistances: number[] = [];
        const feedPageSizes: number[] = [];
        let feedCursor: string | undefined;
        do {
          const result = await listProfileFeed({
            cursor: feedCursor,
            limit: 1,
            minAge: 18,
            maxAge: 80,
            profileId: actorProfileId,
            radius: 10,
            userId: actorUserId,
          });
          expect(result.ok).toBeTrue();
          if (!result.ok) throw new Error(result.message);
          expect(result.data.data.length).toBeLessThanOrEqual(1);
          feedIds.push(...result.data.data.map(({ id }) => id));
          feedDistances.push(...result.data.data.map(({ distance }) => distance));
          feedPageSizes.push(result.data.data.length);
          feedCursor = result.data.cursor ?? undefined;
        } while (feedCursor);
        expectExactlyOnce(feedIds, peerProfileIds);
        expect(feedPageSizes).toEqual([1, 1, 1, 1, 1]);
        expect(
          Math.max(
            ...Array.from(
              feedDistances.reduce(
                (counts, distance) => counts.set(distance, (counts.get(distance) ?? 0) + 1),
                new Map<number, number>(),
              ),
            ).map(([, count]) => count),
          ),
        ).toBeGreaterThanOrEqual(3);

        const emptyFeed = await listProfileFeed({
          limit: 1,
          minAge: 18,
          maxAge: 80,
          profileId: actorProfileId,
          profileType: "group",
          radius: 10,
          userId: actorUserId,
        });
        expect(emptyFeed.ok).toBeTrue();
        if (emptyFeed.ok) expect(emptyFeed.data).toEqual({ data: [], cursor: null });

        const conversationIdsSeen: string[] = [];
        const conversationPageSizes: number[] = [];
        let conversationCursor: string | undefined;
        do {
          const result = await listChatConversations({
            cursor: conversationCursor,
            limit: 1,
            profileId: actorProfileId,
            userId: actorUserId,
          });
          expect(result.ok).toBeTrue();
          if (!result.ok) throw new Error(result.message);
          expect(result.data.data.length).toBeLessThanOrEqual(1);
          conversationIdsSeen.push(...result.data.data.map(({ id }) => id));
          conversationPageSizes.push(result.data.data.length);
          conversationCursor = result.data.cursor ?? undefined;
        } while (conversationCursor);
        expectExactlyOnce(conversationIdsSeen, conversationIds);
        expect(conversationPageSizes).toEqual([1, 1, 1, 1, 1]);

        const messageIdsSeen: string[] = [];
        const messagePageSizes: number[] = [];
        let messageCursor: string | undefined;
        do {
          const result = await listChatMessages({
            conversationId: conversationIds[0],
            cursor: messageCursor,
            limit: 1,
            profileId: actorProfileId,
            userId: actorUserId,
          });
          expect(result.ok).toBeTrue();
          if (!result.ok) throw new Error(result.message);
          expect(result.data.data.length).toBeLessThanOrEqual(1);
          messageIdsSeen.push(...result.data.data.map(({ id }) => id));
          messagePageSizes.push(result.data.data.length);
          messageCursor = result.data.cursor ?? undefined;
        } while (messageCursor);
        expectExactlyOnce(messageIdsSeen, messageIds);
        expect(messagePageSizes).toEqual([1, 1, 1, 1, 1]);

        const chronologicalMessageIds: string[] = [];
        const chronologicalPageSizes: number[] = [];
        let chronologicalCursor: string | undefined;
        do {
          const result = await listChatMessages({
            conversationId: conversationIds[0],
            cursor: chronologicalCursor,
            limit: 2,
            profileId: actorProfileId,
            userId: actorUserId,
          });
          if (!result.ok) throw new Error(result.message);
          const pagePositions = result.data.data.map(
            ({ createdAt, id }) => `${createdAt.toISOString()}:${id}`,
          );
          expect(pagePositions).toEqual([...pagePositions].sort());
          chronologicalMessageIds.push(...result.data.data.map(({ id }) => id));
          chronologicalPageSizes.push(result.data.data.length);
          chronologicalCursor = result.data.cursor ?? undefined;
        } while (chronologicalCursor);
        expectExactlyOnce(chronologicalMessageIds, messageIds);
        expect(chronologicalPageSizes).toEqual([2, 2, 1]);

        const emptyMessages = await listChatMessages({
          conversationId: conversationIds[1],
          limit: 1,
          profileId: actorProfileId,
          userId: actorUserId,
        });
        expect(emptyMessages.ok).toBeTrue();
        if (emptyMessages.ok) expect(emptyMessages.data).toEqual({ data: [], cursor: null });

        const notificationIdsSeen: string[] = [];
        const notificationPageSizes: number[] = [];
        let notificationCursor: string | undefined;
        do {
          const result = await listNotifications({
            cursor: notificationCursor,
            limit: 1,
            unreadOnly: false,
            userId: actorUserId,
          });
          expect(result.data.length).toBeLessThanOrEqual(1);
          notificationIdsSeen.push(...result.data.map(({ id }) => id));
          notificationPageSizes.push(result.data.length);
          notificationCursor = result.cursor ?? undefined;
        } while (notificationCursor);
        expectExactlyOnce(notificationIdsSeen, notificationIds);
        expect(notificationPageSizes).toEqual([1, 1, 1, 1, 1]);

        const unreadIds: string[] = [];
        let unreadCursor: string | undefined;
        do {
          const result = await listNotifications({
            cursor: unreadCursor,
            limit: 2,
            unreadOnly: true,
            userId: actorUserId,
          });
          unreadIds.push(...result.data.map(({ id }) => id));
          unreadCursor = result.cursor ?? undefined;
        } while (unreadCursor);
        expectExactlyOnce(
          unreadIds,
          notificationIds.filter((_, index) => index !== 1),
        );

        expect(await listNotifications({ limit: 1, userId: peerUserId })).toEqual({
          data: [],
          cursor: null,
        });

        const firstFeedPage = await listProfileFeed({
          limit: 1,
          minAge: 18,
          maxAge: 80,
          profileId: actorProfileId,
          radius: 10,
          userId: actorUserId,
        });
        if (!firstFeedPage.ok || !firstFeedPage.data.cursor) {
          throw new Error("Expected a feed continuation cursor");
        }
        await expectCursorFailure(() =>
          listProfileFeed({
            cursor: firstFeedPage.data.cursor!,
            limit: 1,
            minAge: 18,
            maxAge: 80,
            profileId: actorProfileId,
            radius: 20,
            userId: actorUserId,
          }),
        );
        await expectCursorFailure(() =>
          listProfileFeed({
            cursor: firstFeedPage.data.cursor!,
            limit: 1,
            minAge: 18,
            maxAge: 80,
            profileId: peerProfileIds[0],
            radius: 10,
            userId: peerUserId,
          }),
        );

        const firstConversationPage = await listChatConversations({
          limit: 1,
          profileId: actorProfileId,
          userId: actorUserId,
        });
        if (!firstConversationPage.ok || !firstConversationPage.data.cursor) {
          throw new Error("Expected a conversation continuation cursor");
        }
        await expectCursorFailure(() =>
          listChatConversations({
            cursor: firstConversationPage.data.cursor!,
            limit: 1,
            profileId: peerProfileIds[0],
            userId: peerUserId,
          }),
        );

        const firstMessagePage = await listChatMessages({
          conversationId: conversationIds[0],
          limit: 1,
          profileId: actorProfileId,
          userId: actorUserId,
        });
        if (!firstMessagePage.ok || !firstMessagePage.data.cursor) {
          throw new Error("Expected a message continuation cursor");
        }
        await expectCursorFailure(() =>
          listChatMessages({
            conversationId: conversationIds[0],
            cursor: firstMessagePage.data.cursor!,
            limit: 1,
            profileId: peerProfileIds[0],
            userId: peerUserId,
          }),
        );
        await expectCursorFailure(() =>
          listChatMessages({
            conversationId: conversationIds[1],
            cursor: firstMessagePage.data.cursor!,
            limit: 1,
            profileId: actorProfileId,
            userId: actorUserId,
          }),
        );

        const firstNotificationPage = await listNotifications({
          limit: 1,
          unreadOnly: false,
          userId: actorUserId,
        });
        if (!firstNotificationPage.cursor) {
          throw new Error("Expected a notification continuation cursor");
        }
        await expectCursorFailure(() =>
          listNotifications({
            cursor: firstNotificationPage.cursor!,
            limit: 1,
            unreadOnly: true,
            userId: actorUserId,
          }),
        );
        await expectCursorFailure(() =>
          listNotifications({
            cursor: firstNotificationPage.cursor!,
            limit: 1,
            unreadOnly: false,
            userId: peerUserId,
          }),
        );
        await expectCursorFailure(() =>
          listNotifications({
            cursor: firstFeedPage.data.cursor!,
            limit: 1,
            unreadOnly: false,
            userId: actorUserId,
          }),
        );
      } finally {
        for (const profileId of [actorProfileId, ...peerProfileIds]) {
          await harness.postgres`delete from public.profile where id = ${profileId}`;
        }
        await harness.postgres`delete from public."user" where id = ${actorUserId}`;
        await harness.postgres`delete from public."user" where id = ${peerUserId}`;
        await harness.cleanup();
      }
    },
    30_000,
  );
});
