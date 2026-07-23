import type { AnyElysia } from "elysia";

import { toOpenAPISchema } from "@elysia/openapi";

import type { RealtimeSchemaVariant } from "@/models/realtime";

import { chatClientCommandRegistry, chatServerEventRegistry } from "@/models/chat";
import { namedEnumSchemas } from "@/models/enums";
import {
  notificationClientCommandRegistry,
  notificationServerEventRegistry,
} from "@/models/notification";

type OpenApiObject = Record<string, unknown>;

const httpMethods = new Set(["delete", "get", "head", "options", "patch", "post", "put", "trace"]);
const errorStatusDescriptions: Record<string, string> = {
  "400": "Bad request",
  "401": "Authentication is required or the bearer token is invalid",
  "403": "The authenticated user is not allowed to perform this operation",
  "404": "The requested resource was not found",
  "409": "The request conflicts with the current resource state",
  "422": "The request did not satisfy the operation schema",
  "500": "An unexpected server error occurred",
};

export const openApiInfo = {
  title: "Euphoria API",
  description: "Canonical REST API contract for Euphoria clients",
  version: "2026-07-24",
} as const;

export const realtimeEnvelopeRegistries = {
  ChatClientCommand: chatClientCommandRegistry,
  ChatServerEvent: chatServerEventRegistry,
  NotificationClientCommand: notificationClientCommandRegistry,
  NotificationServerEvent: notificationServerEventRegistry,
} as const;

export const realtimeEnvelopeNames = Object.keys(realtimeEnvelopeRegistries);

export function createOpenApiDocument(app: AnyElysia): OpenApiObject {
  return pruneUnreachableComponents(createUnprunedOpenApiDocument(app));
}

export function createMobileOpenApiDocument(app: AnyElysia): OpenApiObject {
  const document = structuredClone(createUnprunedOpenApiDocument(app));
  const paths = asRecord(document.paths);
  delete paths["/api/notifications/test/{userId}"];
  Object.assign(paths, authPaths);
  document.paths = paths;

  const components = asRecord(document.components);
  components.schemas = {
    ...asRecord(components.schemas),
    ...authSchemas,
  };
  document.components = components;
  document.info = {
    ...openApiInfo,
    title: "Euphoria Mobile API",
    description:
      "Application REST API, supported Better Auth mobile operations, and schema-only realtime message components",
  };

  return pruneUnreachableComponents(document, { schemaRoots: realtimeEnvelopeNames });
}

export function createRealtimeSchemaComponents(app: AnyElysia): OpenApiObject {
  const document = createUnprunedOpenApiDocument(app);
  document.paths = {};
  const realtimeDocument = pruneUnreachableComponents(document, {
    schemaRoots: realtimeEnvelopeNames,
  });

  return asRecord(asRecord(realtimeDocument.components).schemas);
}

function createUnprunedOpenApiDocument(app: AnyElysia): OpenApiObject {
  const schema = toOpenAPISchema(app, {
    methods: ["options", "ws"],
  });

  const document = normalizeOpenApiValue({
    openapi: "3.1.0",
    info: openApiInfo,
    ...schema,
  }) as OpenApiObject;

  addNamedEnumComponents(document);
  deduplicateComponentSchemas(document);
  addRealtimeEnvelopeComponents(document);
  addBearerSecurityScheme(document);
  addStandardApplicationErrors(document);
  addChatMessageCommandHeaders(document);

  // Deduplication can introduce component references inside nullable unions,
  // so normalize once more after all exporter-owned rewrites are complete.
  return normalizeOpenApiValue(document) as OpenApiObject;
}

function addChatMessageCommandHeaders(document: OpenApiObject) {
  const operation = asRecord(
    asRecord(
      asRecord(document.paths)[
        "/api/chat/profiles/{profileId}/conversations/{conversationId}/messages"
      ],
    ).post,
  );
  const responses = asRecord(operation.responses);
  const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
  operation.parameters = [
    ...parameters,
    {
      in: "header",
      name: "Idempotency-Key",
      required: true,
      description: "Canonical lowercase RFC 4122 UUID scoped to chat.message.send.",
      schema: {
        type: "string",
        format: "uuid",
        pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
      },
    },
  ];

  for (const status of ["201", "404", "409", "422"]) {
    const response = asRecord(responses[status]);
    response.headers = {
      ...asRecord(response.headers),
      "Idempotency-Replayed": {
        required: true,
        description:
          "Whether this terminal command result was loaded from the persisted idempotency record.",
        schema: { type: "boolean" },
      },
    };
    responses[status] = response;
  }

  operation.responses = responses;
}

export function normalizeOpenApiValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeOpenApiValue);
  }

  if (!isRecord(value)) {
    return value;
  }

  if (isTypeBoxDateUnion(value)) {
    const { $id: _id, anyOf: _anyOf, nullable, type: _type, ...metadata } = value;
    const normalizedMetadata = normalizeOpenApiValue(metadata) as OpenApiObject;

    return {
      ...normalizedMetadata,
      type: nullable === true ? ["string", "null"] : "string",
      format: "date-time",
    };
  }

  if (value.type === "Date") {
    const { $id: _id, nullable, type: _type, ...metadata } = value;
    const normalizedMetadata = normalizeOpenApiValue(metadata) as OpenApiObject;

    return {
      ...normalizedMetadata,
      type: nullable === true ? ["string", "null"] : "string",
      format: "date-time",
    };
  }

  const wasNullable = value.nullable === true;
  const normalized = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "$id" && key !== "nullable")
      .map(([key, child]) => [key, normalizeOpenApiValue(child)]),
  );

  const coercionSchema = normalizeCoercionUnion(normalized);
  if (coercionSchema) return coercionSchema;

  const nullableUnion = normalizeSimpleNullableUnion(normalized);
  if (nullableUnion) return nullableUnion;

  if (wasNullable && isSimpleType(normalized.type)) {
    return {
      ...normalized,
      type: [normalized.type, "null"],
    };
  }

  return normalized;
}

export function pruneUnreachableComponents(
  document: OpenApiObject,
  { schemaRoots = [] }: { schemaRoots?: readonly string[] } = {},
): OpenApiObject {
  const components = asRecord(document.components);
  const reachable = new Map<string, Set<string>>();
  const queue: Array<[string, string]> = [];

  const markReachable = (section: string, name: string) => {
    const names = reachable.get(section) ?? new Set<string>();
    if (names.has(name)) return;
    names.add(name);
    reachable.set(section, names);
    queue.push([section, name]);
  };

  for (const schemaName of schemaRoots) markReachable("schemas", schemaName);
  collectComponentReferences(document.paths, markReachable);

  while (queue.length > 0) {
    const [section, name] = queue.shift()!;
    const component = asRecord(components[section])[name];
    if (component !== undefined) collectComponentReferences(component, markReachable);
  }

  const prunedComponents = Object.fromEntries(
    Object.entries(components)
      .map(([section, entries]) => {
        const reachableNames = reachable.get(section) ?? new Set<string>();
        const prunedEntries = Object.fromEntries(
          Object.entries(asRecord(entries)).filter(([name]) => reachableNames.has(name)),
        );
        return [section, prunedEntries];
      })
      .filter(([, entries]) => Object.keys(entries).length > 0),
  );

  return {
    ...document,
    components: prunedComponents,
  };
}

function addRealtimeEnvelopeComponents(document: OpenApiObject) {
  const components = asRecord(document.components);
  const schemas = asRecord(components.schemas);

  for (const [name, registry] of Object.entries(realtimeEnvelopeRegistries)) {
    schemas[name] = createRealtimeEnvelope(registry);
  }

  components.schemas = schemas;
  document.components = components;
}

function createRealtimeEnvelope(registry: readonly RealtimeSchemaVariant[]): OpenApiObject {
  const mapping = Object.fromEntries(
    registry.map(({ name, wireType }) => [wireType, `#/components/schemas/${name}`]),
  );

  if (Object.keys(mapping).length !== registry.length) {
    throw new Error("Realtime registry wire discriminators must be unique within an envelope");
  }

  return {
    oneOf: registry.map(({ name }) => schemaReference(name)),
    discriminator: {
      propertyName: "type",
      mapping,
    },
  };
}

function addNamedEnumComponents(document: OpenApiObject) {
  const components = asRecord(document.components);
  const schemas = asRecord(components.schemas);

  for (const [name, schema] of Object.entries(namedEnumSchemas)) {
    schemas[name] = {
      type: "string",
      enum: getStringEnumValues(schema),
    };
  }

  components.schemas = schemas;
  document.components = components;
}

function deduplicateComponentSchemas(document: OpenApiObject) {
  const components = asRecord(document.components);
  const schemas = asRecord(components.schemas);
  const componentByFingerprint = new Map<string, string>();

  for (const [name, schema] of Object.entries(schemas)) {
    componentByFingerprint.set(schemaFingerprint(schema), name);
  }
  for (const [name, schema] of Object.entries(namedEnumSchemas)) {
    componentByFingerprint.set(schemaFingerprint(normalizeOpenApiValue(schema)), name);
  }

  const replaceExactDuplicate = (value: unknown, isComponentRoot = false): unknown => {
    if (Array.isArray(value)) return value.map((child) => replaceExactDuplicate(child));
    if (!isRecord(value)) return value;

    if (!isComponentRoot) {
      const componentName = componentByFingerprint.get(schemaFingerprint(value));
      if (componentName) return schemaReference(componentName);
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, replaceExactDuplicate(child)]),
    );
  };

  const deduplicatedSchemas = Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [name, replaceExactDuplicate(schema, true)]),
  );
  const deduplicatedPaths = replaceExactDuplicate(document.paths) as OpenApiObject;
  const canonicalComponentByFingerprint = new Map(
    Object.entries(deduplicatedSchemas).map(([name, schema]) => [schemaFingerprint(schema), name]),
  );

  const replaceNullableDuplicate = (value: unknown, isComponentRoot = false): unknown => {
    if (Array.isArray(value)) return value.map((child) => replaceNullableDuplicate(child));
    if (!isRecord(value)) return value;

    const schema = Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, replaceNullableDuplicate(child)]),
    );
    if (isComponentRoot) return schema;

    return findNullableComponentReference(schema, canonicalComponentByFingerprint) ?? schema;
  };

  components.schemas = Object.fromEntries(
    Object.entries(deduplicatedSchemas).map(([name, schema]) => [
      name,
      replaceNullableDuplicate(schema, true),
    ]),
  );
  document.paths = replaceNullableDuplicate(deduplicatedPaths) as OpenApiObject;
  document.components = components;
}

function findNullableComponentReference(
  schema: OpenApiObject,
  componentByFingerprint: ReadonlyMap<string, string>,
): OpenApiObject | undefined {
  if (!Array.isArray(schema.type) || schema.type.length !== 2 || !schema.type.includes("null")) {
    return undefined;
  }

  const nonNullType = schema.type.find((type) => type !== "null");
  if (!isSimpleType(nonNullType)) return undefined;

  const componentSchema = { ...schema, type: nonNullType };
  const nullableComponentName = componentByFingerprint.get(schemaFingerprint(componentSchema));
  if (!nullableComponentName) return undefined;

  return {
    ...schemaReference(nullableComponentName),
    type: schema.type,
  };
}

function getStringEnumValues(schema: OpenApiObject): string[] {
  if (typeof schema.const === "string") return [schema.const];

  if (Array.isArray(schema.enum) && schema.enum.every((value) => typeof value === "string")) {
    return schema.enum;
  }

  if (Array.isArray(schema.anyOf)) {
    const values = schema.anyOf.map((candidate) =>
      isRecord(candidate) && typeof candidate.const === "string" ? candidate.const : undefined,
    );
    if (values.every((value) => value !== undefined)) return values as string[];
  }

  throw new Error("Named enum schema does not contain string enum values");
}

function schemaFingerprint(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(schemaFingerprint).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);

  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${schemaFingerprint(value[key])}`)
    .join(",")}}`;
}

function addBearerSecurityScheme(document: OpenApiObject) {
  const components = asRecord(document.components);
  components.securitySchemes = {
    ...asRecord(components.securitySchemes),
    bearerAuth: {
      type: "http",
      scheme: "bearer",
      description: "Better Auth bearer session token",
    },
  };
  document.components = components;
}

function addStandardApplicationErrors(document: OpenApiObject) {
  for (const pathItem of Object.values(asRecord(document.paths))) {
    if (!isRecord(pathItem)) continue;

    for (const [method, candidate] of Object.entries(pathItem)) {
      if (!httpMethods.has(method) || !isRecord(candidate)) continue;

      const responses = asRecord(candidate.responses);
      const security = candidate.security;
      if (Array.isArray(security) && security.length > 0 && responses["401"] === undefined) {
        responses["401"] = errorResponse("401", "ApiErrorResponse");
      }

      const parameters = Array.isArray(candidate.parameters) ? candidate.parameters : [];
      if (
        (candidate.requestBody !== undefined || parameters.length > 0) &&
        responses["422"] === undefined
      ) {
        responses["422"] = errorResponse("422", "ApiErrorResponse");
      }

      if (responses["500"] === undefined) {
        responses["500"] = errorResponse("500", "ApiErrorResponse");
      }

      candidate.responses = responses;
    }
  }
}

function normalizeCoercionUnion(value: OpenApiObject): OpenApiObject | undefined {
  if (!Array.isArray(value.anyOf) || value.anyOf.length !== 2) return undefined;

  const candidates = value.anyOf.filter(isRecord);
  if (candidates.length !== 2) return undefined;

  const numericString = candidates.find(
    (candidate) =>
      candidate.type === "string" &&
      (candidate.format === "numeric" || candidate.format === "integer"),
  );
  const numericValue = candidates.find(
    (candidate) => candidate.type === "number" || candidate.type === "integer",
  );
  if (numericString && numericValue) {
    const { anyOf: _anyOf, ...outerMetadata } = value;
    const { type: numericType, ...numericMetadata } = numericValue;
    const isInteger =
      numericType === "integer" ||
      numericMetadata.multipleOf === 1 ||
      outerMetadata.multipleOf === 1;

    return {
      ...outerMetadata,
      ...numericMetadata,
      type: isInteger ? "integer" : "number",
    };
  }

  const booleanValue = candidates.find((candidate) => candidate.type === "boolean");
  const booleanString = candidates.find(
    (candidate) => candidate.type === "string" && candidate.format === "boolean",
  );
  if (booleanValue && booleanString) {
    const { anyOf: _anyOf, ...outerMetadata } = value;
    const { type: _type, ...booleanMetadata } = booleanValue;

    return {
      ...outerMetadata,
      ...booleanMetadata,
      type: "boolean",
    };
  }

  return undefined;
}

function normalizeSimpleNullableUnion(value: OpenApiObject): OpenApiObject | undefined {
  if (!Array.isArray(value.anyOf) || value.anyOf.length !== 2) return undefined;

  const nullCandidate = value.anyOf.find(
    (candidate) => isRecord(candidate) && candidate.type === "null",
  );
  const nonNullCandidate = value.anyOf.find(
    (candidate) => !(isRecord(candidate) && candidate.type === "null"),
  );
  if (!nullCandidate || !isRecord(nonNullCandidate)) {
    return undefined;
  }

  const { anyOf: _anyOf, ...outerMetadata } = value;
  if (typeof nonNullCandidate.$ref === "string") {
    const enumName = nonNullCandidate.$ref.match(/^#\/components\/schemas\/(.+)$/)?.[1];
    if (enumName && enumName in namedEnumSchemas) {
      return {
        ...outerMetadata,
        ...nonNullCandidate,
        type: ["string", "null"],
      };
    }

    return {
      ...outerMetadata,
      oneOf: [nonNullCandidate, { type: "null" }],
    };
  }

  if (Array.isArray(nonNullCandidate.anyOf)) {
    const enumValues = nonNullCandidate.anyOf.map((candidate) =>
      isRecord(candidate) && typeof candidate.const === "string" ? candidate.const : undefined,
    );
    if (enumValues.length > 0 && enumValues.every((candidate) => candidate !== undefined)) {
      return {
        ...outerMetadata,
        type: ["string", "null"],
        enum: enumValues,
      };
    }
  }

  if (!isSimpleType(nonNullCandidate.type)) return undefined;
  const { type, ...schemaMetadata } = nonNullCandidate;

  return {
    ...outerMetadata,
    ...schemaMetadata,
    type: [type, "null"],
  };
}

function collectComponentReferences(
  value: unknown,
  markReachable: (section: string, name: string) => void,
) {
  if (Array.isArray(value)) {
    for (const child of value) collectComponentReferences(child, markReachable);
    return;
  }

  if (!isRecord(value)) return;

  if (typeof value.$ref === "string") {
    const match = value.$ref.match(/^#\/components\/([^/]+)\/(.+)$/);
    if (match) markReachable(decodePointer(match[1]!), decodePointer(match[2]!));
  }

  if (Array.isArray(value.security)) {
    for (const requirement of value.security) {
      if (!isRecord(requirement)) continue;
      for (const schemeName of Object.keys(requirement)) {
        markReachable("securitySchemes", schemeName);
      }
    }
  }

  for (const child of Object.values(value)) {
    collectComponentReferences(child, markReachable);
  }
}

function decodePointer(value: string) {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function isSimpleType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ["array", "boolean", "integer", "number", "object", "string"].includes(value)
  );
}

function isTypeBoxDateUnion(value: OpenApiObject) {
  return (
    Array.isArray(value.anyOf) &&
    value.anyOf.some((candidate) => isRecord(candidate) && candidate.type === "Date") &&
    !value.anyOf.some((candidate) => isRecord(candidate) && candidate.type === "null")
  );
}

function isRecord(value: unknown): value is OpenApiObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): OpenApiObject {
  return isRecord(value) ? value : {};
}

function schemaReference(name: string) {
  return { $ref: `#/components/schemas/${name}` };
}

function jsonResponse(description: string, schemaName: string, headers?: OpenApiObject) {
  return {
    description,
    ...(headers ? { headers } : {}),
    content: {
      "application/json": {
        schema: schemaReference(schemaName),
      },
    },
  };
}

function errorResponse(status: string, schemaName: string) {
  return jsonResponse(errorStatusDescriptions[status] ?? "Request failed", schemaName);
}

const authTokenHeader = {
  "set-auth-token": {
    required: true,
    description: "Canonical bearer session token for subsequent authenticated requests",
    schema: { type: "string" },
  },
};

const authSchemas: Record<string, OpenApiObject> = {
  AuthUser: {
    type: "object",
    additionalProperties: false,
    required: ["id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt"],
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      email: { type: "string", format: "email" },
      emailVerified: { type: "boolean" },
      image: { type: ["string", "null"], format: "uri" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  AuthSession: {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "expiresAt",
      "token",
      "createdAt",
      "updatedAt",
      "ipAddress",
      "userAgent",
      "userId",
    ],
    properties: {
      id: { type: "string" },
      expiresAt: { type: "string", format: "date-time" },
      token: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      ipAddress: { type: ["string", "null"] },
      userAgent: { type: ["string", "null"] },
      userId: { type: "string" },
    },
  },
  AuthCredentialResponse: {
    type: "object",
    additionalProperties: false,
    required: ["user"],
    properties: {
      user: schemaReference("AuthUser"),
      token: {
        type: "string",
        description: "Compatibility body token; prefer the set-auth-token response header",
      },
      redirect: { type: "boolean" },
      url: { type: "string", format: "uri" },
    },
  },
  AuthSessionResponse: {
    type: "object",
    additionalProperties: false,
    required: ["session", "user"],
    properties: {
      session: schemaReference("AuthSession"),
      user: schemaReference("AuthUser"),
    },
    description: "The current active bearer session",
  },
  AuthErrorResponse: {
    type: "object",
    additionalProperties: false,
    required: ["code", "message"],
    properties: {
      code: { type: "string" },
      message: { type: "string" },
      details: {},
    },
  },
  AuthSignUpRequest: {
    type: "object",
    additionalProperties: false,
    required: ["name", "email", "password"],
    properties: {
      name: { type: "string", minLength: 1 },
      email: { type: "string", format: "email" },
      password: { type: "string", format: "password", minLength: 8, maxLength: 128 },
      image: { type: "string", format: "uri" },
      callbackURL: { type: "string", format: "uri" },
      rememberMe: { type: "boolean", default: true },
    },
  },
  AuthSignInRequest: {
    type: "object",
    additionalProperties: false,
    required: ["email", "password"],
    properties: {
      email: { type: "string", format: "email" },
      password: { type: "string", format: "password" },
      callbackURL: { type: "string", format: "uri" },
      rememberMe: { type: "boolean", default: true },
    },
  },
  AuthSignOutResponse: {
    type: "object",
    additionalProperties: false,
    required: ["success"],
    properties: {
      success: { type: "boolean" },
    },
  },
};

const authPaths: Record<string, OpenApiObject> = {
  "/api/auth/sign-up/email": {
    post: {
      tags: ["Authentication"],
      summary: "Create an account with email and password",
      operationId: "signUpWithEmail",
      security: [],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: schemaReference("AuthSignUpRequest") },
        },
      },
      responses: {
        "200": jsonResponse(
          "Account and authenticated session created",
          "AuthCredentialResponse",
          authTokenHeader,
        ),
        "400": errorResponse("400", "AuthErrorResponse"),
        "422": errorResponse("422", "AuthErrorResponse"),
        "500": errorResponse("500", "AuthErrorResponse"),
      },
    },
  },
  "/api/auth/sign-in/email": {
    post: {
      tags: ["Authentication"],
      summary: "Sign in with email and password",
      operationId: "signInWithEmail",
      security: [],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: schemaReference("AuthSignInRequest") },
        },
      },
      responses: {
        "200": jsonResponse(
          "Authenticated session created",
          "AuthCredentialResponse",
          authTokenHeader,
        ),
        "400": errorResponse("400", "AuthErrorResponse"),
        "401": errorResponse("401", "AuthErrorResponse"),
        "403": errorResponse("403", "AuthErrorResponse"),
        "500": errorResponse("500", "AuthErrorResponse"),
      },
    },
  },
  "/api/mobile/auth/session": {
    get: {
      tags: ["Authentication"],
      summary: "Get the current authenticated session",
      operationId: "getAuthSession",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": jsonResponse("Current active session", "AuthSessionResponse"),
        "401": errorResponse("401", "AuthErrorResponse"),
        "500": errorResponse("500", "AuthErrorResponse"),
      },
    },
  },
  "/api/mobile/auth/sign-out": {
    post: {
      tags: ["Authentication"],
      summary: "End the current authenticated session",
      operationId: "signOut",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": jsonResponse("Session ended", "AuthSignOutResponse"),
        "401": errorResponse("401", "AuthErrorResponse"),
        "500": errorResponse("500", "AuthErrorResponse"),
      },
    },
  },
};
