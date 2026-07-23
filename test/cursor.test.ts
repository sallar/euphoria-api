import { describe, expect, test } from "bun:test";
import Elysia from "elysia";

import {
  CURSOR_ERROR_CODE,
  CURSOR_ERROR_MESSAGE,
  CursorError,
  createCursorCodec,
} from "@/lib/cursor";

const currentSecret = "cursor-test-secret-current";
const previousSecret = "cursor-test-secret-previous";
const codec = createCursorCodec({ signingSecrets: [currentSecret] });
const profileId = "10000000-0000-4000-8000-000000000001";
const conversationId = "20000000-0000-4000-8000-000000000001";
const messageId = "30000000-0000-4000-8000-000000000001";
const notificationId = "40000000-0000-4000-8000-000000000001";

const expectCursorError = (operation: () => unknown, reason: CursorError["reason"]) => {
  try {
    operation();
    throw new Error("Expected cursor decoding to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(CursorError);
    expect((error as CursorError).reason).toBe(reason);
    expect((error as CursorError).status).toBe(400);
    expect((error as CursorError).message).toBe(CURSOR_ERROR_MESSAGE);
  }
};

describe("shared cursor codec", () => {
  test("round-trips every resource's complete normalized tuple", () => {
    const cases = [
      {
        resource: "profile-feed" as const,
        context: {
          userId: "feed-user",
          profileId,
          radiusMeters: 25_000,
          minAge: 21,
          maxAge: 45,
          profileType: "solo",
        },
        sort: { distanceMeters: 1234.567, profileId },
      },
      {
        resource: "chat-conversations" as const,
        context: { userId: "chat-user", profileId },
        sort: { sortAtMicros: "1784808000123456", conversationId },
      },
      {
        resource: "chat-messages" as const,
        context: { userId: "chat-user", profileId, conversationId },
        sort: { createdAtMicros: "1784808000123456", messageId },
      },
      {
        resource: "notifications" as const,
        context: { userId: "notification-user", unreadOnly: true },
        sort: { createdAtMicros: "1784808000123456", notificationId },
      },
    ];

    for (const input of cases) {
      const cursor = codec.encode({ ...input, direction: "next" } as never);
      expect(
        codec.decode({
          cursor,
          resource: input.resource,
          direction: "next",
          context: input.context,
        } as never),
      ).toEqual(input.sort);
    }
  });

  test("protects version, resource, direction, sort tuple, and a non-raw context fingerprint", () => {
    const context = {
      userId: "sensitive-user-scope",
      profileId,
      unreadOnly: false,
    };
    const cursor = codec.encode({
      resource: "chat-conversations",
      direction: "next",
      context,
      sort: { sortAtMicros: "1784808000123456", conversationId },
    });
    const [, encodedPayload] = cursor.split(".");
    const payload = JSON.parse(Buffer.from(encodedPayload!, "base64url").toString("utf8"));

    expect(payload).toEqual({
      version: 1,
      resource: "chat-conversations",
      direction: "next",
      sort: {
        sortAtMicros: "1784808000123456",
        conversationId,
      },
      fingerprint: expect.any(String),
    });
    expect(payload.fingerprint).not.toContain(context.userId);
    expect(JSON.stringify(payload)).not.toContain(context.userId);
  });

  test("rejects malformed, tampered, and unsupported-version cursors", () => {
    const input = {
      resource: "notifications" as const,
      direction: "next" as const,
      context: { userId: "notification-user", unreadOnly: false },
      sort: { createdAtMicros: "1784808000123456", notificationId },
    };
    const cursor = codec.encode(input);
    const parts = cursor.split(".");
    const payload = parts[1]!;
    const replacement = payload[0] === "A" ? "B" : "A";
    const tampered = `${parts[0]}.${replacement}${payload.slice(1)}.${parts[2]}`;

    expectCursorError(() => codec.decode({ ...input, cursor: "not-a-cursor" }), "malformed");
    expectCursorError(() => codec.decode({ ...input, cursor: tampered }), "tampered");
    expectCursorError(
      () => codec.decode({ ...input, cursor: cursor.replace(/^c1\./, "c2.") }),
      "unsupported_version",
    );
  });

  test("rejects resource, direction, authorization scope, and filter mismatches", () => {
    const context = { userId: "notification-user", unreadOnly: false };
    const cursor = codec.encode({
      resource: "notifications",
      direction: "next",
      context,
      sort: { createdAtMicros: "1784808000123456", notificationId },
    });

    expectCursorError(
      () =>
        codec.decode({
          cursor,
          resource: "chat-messages",
          direction: "next",
          context: { userId: "notification-user", profileId, conversationId },
        }),
      "resource_mismatch",
    );
    expectCursorError(
      () =>
        codec.decode({
          cursor,
          resource: "notifications",
          direction: "previous",
          context,
        }),
      "direction_mismatch",
    );
    expectCursorError(
      () =>
        codec.decode({
          cursor,
          resource: "notifications",
          direction: "next",
          context: { userId: "another-user", unreadOnly: false },
        }),
      "context_mismatch",
    );
    expectCursorError(
      () =>
        codec.decode({
          cursor,
          resource: "notifications",
          direction: "next",
          context: { userId: "notification-user", unreadOnly: true },
        }),
      "context_mismatch",
    );
  });

  test("accepts cursors signed with a configured previous key during rotation", () => {
    const previousCodec = createCursorCodec({ signingSecrets: [previousSecret] });
    const rotatedCodec = createCursorCodec({
      signingSecrets: [currentSecret, previousSecret],
    });
    const input = {
      resource: "profile-feed" as const,
      direction: "next" as const,
      context: {
        userId: "feed-user",
        profileId,
        radiusMeters: 10_000,
        minAge: 18,
        maxAge: 80,
        profileType: null,
      },
      sort: { distanceMeters: 0, profileId },
    };
    const cursor = previousCodec.encode(input);

    expect(rotatedCodec.decode({ ...input, cursor })).toEqual(input.sort);
  });

  test("returns the same documented 400 body for every cursor failure", async () => {
    const app = new Elysia().get("/", () => {
      codec.decode({
        cursor: "malformed",
        resource: "notifications",
        direction: "next",
        context: { userId: "notification-user", unreadOnly: false },
      });
    });

    const response = await app.handle(new Request("http://localhost/"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: CURSOR_ERROR_CODE,
      message: CURSOR_ERROR_MESSAGE,
    });
  });
});
