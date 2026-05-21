import { createSchemaFactory } from "drizzle-orm/typebox-legacy";
import { t } from "elysia";

export const { createInsertSchema, createSelectSchema, createUpdateSchema } = createSchemaFactory({
  typeboxInstance: t,
});
