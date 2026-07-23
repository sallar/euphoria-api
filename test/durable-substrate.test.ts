import { describe, expect, test } from "bun:test";

import {
  canonicalizeCommandRequest,
  createCommandRequestFingerprint,
} from "@/services/command-idempotency-service";
import { sanitizeDeliveryJobFailureCode } from "@/services/delivery-job-service";

describe("F3 durable substrate pure helpers", () => {
  test("normalizes JSON object keys recursively before fingerprinting", () => {
    const first = {
      z: [3, { b: true, a: null }],
      a: {
        second: "value",
        first: 1,
      },
    };
    const second = {
      a: {
        first: 1,
        second: "value",
      },
      z: [3, { a: null, b: true }],
    };

    expect(canonicalizeCommandRequest(first)).toBe(canonicalizeCommandRequest(second));
    expect(
      createCommandRequestFingerprint({
        commandName: "fixture.command",
        commandVersion: 1,
        normalizedRequest: first,
      }),
    ).toBe(
      createCommandRequestFingerprint({
        commandName: "fixture.command",
        commandVersion: 1,
        normalizedRequest: second,
      }),
    );
  });

  test("binds fingerprints to command identity and rejects non-JSON inputs", () => {
    const normalizedRequest = { value: "same" };
    const versionOne = createCommandRequestFingerprint({
      commandName: "fixture.command",
      commandVersion: 1,
      normalizedRequest,
    });
    const versionTwo = createCommandRequestFingerprint({
      commandName: "fixture.command",
      commandVersion: 2,
      normalizedRequest,
    });

    expect(versionOne).not.toBe(versionTwo);
    expect(() => canonicalizeCommandRequest({ value: Number.NaN })).toThrow(
      "Command fingerprint input must be finite",
    );
  });

  test("stores only a bounded machine-readable failure code", () => {
    expect(
      sanitizeDeliveryJobFailureCode({
        code: "provider.timeout",
        authorization: "Bearer secret-token",
        body: {
          password: "private",
        },
      }),
    ).toBe("provider.timeout");
    expect(
      sanitizeDeliveryJobFailureCode({
        code: "Bearer secret-token",
        body: "private request",
      }),
    ).toBe("unspecified_failure");
    expect(sanitizeDeliveryJobFailureCode(new Error("password=private"))).toBe(
      "unspecified_failure",
    );
  });
});
