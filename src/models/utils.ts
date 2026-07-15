import type { Static, TSchema } from "@sinclair/typebox";

import { t } from "elysia";

export const ref = <Name extends string>(name: Name) => t.Ref(`#/components/schemas/${name}`);

export const modelRef = <Name extends string, Schema extends TSchema>(
  name: Name,
  _schema: Schema,
) => t.Unsafe<Static<Schema>>(t.Ref(`#/components/schemas/${name}`));
