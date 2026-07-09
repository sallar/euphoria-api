import type { AnyElysia } from "elysia";

import { toOpenAPISchema } from "@elysia/openapi";

export const openApiInfo = {
  title: "Euphoria API",
  description: "HTTP API for the Euphoria app",
  version: "1.0.0",
} as const;

export function createOpenApiDocument(app: AnyElysia) {
  const schema = toOpenAPISchema(app, {
    methods: ["options", "ws"],
  });

  return normalizeOpenApiValue({
    openapi: "3.1.0",
    info: openApiInfo,
    ...schema,
  });
}

function normalizeOpenApiValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeOpenApiValue);
  }

  if (!isRecord(value)) {
    return value;
  }

  if (isTypeBoxDateSchema(value)) {
    const { $id: _id, anyOf: _anyOf, nullable: _nullable, type: _type, ...metadata } = value;

    return {
      ...(normalizeOpenApiValue(metadata) as Record<string, unknown>),
      type: "string",
      format: "date-time",
    };
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "$id" && key !== "nullable")
      .map(([key, child]) => [key, normalizeOpenApiValue(child)]),
  );
}

function isTypeBoxDateSchema(value: Record<string, unknown>) {
  return (
    value.type === "Date" ||
    (Array.isArray(value.anyOf) &&
      value.anyOf.some((candidate) => isRecord(candidate) && candidate.type === "Date"))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
