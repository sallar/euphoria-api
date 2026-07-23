import { createHmac, timingSafeEqual } from "node:crypto";

export const CURSOR_FORMAT_VERSION = 1 as const;
export const CURSOR_ERROR_CODE = "invalid_cursor" as const;
export const CURSOR_ERROR_MESSAGE = "Cursor is invalid for this request" as const;

export type CursorResource =
  | "chat-conversations"
  | "chat-messages"
  | "notifications"
  | "profile-feed";
export type CursorDirection = "next" | "previous";

export type CursorSortTupleByResource = {
  "profile-feed": {
    distanceMeters: number;
    profileId: string;
  };
  "chat-conversations": {
    sortAtMicros: string;
    conversationId: string;
  };
  "chat-messages": {
    createdAtMicros: string;
    messageId: string;
  };
  notifications: {
    createdAtMicros: string;
    notificationId: string;
  };
};

type CursorContextValue =
  | boolean
  | null
  | number
  | string
  | CursorContextValue[]
  | { [key: string]: CursorContextValue };
export type CursorContext = Record<string, CursorContextValue>;

export type CursorErrorReason =
  | "context_mismatch"
  | "direction_mismatch"
  | "malformed"
  | "resource_mismatch"
  | "tampered"
  | "unsupported_version";

type ProtectedCursorPayload = {
  version: number;
  resource: CursorResource;
  direction: CursorDirection;
  sort: unknown;
  fingerprint: string;
};

type CursorCodecOptions = {
  signingSecrets: readonly string[];
};

const wireVersionPrefix = "c1";
const signatureDomain = "euphoria-cursor-signature-v1";
const fingerprintDomain = "euphoria-cursor-fingerprint-v1";
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const timestampMicrosPattern = /^-?[0-9]+$/;
const maximumCursorLength = 8192;

export class CursorError extends Error {
  readonly status = 400;

  constructor(readonly reason: CursorErrorReason) {
    super(CURSOR_ERROR_MESSAGE);
    this.name = "CursorError";
  }

  toResponse() {
    return Response.json(
      {
        code: CURSOR_ERROR_CODE,
        message: CURSOR_ERROR_MESSAGE,
      },
      { status: this.status },
    );
  }
}

const fail = (reason: CursorErrorReason): never => {
  throw new CursorError(reason);
};

const encodeBase64Url = (value: string | Uint8Array) => Buffer.from(value).toString("base64url");

const decodeBase64Url = (value: string) => {
  if (!value || !base64UrlPattern.test(value)) fail("malformed");

  try {
    return Buffer.from(value, "base64url");
  } catch {
    return fail("malformed");
  }
};

const canonicalize = (value: CursorContextValue): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cursor context numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key]!)}`)
    .join(",")}}`;
};

const sign = (encodedPayload: string, signingSecret: string) =>
  createHmac("sha256", signingSecret)
    .update(signatureDomain)
    .update("\0")
    .update(encodedPayload)
    .digest();

const fingerprint = ({
  context,
  direction,
  resource,
  signingSecret,
}: {
  context: CursorContext;
  direction: CursorDirection;
  resource: CursorResource;
  signingSecret: string;
}) =>
  createHmac("sha256", signingSecret)
    .update(fingerprintDomain)
    .update("\0")
    .update(canonicalize({ context, direction, resource }))
    .digest("base64url");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isUuid = (value: unknown): value is string =>
  typeof value === "string" && uuidPattern.test(value);

const isTimestampMicros = (value: unknown): value is string =>
  typeof value === "string" && timestampMicrosPattern.test(value);

const parseSortTuple = <Resource extends CursorResource>(
  resource: Resource,
  value: unknown,
): CursorSortTupleByResource[Resource] => {
  if (!isRecord(value)) return fail("malformed");

  switch (resource) {
    case "profile-feed":
      if (
        typeof value.distanceMeters !== "number" ||
        !Number.isFinite(value.distanceMeters) ||
        value.distanceMeters < 0 ||
        !isUuid(value.profileId)
      ) {
        return fail("malformed");
      }
      return {
        distanceMeters: value.distanceMeters,
        profileId: value.profileId,
      } as CursorSortTupleByResource[Resource];
    case "chat-conversations":
      if (!isTimestampMicros(value.sortAtMicros) || !isUuid(value.conversationId)) {
        return fail("malformed");
      }
      return {
        sortAtMicros: value.sortAtMicros,
        conversationId: value.conversationId,
      } as CursorSortTupleByResource[Resource];
    case "chat-messages":
      if (!isTimestampMicros(value.createdAtMicros) || !isUuid(value.messageId)) {
        return fail("malformed");
      }
      return {
        createdAtMicros: value.createdAtMicros,
        messageId: value.messageId,
      } as CursorSortTupleByResource[Resource];
    case "notifications":
      if (!isTimestampMicros(value.createdAtMicros) || !isUuid(value.notificationId)) {
        return fail("malformed");
      }
      return {
        createdAtMicros: value.createdAtMicros,
        notificationId: value.notificationId,
      } as CursorSortTupleByResource[Resource];
  }
};

const parsePayload = (encodedPayload: string): ProtectedCursorPayload => {
  const decoded = decodeBase64Url(encodedPayload);
  let value: unknown;

  try {
    value = JSON.parse(decoded.toString("utf8"));
  } catch {
    return fail("malformed");
  }

  if (
    !isRecord(value) ||
    typeof value.version !== "number" ||
    typeof value.resource !== "string" ||
    typeof value.direction !== "string" ||
    typeof value.fingerprint !== "string" ||
    !("sort" in value)
  ) {
    return fail("malformed");
  }

  if (value.version !== CURSOR_FORMAT_VERSION) return fail("unsupported_version");
  if (
    !["chat-conversations", "chat-messages", "notifications", "profile-feed"].includes(
      value.resource,
    ) ||
    !["next", "previous"].includes(value.direction)
  ) {
    return fail("malformed");
  }

  return value as ProtectedCursorPayload;
};

const normalizeSigningSecrets = (signingSecrets: readonly string[]) => {
  const normalized = Array.from(
    new Set(signingSecrets.map((secret) => secret.trim()).filter(Boolean)),
  );
  if (!normalized.length) throw new Error("At least one cursor signing secret is required");
  return normalized;
};

export const createCursorCodec = ({ signingSecrets }: CursorCodecOptions) => {
  const keys = normalizeSigningSecrets(signingSecrets);

  const encode = <Resource extends CursorResource>({
    context,
    direction,
    resource,
    sort,
  }: {
    context: CursorContext;
    direction: CursorDirection;
    resource: Resource;
    sort: CursorSortTupleByResource[Resource];
  }) => {
    parseSortTuple(resource, sort);
    const signingSecret = keys[0]!;
    const payload: ProtectedCursorPayload = {
      version: CURSOR_FORMAT_VERSION,
      resource,
      direction,
      sort,
      fingerprint: fingerprint({
        context,
        direction,
        resource,
        signingSecret,
      }),
    };
    const encodedPayload = encodeBase64Url(JSON.stringify(payload));
    const encodedSignature = encodeBase64Url(sign(encodedPayload, signingSecret));
    return `${wireVersionPrefix}.${encodedPayload}.${encodedSignature}`;
  };

  const decode = <Resource extends CursorResource>({
    context,
    cursor,
    direction,
    resource,
  }: {
    context: CursorContext;
    cursor: string;
    direction: CursorDirection;
    resource: Resource;
  }): CursorSortTupleByResource[Resource] => {
    if (!cursor || cursor.length > maximumCursorLength) return fail("malformed");

    const parts = cursor.split(".");
    if (parts.length !== 3) return fail("malformed");
    if (parts[0] !== wireVersionPrefix) {
      return fail(/^c[0-9]+$/.test(parts[0] ?? "") ? "unsupported_version" : "malformed");
    }

    const encodedPayload = parts[1]!;
    const providedSignature = decodeBase64Url(parts[2]!);
    const signingSecret = keys.find((candidate) => {
      const expectedSignature = sign(encodedPayload, candidate);
      return (
        providedSignature.length === expectedSignature.length &&
        timingSafeEqual(providedSignature, expectedSignature)
      );
    });
    if (!signingSecret) return fail("tampered");

    const payload = parsePayload(encodedPayload);
    if (payload.resource !== resource) return fail("resource_mismatch");
    if (payload.direction !== direction) return fail("direction_mismatch");

    const expectedFingerprint = fingerprint({
      context,
      direction,
      resource,
      signingSecret,
    });
    const providedFingerprint = Buffer.from(payload.fingerprint);
    const expectedFingerprintBytes = Buffer.from(expectedFingerprint);
    if (
      providedFingerprint.length !== expectedFingerprintBytes.length ||
      !timingSafeEqual(providedFingerprint, expectedFingerprintBytes)
    ) {
      return fail("context_mismatch");
    }

    return parseSortTuple(resource, payload.sort);
  };

  return { decode, encode };
};

const loadDefaultSigningSecrets = () => {
  const primary =
    process.env.CURSOR_SIGNING_SECRET?.trim() || process.env.BETTER_AUTH_SECRET?.trim();
  const previous =
    process.env.CURSOR_SIGNING_PREVIOUS_SECRETS?.split(",")
      .map((secret) => secret.trim())
      .filter(Boolean) ?? [];

  return normalizeSigningSecrets([primary ?? "", ...previous]);
};

export const encodeCursor = <Resource extends CursorResource>(
  input: Parameters<ReturnType<typeof createCursorCodec>["encode"]>[0] & {
    resource: Resource;
    sort: CursorSortTupleByResource[Resource];
  },
) => createCursorCodec({ signingSecrets: loadDefaultSigningSecrets() }).encode(input);

export const decodeCursor = <Resource extends CursorResource>(
  input: Parameters<ReturnType<typeof createCursorCodec>["decode"]>[0] & {
    resource: Resource;
  },
): CursorSortTupleByResource[Resource] =>
  createCursorCodec({ signingSecrets: loadDefaultSigningSecrets() }).decode(input);
