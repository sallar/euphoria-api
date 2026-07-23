import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { createIntegrationHarness } from "./harness";

const integrationTest = process.env.RUN_INTEGRATION_TESTS === "1" ? test : test.skip;

describe("PostgreSQL and Redis integration harness", () => {
  integrationTest("isolates durable rows and ephemeral keys for one test scope", async () => {
    const harness = await createIntegrationHarness("postgres_redis_smoke");
    const probeTable = harness.table("probe");
    const probeId = randomUUID();
    const redisKey = harness.redisKey(`probe:${probeId}`);

    try {
      await harness.postgres`
        create table ${harness.postgres(probeTable)} (
          id uuid primary key,
          payload text not null
        )
      `;
      await harness.postgres`
        insert into ${harness.postgres(probeTable)} (id, payload)
        values (${probeId}, ${"durable"})
      `;

      const [stored] = await harness.postgres<{ id: string; payload: string }[]>`
        select id, payload
        from ${harness.postgres(probeTable)}
        where id = ${probeId}
      `;
      expect(stored).toEqual({ id: probeId, payload: "durable" });

      await harness.redis.set(redisKey, JSON.stringify(stored), "EX", 60);
      expect(await harness.redis.get(redisKey)).toBe(JSON.stringify(stored));
    } finally {
      await harness.cleanup();
    }
  });
});
