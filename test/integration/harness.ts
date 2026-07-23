import { RedisClient, SQL } from "bun";
import { randomUUID } from "node:crypto";

export const defaultIntegrationDatabaseUrl =
  "postgresql://postgres:postgres@127.0.0.1:55432/euphoria_integration";
export const defaultIntegrationRedisUrl = "redis://127.0.0.1:56379";

const identifierPattern = /^[a-z][a-z0-9_]*$/;

const assertIntegrationDatabase = (connectionUrl: string) => {
  const url = new URL(connectionUrl);
  const databaseName = decodeURIComponent(url.pathname.slice(1));

  if (!/(^|[_-])integration($|[_-])/.test(databaseName)) {
    throw new Error(
      `Refusing to create an integration schema in database "${databaseName}". ` +
        "INTEGRATION_DATABASE_URL must name a dedicated integration database.",
    );
  }
};

const normalizeSuiteName = (suiteName: string) => {
  const normalized = suiteName
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replaceAll(/^_+|_+$/g, "")
    .slice(0, 20);

  return normalized || "suite";
};

export type IntegrationHarness = {
  postgres: SQL;
  redis: RedisClient;
  schema: string;
  table: (name: string) => string;
  redisKey: (suffix: string) => string;
  cleanup: () => Promise<void>;
};

export const createIntegrationHarness = async (
  suiteName = "suite",
): Promise<IntegrationHarness> => {
  const databaseUrl = process.env.INTEGRATION_DATABASE_URL ?? defaultIntegrationDatabaseUrl;
  const redisUrl = process.env.INTEGRATION_REDIS_URL ?? defaultIntegrationRedisUrl;
  assertIntegrationDatabase(databaseUrl);

  const schema =
    `it_${normalizeSuiteName(suiteName)}_${process.pid}_${randomUUID().replaceAll("-", "")}`.slice(
      0,
      63,
    );
  const postgres = new SQL(databaseUrl, { max: 2 });
  const redis = new RedisClient(redisUrl);
  const redisKeys = new Set<string>();
  let schemaCreated = false;
  let cleanedUp = false;

  try {
    await postgres.connect();
    await postgres`create schema ${postgres(schema)}`;
    schemaCreated = true;
    await redis.connect();
  } catch (error) {
    const errors: unknown[] = [error];

    try {
      if (schemaCreated) await postgres`drop schema if exists ${postgres(schema)} cascade`;
    } catch (cleanupError) {
      errors.push(cleanupError);
    } finally {
      redis.close();
      try {
        await postgres.close({ timeout: 0 });
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
    }

    throw errors.length === 1
      ? error
      : new AggregateError(errors, "Integration harness setup and cleanup failed");
  }

  const table = (name: string) => {
    if (!identifierPattern.test(name)) {
      throw new Error(`Invalid integration table identifier: "${name}"`);
    }

    return `${schema}.${name}`;
  };

  const redisKey = (suffix: string) => {
    const key = `integration:${schema}:${suffix}`;
    redisKeys.add(key);
    return key;
  };

  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    const errors: unknown[] = [];

    try {
      if (redisKeys.size) await redis.del(...redisKeys);
    } catch (error) {
      errors.push(error);
    } finally {
      redis.close();
    }

    try {
      await postgres`drop schema if exists ${postgres(schema)} cascade`;
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        await postgres.close();
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length) throw new AggregateError(errors, "Integration harness cleanup failed");
  };

  return {
    postgres,
    redis,
    schema,
    table,
    redisKey,
    cleanup,
  };
};
