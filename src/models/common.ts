import Elysia, { t } from "elysia";

export const commonModel = new Elysia({ name: "common-model" }).model({
  MessageResponse: t.Object({ message: t.String() }),
});
