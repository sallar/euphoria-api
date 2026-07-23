import { describe, expect, test } from "bun:test";

import {
  CHAT_MESSAGE_SEND_COMMAND_NAME,
  CHAT_MESSAGE_SEND_COMMAND_VERSION,
  NOTIFICATION_PUSH_DELIVERY_JOB_KIND,
  NOTIFICATION_PUSH_DELIVERY_JOB_VERSION,
  readTransactionalChatPolicy,
} from "@/config/transactional-chat-policy";
import { isCanonicalMessageIdempotencyKey } from "@/services/chat-service";

describe("transactional chat producer policy", () => {
  test("loads only explicit reviewed command, event, and job inputs", () => {
    expect(
      readTransactionalChatPolicy({
        CHAT_COMMAND_RETENTION_SECONDS: "2592000",
        CHAT_EVENT_RETENTION_SECONDS: "2592000",
        NOTIFICATION_PUSH_JOB_AVAILABLE_IN_SECONDS: "0",
        NOTIFICATION_PUSH_JOB_MAX_ATTEMPTS: "8",
        NOTIFICATION_PUSH_JOB_TERMINAL_RETENTION_SECONDS: "2592000",
      }),
    ).toEqual({
      commandRetentionSeconds: 2_592_000,
      eventRetentionSeconds: 2_592_000,
      pushJobAvailableInSeconds: 0,
      pushJobMaxAttempts: 8,
      pushJobTerminalRetentionSeconds: 2_592_000,
    });
    expect(CHAT_MESSAGE_SEND_COMMAND_NAME).toBe("chat.message.send");
    expect(CHAT_MESSAGE_SEND_COMMAND_VERSION).toBe(1);
    expect(NOTIFICATION_PUSH_DELIVERY_JOB_KIND).toBe("notification.push.deliver");
    expect(NOTIFICATION_PUSH_DELIVERY_JOB_VERSION).toBe(1);
  });

  test("fails closed when any producer policy input is absent or invalid", () => {
    expect(() => readTransactionalChatPolicy({})).toThrow(
      "CHAT_COMMAND_RETENTION_SECONDS must be explicitly configured",
    );
    expect(() =>
      readTransactionalChatPolicy({
        CHAT_COMMAND_RETENTION_SECONDS: "2592000",
        CHAT_EVENT_RETENTION_SECONDS: "2592000",
        NOTIFICATION_PUSH_JOB_AVAILABLE_IN_SECONDS: "-1",
        NOTIFICATION_PUSH_JOB_MAX_ATTEMPTS: "8",
        NOTIFICATION_PUSH_JOB_TERMINAL_RETENTION_SECONDS: "2592000",
      }),
    ).toThrow("NOTIFICATION_PUSH_JOB_AVAILABLE_IN_SECONDS must be explicitly configured");
  });

  test("accepts only canonical lowercase RFC 4122 UUID command keys", () => {
    expect(isCanonicalMessageIdempotencyKey("a0000000-0000-4000-8000-000000000042")).toBeTrue();
    expect(
      isCanonicalMessageIdempotencyKey("a0000000-0000-4000-8000-000000000042".toUpperCase()),
    ).toBeFalse();
    expect(isCanonicalMessageIdempotencyKey("not-a-uuid")).toBeFalse();
    expect(isCanonicalMessageIdempotencyKey("00000000-0000-0000-0000-000000000000")).toBeFalse();
  });
});
