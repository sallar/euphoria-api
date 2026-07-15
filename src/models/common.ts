import Elysia, { t } from "elysia";

export const commonModel = new Elysia({ name: "common-model" }).model({
  ApiErrorResponse: t.Object({
    code: t.Optional(t.String({ description: "Stable machine-readable error code when known" })),
    message: t.String({ description: "Human-readable error message" }),
    details: t.Optional(t.Any({ description: "Structured validation or diagnostic details" })),
  }),
  MessageResponse: t.Object({ message: t.String() }),
});
