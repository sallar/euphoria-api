import { customType } from "drizzle-orm/pg-core";

/**
 * Drizzle's built-in PostgreSQL JSONB mapper serializes values before passing
 * them to Bun SQL. Bun SQL also performs native JSON parameter encoding, which
 * would store the serialized value as a JSON string. Keep objects native at
 * the driver boundary and tolerate pre-migration string values on reads.
 */
export const bunJsonb = customType<{
  data: unknown;
  driverData: unknown;
  driverOutput: unknown;
}>({
  dataType: () => "jsonb",
  toDriver: (value) => value,
  fromDriver: (value) => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  },
});
