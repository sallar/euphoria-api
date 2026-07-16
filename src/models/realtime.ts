import type { TUnsafe } from "@sinclair/typebox";

import { t, type TSchema } from "elysia";

export const REALTIME_PROTOCOL_VERSION = 1 as const;
export const REALTIME_CONTRACT_VERSION = "1.0.0" as const;
export const REALTIME_HEARTBEAT_INTERVAL_SECONDS = 30 as const;

export type RealtimeSchemaVariant<Schema extends TSchema = TSchema> = {
  readonly name: string;
  readonly wireType: string;
  readonly schema: Schema;
  readonly summary: string;
  readonly description: string;
  readonly example: unknown;
  readonly correlationId?: true;
};

export function realtimeUnion<const Registry extends readonly RealtimeSchemaVariant[]>(
  registry: Registry,
): TUnsafe<Registry[number]["schema"]["static"]> {
  return t.Union(registry.map(({ schema }) => schema)) as TUnsafe<
    Registry[number]["schema"]["static"]
  >;
}

type RealtimeSchemaModels<Registries extends readonly (readonly RealtimeSchemaVariant[])[]> = {
  [Variant in Registries[number][number] as Variant["name"]]: Variant["schema"];
};

export function realtimeSchemas<
  const Registries extends readonly (readonly RealtimeSchemaVariant[])[],
>(...registries: Registries): RealtimeSchemaModels<Registries> {
  const schemas: Record<string, TSchema> = {};

  for (const registry of registries) {
    for (const variant of registry) {
      if (schemas[variant.name]) {
        throw new Error(`Duplicate realtime schema name: ${variant.name}`);
      }
      schemas[variant.name] = variant.schema;
    }
  }

  return schemas as RealtimeSchemaModels<Registries>;
}
