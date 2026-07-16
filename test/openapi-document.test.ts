import SwaggerParser from "@apidevtools/swagger-parser";
import { describe, expect, spyOn, test } from "bun:test";
import Elysia from "elysia";

import { application, jsonErrorFallback } from "@/app";
import {
  createMobileOpenApiDocument,
  createOpenApiDocument,
  normalizeOpenApiValue,
  realtimeEnvelopeNames,
} from "@/lib/openapi-document";
import { chatClientCommandRegistry, chatServerEventRegistry } from "@/models/chat";
import {
  notificationClientCommandRegistry,
  notificationServerEventRegistry,
} from "@/models/notification";
import { mobileAuthBackend } from "@/routes/mobile-auth";

type JsonObject = Record<string, any>;

const applicationDocument = createOpenApiDocument(application) as JsonObject;
const mobileDocument = createMobileOpenApiDocument(application) as JsonObject;
const methods = ["delete", "get", "head", "options", "patch", "post", "put", "trace"];
const testUuid = "00000000-0000-4000-8000-000000000000";
const validProfileInsert = {
  name: "Runtime Validator Test",
  profileType: "solo",
  gender: "man",
  genderInterests: ["woman"],
  orientation: "heterosexual",
  orientationInterests: ["heterosexual"],
  relationshipTypes: ["dating"],
  location: { x: 24.94, y: 60.17 },
  dateOfBirth: "1990-01-01",
  country: "FI",
};

describe("OpenAPI value normalization", () => {
  test.each([
    ["string", { format: "uuid", minLength: 4 }],
    ["number", { minimum: 0, maximum: 10 }],
    ["integer", { minimum: 1, maximum: 5 }],
    ["boolean", { default: false }],
    ["array", { items: { type: "string" }, minItems: 1 }],
    ["object", { properties: { value: { type: "string" } } }],
  ])("rewrites nullable %s schemas to native OpenAPI 3.1 types", (type, constraints) => {
    const normalized = normalizeOpenApiValue({
      description: "Preserved description",
      default: type === "string" ? "value" : undefined,
      anyOf: [{ type, ...constraints }, { type: "null" }],
    });

    expect(normalized).toEqual({
      description: "Preserved description",
      default: type === "string" ? "value" : undefined,
      ...constraints,
      type: [type, "null"],
    });
  });

  test("preserves formatted enum constraints while normalizing nullability", () => {
    expect(
      normalizeOpenApiValue({
        anyOf: [
          {
            type: "string",
            format: "custom-format",
            enum: ["one", "two"],
            minLength: 3,
          },
          { type: "null" },
        ],
      }),
    ).toEqual({
      type: ["string", "null"],
      format: "custom-format",
      enum: ["one", "two"],
      minLength: 3,
    });
  });

  test("normalizes nullable TypeBox dates without dropping null", () => {
    expect(
      normalizeOpenApiValue({
        anyOf: [{ type: "Date" }, { type: "null" }],
      }),
    ).toEqual({
      type: ["string", "null"],
      format: "date-time",
    });
  });

  test("does not modify genuine non-null unions", () => {
    const union = {
      description: "A real union",
      anyOf: [{ type: "string" }, { type: "number" }],
    };
    expect(normalizeOpenApiValue(union)).toEqual(union);
  });

  test("publishes post-coercion numeric and boolean schemas", () => {
    expect(
      normalizeOpenApiValue({
        minimum: 1,
        maximum: 100,
        multipleOf: 1,
        anyOf: [
          { type: "string", format: "numeric", default: 0 },
          { type: "number", minimum: 1, maximum: 100, multipleOf: 1 },
        ],
      }),
    ).toEqual({ type: "integer", minimum: 1, maximum: 100, multipleOf: 1 });

    expect(
      normalizeOpenApiValue({
        minimum: 0,
        anyOf: [
          { type: "string", format: "numeric", default: 0 },
          { type: "number", minimum: 0 },
        ],
      }),
    ).toEqual({ type: "number", minimum: 0 });

    expect(
      normalizeOpenApiValue({
        minimum: 0,
        anyOf: [
          { type: "string", format: "integer", default: 0 },
          { type: "integer", minimum: 0 },
        ],
      }),
    ).toEqual({ type: "integer", minimum: 0 });

    expect(
      normalizeOpenApiValue({
        anyOf: [{ type: "boolean" }, { type: "string", format: "boolean", default: false }],
      }),
    ).toEqual({ type: "boolean" });
  });
});

describe.each([
  ["application", applicationDocument],
  ["mobile", mobileDocument],
])("%s OpenAPI contract", (name, document) => {
  test("is valid OpenAPI 3.1", async () => {
    expect(document.openapi).toBe("3.1.0");
    await expect(SwaggerParser.validate(structuredClone(document) as any)).resolves.toBeDefined();
  });

  test("has unique stable operation IDs", () => {
    const operations = getOperations(document);
    const operationIds = operations.map(({ operation }) => operation.operationId);
    expect(operationIds.every((operationId) => typeof operationId === "string")).toBeTrue();
    expect(new Set(operationIds).size).toBe(operationIds.length);
  });

  test("advertises only JSON for object request bodies", () => {
    for (const { operation } of getOperations(document)) {
      if (!operation.requestBody) continue;
      expect(Object.keys(operation.requestBody.content)).toEqual(["application/json"]);
    }
  });

  test("contains no legacy null or coercion unions", () => {
    walk(document, (value) => {
      if (!isObject(value)) return;
      expect(value.nullable).toBeUndefined();

      if (!Array.isArray(value.anyOf)) return;
      expect(
        value.anyOf.some((candidate: unknown) => isObject(candidate) && candidate.type === "null"),
      ).toBeFalse();
      expect(isNumericCoercionUnion(value.anyOf)).toBeFalse();
      expect(isBooleanCoercionUnion(value.anyOf)).toBeFalse();
    });
  });

  test("has no websocket paths, legacy socket components, or circular placeholders", () => {
    expect(Object.keys(document.paths).some((path) => path.includes("/ws"))).toBeFalse();
    expect(
      Object.keys(document.components.schemas).some((name) => name.includes("Socket")),
    ).toBeFalse();
    expect(JSON.stringify(document).toLowerCase()).not.toContain("circular reference");
  });

  test("deliberately publishes registry-backed realtime schemas only for mobile codegen", () => {
    const realtimeSchemaNames = [
      ...realtimeEnvelopeNames,
      ...chatClientCommandRegistry.map(({ name }) => name),
      ...chatServerEventRegistry.map(({ name }) => name),
      ...notificationClientCommandRegistry.map(({ name }) => name),
      ...notificationServerEventRegistry.map(({ name }) => name),
    ];
    const publishedNames = realtimeSchemaNames.filter(
      (schemaName) => document.components.schemas[schemaName] !== undefined,
    );

    expect(publishedNames).toEqual(name === "mobile" ? realtimeSchemaNames : []);
  });

  test("has no dangling local component references", () => {
    walk(document.paths, (value) => {
      if (!isObject(value) || typeof value.$ref !== "string") return;
      const match = value.$ref.match(/^#\/components\/([^/]+)\/(.+)$/);
      if (!match) return;
      expect(document.components[match[1]!]?.[match[2]!]).toBeDefined();
    });
  });

  test("documents shared JSON errors for protected operations", () => {
    for (const { operation } of getOperations(document)) {
      if (!Array.isArray(operation.security) || operation.security.length === 0) continue;
      expect(operation.security).toEqual([{ bearerAuth: [] }]);
      expect(operation.responses["401"]).toBeDefined();
      expect(operation.responses["500"]).toBeDefined();
    }
  });

  test("uses the shared error shape for documented application failures", () => {
    const errorStatuses = new Set(["400", "401", "403", "404", "409", "422", "500"]);
    for (const { operation } of getOperations(document)) {
      for (const [status, response] of Object.entries(operation.responses as JsonObject)) {
        if (!errorStatuses.has(status)) continue;
        const reference = (response as JsonObject).content?.["application/json"]?.schema?.$ref;
        expect([
          "#/components/schemas/ApiErrorResponse",
          "#/components/schemas/AuthErrorResponse",
        ]).toContain(reference);
      }
    }
  });
});

describe("published OpenAPI endpoints", () => {
  test.each(["/openapi/internal.json", "/openapi/json", "/openapi/mobile.json"])(
    "serves %s as OpenAPI 3.1",
    async (path) => {
      const response = await application.handle(new Request(`http://localhost${path}`));
      expect(response.status).toBe(200);
      expect((await response.json()).openapi).toBe("3.1.0");
    },
  );
});

describe("mobile realtime component contract", () => {
  test("reuses the required nullable Notification payload for read events", () => {
    const event = mobileDocument.components.schemas.NotificationReadEvent;

    expect(event.required).toContain("notification");
    expect(event.properties.notification).toEqual({
      $ref: "#/components/schemas/Notification",
      type: ["object", "null"],
    });
    expect(event.properties.notification.properties).toBeUndefined();
  });
});

describe("application DTO contract", () => {
  test("keeps lastMessage optional and non-null", () => {
    const schema = applicationDocument.components.schemas.ChatConversation;
    expect(schema.required).not.toContain("lastMessage");
    expect(schema.properties.lastMessage).toEqual({
      $ref: "#/components/schemas/ChatConversationLastMessage",
    });
  });

  test("uses optional non-null input fields where omission has the same meaning as null", () => {
    const fields = [
      ["ProfileInsert", "bio"],
      ["ProfileUpdate", "bio"],
      ["ChatMessageInsert", "replyToMessageId"],
      ["ChatConversationReadUpdate", "messageId"],
      ["PushTokenInsert", "deviceId"],
    ];

    for (const [schemaName, propertyName] of fields) {
      const schema = applicationDocument.components.schemas[schemaName!];
      const property = schema.properties[propertyName!];
      expect(schema.required ?? []).not.toContain(propertyName!);
      expect(acceptsNull(property)).toBeFalse();
    }
  });

  test("publishes concrete post-coercion query parameter types", () => {
    const expectedTypes: Record<string, string> = {
      radius: "number",
      minAge: "integer",
      maxAge: "integer",
      cursor: "number",
      limit: "integer",
      unreadOnly: "boolean",
    };

    for (const { operation } of getOperations(applicationDocument)) {
      for (const parameter of operation.parameters ?? []) {
        if (parameter.in !== "query" || expectedTypes[parameter.name] === undefined) continue;
        if (parameter.name === "cursor" && parameter.schema.format === "date-time") continue;
        expect(parameter.schema.type).toBe(expectedTypes[parameter.name]);
      }
    }
  });

  test("references reusable enum components from profile input and output models", () => {
    for (const schemaName of ["Profile", "ProfileInsert", "ProfileUpdate"]) {
      const schema = applicationDocument.components.schemas[schemaName];
      expect(schema.properties.profileType.$ref).toBe("#/components/schemas/ProfileType");
      expect(schema.properties.gender.$ref).toBe("#/components/schemas/ProfilePrimaryGender");
      expect(schema.properties.orientation.$ref).toBe("#/components/schemas/ProfileOrientation");
      expect(schema.properties.genderInterests.items.$ref).toBe(
        "#/components/schemas/ProfileGender",
      );
      expect(schema.properties.orientationInterests.items.$ref).toBe(
        "#/components/schemas/ProfileOrientation",
      );
      expect(schema.properties.relationshipTypes.items.$ref).toBe(
        "#/components/schemas/ProfileRelationshipType",
      );
    }

    expect(
      applicationDocument.components.schemas.ProfileReactionStatus.properties.reaction.$ref,
    ).toBe("#/components/schemas/ProfileReactionType");
    expect(applicationDocument.components.schemas.ChatMessage.properties.messageType.$ref).toBe(
      "#/components/schemas/ChatMessageType",
    );
    expect(applicationDocument.components.schemas.Notification.properties.type.$ref).toBe(
      "#/components/schemas/NotificationType",
    );
    expect(applicationDocument.components.schemas.PushToken.properties.platform.$ref).toBe(
      "#/components/schemas/DevicePlatform",
    );
    expect(applicationDocument.components.schemas.PushToken.properties.provider.$ref).toBe(
      "#/components/schemas/PushProvider",
    );
  });
});

describe("application runtime validation", () => {
  test.each([
    [
      "POST /api/profile/",
      new Request("http://localhost/api/profile/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validProfileInsert),
      }),
    ],
    [
      "PATCH /api/profile/{id}",
      new Request(`http://localhost/api/profile/${testUuid}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bio: "" }),
      }),
    ],
    [
      "GET /api/profile/{profileId}/feed",
      new Request(`http://localhost/api/profile/${testUuid}/feed?radius=10&minAge=18&maxAge=30`),
    ],
    [
      "POST /api/notifications/push-tokens",
      new Request("http://localhost/api/notifications/push-tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "test-push-token", platform: "ios" }),
      }),
    ],
  ])("compiles concrete validators for %s", async (_operation, request) => {
    const response = await application.handle(request);
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-type")).not.toContain("text/html");
    expect(body).not.toContain("Unable to dereference schema");
  });

  test("contains no OpenAPI component references in registered runtime models", () => {
    const runtimeModels = (application as any).definitions.type;
    expect(findOpenApiComponentReferences(runtimeModels)).toEqual([]);
  });

  test("returns a production-safe JSON response for unexpected failures", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    const failingApplication = new Elysia().onError(jsonErrorFallback).get("/failure", () => {
      throw new Error("sensitive diagnostic details");
    });

    try {
      const response = await failingApplication.handle(new Request("http://localhost/failure"));

      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual({
        code: "internal_server_error",
        message: "An unexpected server error occurred",
      });
    } finally {
      errorLog.mockRestore();
    }
  });
});

describe("mobile authentication contract", () => {
  test("contains only the curated Better Auth operations", () => {
    const authOperations = getOperations(mobileDocument).filter(({ path }) =>
      path.includes("/auth/"),
    );
    expect(authOperations.map(({ path, method }) => `${method.toUpperCase()} ${path}`)).toEqual([
      "POST /api/auth/sign-up/email",
      "POST /api/auth/sign-in/email",
      "GET /api/mobile/auth/session",
      "POST /api/mobile/auth/sign-out",
    ]);
    expect(mobileDocument.paths["/api/auth/get-session"]).toBeUndefined();
    expect(mobileDocument.paths["/api/auth/sign-out"]).toBeUndefined();
    expect(mobileDocument.paths["/api/notifications/test/{userId}"]).toBeUndefined();
  });

  test("marks credential operations public and session operations protected", () => {
    expect(mobileDocument.paths["/api/auth/sign-up/email"].post.security).toEqual([]);
    expect(mobileDocument.paths["/api/auth/sign-in/email"].post.security).toEqual([]);
    expect(mobileDocument.paths["/api/mobile/auth/session"].get.security).toEqual([
      { bearerAuth: [] },
    ]);
    expect(mobileDocument.paths["/api/mobile/auth/sign-out"].post.security).toEqual([
      { bearerAuth: [] },
    ]);
  });

  test("publishes non-null session success and typed unauthorized responses", () => {
    const sessionSchema = mobileDocument.components.schemas.AuthSessionResponse;
    expect(sessionSchema.type).toBe("object");
    expect(acceptsNull(sessionSchema)).toBeFalse();
    expect(sessionSchema.required).toEqual(["session", "user"]);

    const sessionOperation = mobileDocument.paths["/api/mobile/auth/session"].get;
    expect(sessionOperation.responses["200"].content["application/json"].schema.$ref).toBe(
      "#/components/schemas/AuthSessionResponse",
    );
    expect(sessionOperation.responses["401"].content["application/json"].schema.$ref).toBe(
      "#/components/schemas/AuthErrorResponse",
    );

    const signOutOperation = mobileDocument.paths["/api/mobile/auth/sign-out"].post;
    expect(signOutOperation.responses["200"].content["application/json"].schema.$ref).toBe(
      "#/components/schemas/AuthSignOutResponse",
    );
    expect(signOutOperation.responses["401"].content["application/json"].schema.$ref).toBe(
      "#/components/schemas/AuthErrorResponse",
    );

    const authError = mobileDocument.components.schemas.AuthErrorResponse;
    expect(authError.required).toEqual(["code", "message"]);
  });

  test("documents the canonical set-auth-token response header", () => {
    for (const path of ["/api/auth/sign-up/email", "/api/auth/sign-in/email"]) {
      const header = mobileDocument.paths[path].post.responses["200"].headers["set-auth-token"];
      expect(header.required).toBeTrue();
      expect(header.schema).toEqual({ type: "string" });
    }
  });

  test("requires always-present auth identifiers", () => {
    expect(mobileDocument.components.schemas.AuthUser.required).toContain("id");
    expect(mobileDocument.components.schemas.AuthSession.required).toContain("id");
    expect(mobileDocument.components.schemas.AuthSession.required).toContain("userId");
  });
});

describe("mobile authentication runtime adapters", () => {
  test.each([
    ["missing", undefined],
    ["invalid", "invalid.signature"],
  ])("session returns JSON 401 when the bearer token is %s", async (_name, token) => {
    const response = await application.handle(mobileAuthRequest("/session", "GET", token));

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      code: "UNAUTHORIZED",
      message: "A valid active bearer token is required",
    });
  });

  test("session returns a non-null response for a valid active bearer token", async () => {
    const getSession = spyOn(mobileAuthBackend, "getSession").mockResolvedValue(
      activeSessionFixture,
    );

    try {
      const response = await application.handle(
        mobileAuthRequest("/session", "GET", "active-session-token"),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).not.toBeNull();
      expect(body.session.id).toBe(activeSessionFixture.session.id);
      expect(body.user.id).toBe(activeSessionFixture.user.id);
    } finally {
      getSession.mockRestore();
    }
  });

  test.each([
    ["missing", undefined],
    ["invalid", "invalid.signature"],
  ])("sign-out returns JSON 401 when the bearer token is %s", async (_name, token) => {
    const response = await application.handle(mobileAuthRequest("/sign-out", "POST", token));

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      code: "UNAUTHORIZED",
      message: "A valid active bearer token is required",
    });
  });

  test("sign-out returns success after validating an active bearer token", async () => {
    const getSession = spyOn(mobileAuthBackend, "getSession").mockResolvedValue(
      activeSessionFixture,
    );
    const signOut = spyOn(mobileAuthBackend, "signOut").mockResolvedValue({ success: true });

    try {
      const response = await application.handle(
        mobileAuthRequest("/sign-out", "POST", "active-session-token"),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true });
      expect(signOut).toHaveBeenCalledTimes(1);
    } finally {
      getSession.mockRestore();
      signOut.mockRestore();
    }
  });
});

const fixtureDate = new Date("2026-07-15T12:00:00.000Z");
const activeSessionFixture = {
  session: {
    id: "session-id",
    expiresAt: new Date("2026-07-22T12:00:00.000Z"),
    token: "active-session-token",
    createdAt: fixtureDate,
    updatedAt: fixtureDate,
    ipAddress: null,
    userAgent: null,
    userId: "user-id",
  },
  user: {
    id: "user-id",
    name: "Mobile Test User",
    email: "mobile-test@example.com",
    emailVerified: true,
    image: null,
    createdAt: fixtureDate,
    updatedAt: fixtureDate,
  },
};

function mobileAuthRequest(path: "/session" | "/sign-out", method: "GET" | "POST", token?: string) {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);

  return new Request(`http://localhost/api/mobile/auth${path}`, { method, headers });
}

function findOpenApiComponentReferences(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((child, index) =>
      findOpenApiComponentReferences(child, `${path}[${index}]`),
    );
  }
  if (!isObject(value)) return [];

  const references =
    typeof value.$ref === "string" && value.$ref.startsWith("#/components/") ? [path] : [];
  return references.concat(
    Object.entries(value).flatMap(([key, child]) =>
      findOpenApiComponentReferences(child, `${path}.${key}`),
    ),
  );
}

function getOperations(document: JsonObject) {
  const operations: Array<{ path: string; method: string; operation: JsonObject }> = [];
  for (const [path, pathItem] of Object.entries(document.paths as JsonObject)) {
    for (const method of methods) {
      const operation = (pathItem as JsonObject)[method];
      if (isObject(operation)) operations.push({ path, method, operation });
    }
  }
  return operations;
}

function walk(value: unknown, visit: (value: unknown) => void) {
  visit(value);
  if (Array.isArray(value)) {
    for (const child of value) walk(child, visit);
    return;
  }
  if (!isObject(value)) return;
  for (const child of Object.values(value)) walk(child, visit);
}

function acceptsNull(schema: JsonObject) {
  return (
    schema.type === "null" ||
    (Array.isArray(schema.type) && schema.type.includes("null")) ||
    (Array.isArray(schema.anyOf) &&
      schema.anyOf.some((candidate: unknown) => isObject(candidate) && candidate.type === "null"))
  );
}

function isNumericCoercionUnion(candidates: unknown[]) {
  return (
    candidates.some(
      (candidate) =>
        isObject(candidate) &&
        candidate.type === "string" &&
        (candidate.format === "numeric" || candidate.format === "integer"),
    ) &&
    candidates.some(
      (candidate) =>
        isObject(candidate) && (candidate.type === "number" || candidate.type === "integer"),
    )
  );
}

function isBooleanCoercionUnion(candidates: unknown[]) {
  return (
    candidates.some(
      (candidate) =>
        isObject(candidate) && candidate.type === "string" && candidate.format === "boolean",
    ) && candidates.some((candidate) => isObject(candidate) && candidate.type === "boolean")
  );
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
