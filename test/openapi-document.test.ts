import SwaggerParser from "@apidevtools/swagger-parser";
import { describe, expect, test } from "bun:test";

import { application } from "@/app";
import {
  createMobileOpenApiDocument,
  createOpenApiDocument,
  normalizeOpenApiValue,
} from "@/lib/openapi-document";

type JsonObject = Record<string, any>;

const applicationDocument = createOpenApiDocument(application) as JsonObject;
const mobileDocument = createMobileOpenApiDocument(application) as JsonObject;
const methods = ["delete", "get", "head", "options", "patch", "post", "put", "trace"];

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
])("%s OpenAPI contract", (_name, document) => {
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

  test("has no websocket paths, websocket-only components, or circular placeholders", () => {
    expect(Object.keys(document.paths).some((path) => path.includes("/ws"))).toBeFalse();
    expect(
      Object.keys(document.components.schemas).some((name) => name.includes("Socket")),
    ).toBeFalse();
    expect(JSON.stringify(document).toLowerCase()).not.toContain("circular reference");
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
    }
  });
});

describe("mobile authentication contract", () => {
  test("contains only the curated Better Auth operations", () => {
    const authOperations = getOperations(mobileDocument).filter(({ path }) =>
      path.startsWith("/api/auth/"),
    );
    expect(authOperations.map(({ path, method }) => `${method.toUpperCase()} ${path}`)).toEqual([
      "POST /api/auth/sign-up/email",
      "POST /api/auth/sign-in/email",
      "GET /api/auth/get-session",
      "POST /api/auth/sign-out",
    ]);
    expect(mobileDocument.paths["/api/notifications/test/{userId}"]).toBeUndefined();
  });

  test("marks credential operations public and session operations protected", () => {
    expect(mobileDocument.paths["/api/auth/sign-up/email"].post.security).toEqual([]);
    expect(mobileDocument.paths["/api/auth/sign-in/email"].post.security).toEqual([]);
    expect(mobileDocument.paths["/api/auth/get-session"].get.security).toEqual([
      { bearerAuth: [] },
    ]);
    expect(mobileDocument.paths["/api/auth/sign-out"].post.security).toEqual([{ bearerAuth: [] }]);
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
