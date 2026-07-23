import { t } from "elysia";

export const OpaqueCursor = t.String({
  description:
    "Versioned opaque continuation token. Return it unchanged; clients must not parse, construct, compare, or modify it.",
});
