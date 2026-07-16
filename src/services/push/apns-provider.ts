import type { ClientHttp2Session, IncomingHttpHeaders } from "node:http2";

import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { connect } from "node:http2";

import type { Notification, PushToken } from "@/models/notification";

import type {
  PushDeliveryAttempt,
  PushDeliveryTarget,
  PushNotificationProvider,
  PushProviderMetadata,
} from "./types";

export const APNS_PAYLOAD_LIMIT_BYTES = 4096;
const APNS_JWT_CACHE_MILLISECONDS = 50 * 60 * 1000;
const DEFAULT_RETRY_DELAY_MILLISECONDS = 60 * 1000;
const MAX_RESPONSE_BODY_BYTES = 16 * 1024;

const apnsHosts: Record<NonNullable<PushToken["apnsEnvironment"]>, string> = {
  development: "api.sandbox.push.apple.com",
  production: "api.push.apple.com",
};

const permanentTokenReasons = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"]);
const authenticationReasons = new Set([
  "BadCertificate",
  "BadCertificateEnvironment",
  "ExpiredProviderToken",
  "Forbidden",
  "InvalidProviderToken",
  "MissingProviderToken",
  "TopicDisallowed",
]);
const knownApnsReasons = new Set([
  ...permanentTokenReasons,
  ...authenticationReasons,
  "BadCollapseId",
  "BadExpirationDate",
  "BadMessageId",
  "BadPath",
  "BadPriority",
  "BadTopic",
  "DuplicateHeaders",
  "IdleTimeout",
  "MethodNotAllowed",
  "MissingDeviceToken",
  "MissingTopic",
  "PayloadEmpty",
  "PayloadTooLarge",
  "Shutdown",
  "TooManyProviderTokenUpdates",
  "TooManyRequests",
]);

export type ApnsConfiguration = {
  teamId: string;
  keyId: string;
  privateKey: string;
  topic: string;
};

export type ApnsHttpRequest = {
  host: string;
  path: string;
  headers: Record<string, string>;
  body: string;
};

export type ApnsHttpResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

export interface ApnsHttpTransport {
  request(request: ApnsHttpRequest): Promise<ApnsHttpResponse>;
}

export interface ApnsAuthorizationTokenProvider {
  getToken(): string;
}

export class ApnsConfigurationError extends Error {
  constructor() {
    super("APNs provider configuration is incomplete or invalid");
    this.name = "ApnsConfigurationError";
  }
}

const requiredValue = (value: string | undefined) => {
  const normalized = value?.trim();
  if (!normalized) throw new ApnsConfigurationError();
  return normalized;
};

export const loadApnsConfiguration = (
  environment: Record<string, string | undefined> = process.env,
): ApnsConfiguration => {
  const encodedPrivateKey = environment.APNS_PRIVATE_KEY_BASE64?.trim();
  const privateKey = encodedPrivateKey
    ? Buffer.from(encodedPrivateKey, "base64").toString("utf8")
    : environment.APNS_PRIVATE_KEY?.replaceAll("\\n", "\n");

  return {
    teamId: requiredValue(environment.APNS_TEAM_ID),
    keyId: requiredValue(environment.APNS_KEY_ID),
    privateKey: requiredValue(privateKey),
    topic: requiredValue(environment.APNS_TOPIC),
  };
};

const encodeBase64Url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

export class ApnsJwtProvider implements ApnsAuthorizationTokenProvider {
  private cachedToken: { value: string; createdAt: number } | undefined;

  constructor(
    private readonly configuration: ApnsConfiguration,
    private readonly now: () => Date = () => new Date(),
  ) {}

  getToken() {
    const now = this.now().getTime();
    if (this.cachedToken && now - this.cachedToken.createdAt < APNS_JWT_CACHE_MILLISECONDS) {
      return this.cachedToken.value;
    }

    const header = encodeBase64Url(JSON.stringify({ alg: "ES256", kid: this.configuration.keyId }));
    const claims = encodeBase64Url(
      JSON.stringify({ iss: this.configuration.teamId, iat: Math.floor(now / 1000) }),
    );
    const signingInput = `${header}.${claims}`;
    const signature = sign("sha256", Buffer.from(signingInput), {
      key: createPrivateKey(this.configuration.privateKey),
      dsaEncoding: "ieee-p1363",
    });
    const value = `${signingInput}.${encodeBase64Url(signature)}`;

    this.cachedToken = { value, createdAt: now };
    return value;
  }
}

const normalizeResponseHeaders = (headers: IncomingHttpHeaders) =>
  Object.fromEntries(
    Object.entries(headers)
      .filter(([name]) => !name.startsWith(":"))
      .map(([name, value]) => [name.toLowerCase(), value]),
  );

export class NodeApnsHttp2Transport implements ApnsHttpTransport {
  private readonly sessions = new Map<string, ClientHttp2Session>();

  async request(request: ApnsHttpRequest): Promise<ApnsHttpResponse> {
    const session = this.getSession(request.host);

    return new Promise((resolve, reject) => {
      let responseHeaders: IncomingHttpHeaders = {};
      let responseBody = "";
      let responseBodyBytes = 0;
      const stream = session.request({
        ":method": "POST",
        ":path": request.path,
        ...request.headers,
      });

      stream.setEncoding("utf8");
      stream.on("response", (headers) => {
        responseHeaders = headers;
      });
      stream.on("data", (chunk: string) => {
        responseBodyBytes += Buffer.byteLength(chunk);
        if (responseBodyBytes <= MAX_RESPONSE_BODY_BYTES) responseBody += chunk;
      });
      stream.on("end", () => {
        resolve({
          status: Number(responseHeaders[":status"] ?? 0),
          headers: normalizeResponseHeaders(responseHeaders),
          body: responseBody,
        });
      });
      stream.on("error", () => reject(new Error("APNs HTTP/2 request failed")));
      stream.end(request.body);
    });
  }

  close() {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  private getSession(host: string) {
    const existing = this.sessions.get(host);
    if (existing && !existing.closed && !existing.destroyed) return existing;

    const session = connect(`https://${host}`);
    this.sessions.set(host, session);
    const removeSession = () => {
      if (this.sessions.get(host) === session) this.sessions.delete(host);
    };
    session.on("close", removeSession);
    session.on("error", removeSession);
    return session;
  }
}

const payloadBytes = (payload: unknown) => Buffer.byteLength(JSON.stringify(payload));

const fitAlertPayload = (
  notification: Notification,
  route: Record<string, unknown>,
): Record<string, unknown> => {
  const makePayload = (title: string, body: string) => ({
    aps: {
      alert: { title, body },
      sound: "default",
    },
    route,
  });
  let title = notification.title;
  let body = notification.body;

  const truncateField = (field: "title" | "body", value: string) => {
    const characters = [...value];
    let low = 0;
    let high = characters.length;

    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidate = characters.slice(0, middle).join("");
      const candidatePayload = makePayload(
        field === "title" ? candidate : title,
        field === "body" ? candidate : body,
      );
      if (payloadBytes(candidatePayload) <= APNS_PAYLOAD_LIMIT_BYTES) low = middle;
      else high = middle - 1;
    }

    return characters.slice(0, low).join("");
  };

  if (payloadBytes(makePayload(title, body)) > APNS_PAYLOAD_LIMIT_BYTES) {
    body = truncateField("body", body);
  }
  if (payloadBytes(makePayload(title, body)) > APNS_PAYLOAD_LIMIT_BYTES) {
    title = truncateField("title", title);
  }

  return makePayload(title, body);
};

export const buildApnsPayload = (notification: Notification) => {
  const route = {
    notificationId: notification.id,
    type: notification.type,
    data: notification.data,
  };
  const payload = fitAlertPayload(notification, route);
  if (payloadBytes(payload) <= APNS_PAYLOAD_LIMIT_BYTES) return JSON.stringify(payload);

  const fallback = fitAlertPayload(notification, {
    notificationId: notification.id,
    type: notification.type,
    data: {},
    dataTruncated: true,
  });
  return JSON.stringify(fallback);
};

const getHeader = (headers: ApnsHttpResponse["headers"], name: string): string | undefined => {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
};

const parseRetryAt = (retryAfter: string | undefined, now: Date) => {
  if (!retryAfter) return new Date(now.getTime() + DEFAULT_RETRY_DELAY_MILLISECONDS);
  if (/^\d+$/.test(retryAfter)) {
    return new Date(now.getTime() + Number(retryAfter) * 1000);
  }

  const timestamp = Date.parse(retryAfter);
  return Number.isNaN(timestamp)
    ? new Date(now.getTime() + DEFAULT_RETRY_DELAY_MILLISECONDS)
    : new Date(timestamp);
};

const parseApnsBody = (body: string) => {
  try {
    const value = JSON.parse(body) as Record<string, unknown>;
    const rawReason = typeof value.reason === "string" ? value.reason : undefined;
    return {
      reason: rawReason && knownApnsReasons.has(rawReason) ? rawReason : undefined,
      timestamp: typeof value.timestamp === "number" ? value.timestamp : undefined,
    };
  } catch {
    return {};
  }
};

const parseApnsId = (value: string | undefined) =>
  value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;

const metadataForResponse = (
  response: ApnsHttpResponse,
  reason: string | undefined,
  timestamp: number | undefined,
) => {
  const metadata: PushProviderMetadata = {
    httpStatus: response.status,
  };
  const apnsId = parseApnsId(getHeader(response.headers, "apns-id"));
  const retryAfter = getHeader(response.headers, "retry-after");
  if (apnsId) metadata.apnsId = apnsId;
  if (reason) metadata.reason = reason;
  if (timestamp !== undefined) metadata.timestamp = timestamp;
  if (retryAfter && retryAfter.length <= 64) metadata.retryAfter = retryAfter;
  return metadata;
};

const attempt = (
  target: PushDeliveryTarget,
  outcome: PushDeliveryAttempt["outcome"],
  error: string | null,
  metadata: PushProviderMetadata,
  options: { disableToken?: boolean; retryAt?: Date } = {},
): PushDeliveryAttempt => ({
  target: { deliveryId: target.deliveryId, pushTokenId: target.pushTokenId },
  outcome,
  disableToken: options.disableToken ?? false,
  error,
  retryAt: options.retryAt ?? null,
  metadata,
});

export const classifyApnsResponse = (
  target: PushDeliveryTarget,
  response: ApnsHttpResponse,
  now: Date = new Date(),
): PushDeliveryAttempt => {
  const { reason, timestamp } = parseApnsBody(response.body);
  const metadata = metadataForResponse(response, reason, timestamp);
  const detail = reason ? `: ${reason}` : "";

  if (response.status === 200) return attempt(target, "accepted", null, metadata);
  if (response.status === 410 || (reason && permanentTokenReasons.has(reason))) {
    return attempt(
      target,
      "failed",
      `APNs rejected the device token (${response.status}${detail})`,
      metadata,
      {
        disableToken: true,
      },
    );
  }
  if (response.status === 403 || (reason && authenticationReasons.has(reason))) {
    return attempt(
      target,
      "failed",
      `APNs authentication failed (${response.status}${detail})`,
      metadata,
    );
  }
  if (response.status === 429) {
    return attempt(
      target,
      "retryable",
      `APNs throttled the notification (${response.status}${detail})`,
      metadata,
      {
        retryAt: parseRetryAt(getHeader(response.headers, "retry-after"), now),
      },
    );
  }
  if (response.status >= 500) {
    return attempt(
      target,
      "retryable",
      `APNs is temporarily unavailable (${response.status}${detail})`,
      metadata,
      {
        retryAt: parseRetryAt(getHeader(response.headers, "retry-after"), now),
      },
    );
  }
  if (response.status === 413 || reason === "PayloadTooLarge") {
    return attempt(
      target,
      "failed",
      `APNs rejected the payload size (${response.status}${detail})`,
      metadata,
    );
  }

  return attempt(
    target,
    "failed",
    `APNs rejected the notification (${response.status}${detail})`,
    metadata,
  );
};

type ApnsProviderOptions = {
  configuration?: ApnsConfiguration;
  transport?: ApnsHttpTransport;
  authorizationTokenProvider?: ApnsAuthorizationTokenProvider;
  now?: () => Date;
  createApnsId?: () => string;
};

export class ApnsProviderClient implements PushNotificationProvider {
  private configuration: ApnsConfiguration | undefined;
  private authorizationTokenProvider: ApnsAuthorizationTokenProvider | undefined;
  private readonly transport: ApnsHttpTransport;
  private readonly now: () => Date;
  private readonly createApnsId: () => string;

  constructor(options: ApnsProviderOptions = {}) {
    this.configuration = options.configuration;
    this.authorizationTokenProvider = options.authorizationTokenProvider;
    this.transport = options.transport ?? new NodeApnsHttp2Transport();
    this.now = options.now ?? (() => new Date());
    this.createApnsId = options.createApnsId ?? randomUUID;
  }

  async send(notification: Notification, deliveries: PushDeliveryTarget[]) {
    let configuration: ApnsConfiguration;
    let authorization: string;

    try {
      configuration = this.getConfiguration();
      authorization = this.getAuthorizationTokenProvider().getToken();
    } catch {
      return deliveries.map((target) =>
        attempt(target, "failed", "APNs provider configuration is invalid", {
          classification: "configuration",
        }),
      );
    }

    const body = buildApnsPayload(notification);
    return Promise.all(
      deliveries.map(async (target) => {
        if (!target.apnsEnvironment) {
          return attempt(target, "failed", "APNs delivery is missing its environment", {
            classification: "configuration",
          });
        }

        try {
          const response = await this.transport.request({
            host: apnsHosts[target.apnsEnvironment],
            path: `/3/device/${target.token}`,
            headers: {
              authorization: `bearer ${authorization}`,
              "apns-topic": configuration.topic,
              "apns-push-type": "alert",
              "apns-priority": "10",
              "apns-id": this.createApnsId(),
            },
            body,
          });

          return classifyApnsResponse(target, response, this.now());
        } catch {
          return attempt(
            target,
            "retryable",
            "APNs transport request failed",
            { classification: "transport" },
            { retryAt: new Date(this.now().getTime() + DEFAULT_RETRY_DELAY_MILLISECONDS) },
          );
        }
      }),
    );
  }

  private getConfiguration() {
    this.configuration ??= loadApnsConfiguration();
    return this.configuration;
  }

  private getAuthorizationTokenProvider() {
    this.authorizationTokenProvider ??= new ApnsJwtProvider(this.getConfiguration(), this.now);
    return this.authorizationTokenProvider;
  }
}
