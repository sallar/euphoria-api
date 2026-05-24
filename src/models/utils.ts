import { t } from "elysia";

export const ref = <Name extends string>(name: Name) => t.Ref(`#/components/schemas/${name}`);
