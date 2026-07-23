import { sql } from "drizzle-orm";

import { commandIdempotency, durableEvent } from "@/db/durable-schema";
import { db } from "@/lib/db";
import { cleanupCompletedIdempotencyRecords } from "@/services/command-idempotency-service";
import { pruneExpiredDurableEvents } from "@/services/durable-event-service";

const rawBatchSize = process.env.CHAT_DURABILITY_CLEANUP_BATCH_SIZE;
const batchSize = rawBatchSize === undefined ? Number.NaN : Number(rawBatchSize);
if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
  throw new Error(
    "CHAT_DURABILITY_CLEANUP_BATCH_SIZE must be explicitly configured as a positive integer",
  );
}

const [commandLagBefore] = await db
  .select({
    count: sql<number>`count(*)::int`,
    oldestLagSeconds: sql<number>`coalesce(
      extract(epoch from clock_timestamp() - min(${commandIdempotency.retentionExpiresAt})),
      0
    )::double precision`,
  })
  .from(commandIdempotency)
  .where(
    sql`${commandIdempotency.state} = 'completed'
      and ${commandIdempotency.retentionExpiresAt} <= clock_timestamp()`,
  );
const [eventLagBefore] = await db
  .select({
    count: sql<number>`count(*)::int`,
    oldestLagSeconds: sql<number>`coalesce(
      extract(epoch from clock_timestamp() - min(${durableEvent.retentionExpiresAt})),
      0
    )::double precision`,
  })
  .from(durableEvent)
  .where(sql`${durableEvent.retentionExpiresAt} <= clock_timestamp()`);

const [commandsDeleted, eventsDeleted] = await Promise.all([
  cleanupCompletedIdempotencyRecords({ batchSize }),
  pruneExpiredDurableEvents({ batchSize }),
]);

console.log(
  JSON.stringify({
    event: "chat_durability_cleanup_completed",
    batchSize,
    commands: {
      deleted: commandsDeleted.length,
      expiredBefore: Number(commandLagBefore?.count ?? 0),
      oldestLagSecondsBefore: Number(commandLagBefore?.oldestLagSeconds ?? 0),
    },
    durableEvents: {
      deleted: eventsDeleted.length,
      expiredBefore: Number(eventLagBefore?.count ?? 0),
      oldestLagSecondsBefore: Number(eventLagBefore?.oldestLagSeconds ?? 0),
    },
  }),
);
