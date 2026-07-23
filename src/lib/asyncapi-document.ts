import type { AnyElysia } from "elysia";

import { chatClientCommandRegistry, chatServerEventRegistry } from "@/models/chat";
import {
  notificationClientCommandRegistry,
  notificationServerEventRegistry,
} from "@/models/notification";
import {
  REALTIME_CONTRACT_VERSION,
  REALTIME_HEARTBEAT_INTERVAL_SECONDS,
  REALTIME_PROTOCOL_VERSION,
  type RealtimeSchemaVariant,
} from "@/models/realtime";

import { createRealtimeSchemaComponents, realtimeEnvelopeNames } from "./openapi-document";

type AsyncApiObject = Record<string, unknown>;

const chatChannelMessages = [...chatClientCommandRegistry, ...chatServerEventRegistry];
const notificationChannelMessages = [
  ...notificationClientCommandRegistry,
  ...notificationServerEventRegistry,
];

export function createMobileAsyncApiDocument(app: AnyElysia): AsyncApiObject {
  return {
    asyncapi: "3.1.0",
    info: {
      title: "Euphoria Mobile Realtime API",
      version: REALTIME_CONTRACT_VERSION,
      description:
        "Canonical backend-owned WebSocket contract for the Euphoria mobile client. The backend receives commands and sends events. Frames are UTF-8 JSON text frames. Realtime delivery is transient; clients must reconcile against the REST API after every reconnect.",
    },
    defaultContentType: "application/json",
    servers: {
      local: {
        host: "localhost:3000",
        protocol: "ws",
        description: "Local Euphoria API WebSocket server",
        security: [{ $ref: "#/components/securitySchemes/bearerAuth" }],
      },
      production: {
        host: "euphoria-api.sallar.dev",
        protocol: "wss",
        description: "Production Euphoria API WebSocket server",
        security: [{ $ref: "#/components/securitySchemes/bearerAuth" }],
      },
    },
    channels: {
      chat: {
        address: "/api/chat/profiles/{profileId}/ws",
        description:
          "Authenticated profile-scoped chat socket. A missing or invalid bearer session fails the HTTP upgrade with 401. An inaccessible profile produces a chat error and closes with policy-violation code 1008. After reconnect, reconcile conversations, messages, read state, reactions, and presence assumptions through REST before treating socket events as current.",
        parameters: {
          profileId: {
            description:
              "Current active profile UUID for which the authenticated user has an owner or member role. It defines chat authorization and event scope.",
            examples: ["00000000-0000-4000-8000-000000000001"],
          },
        },
        messages: channelMessageReferences(chatChannelMessages),
        bindings: websocketChannelBinding(),
        "x-handshake-errors": {
          "401": "Authentication is missing, invalid, expired, or inactive.",
        },
        "x-close-codes": {
          "1008": "The authenticated user cannot use the requested chat profile.",
        },
      },
      notifications: {
        address: "/api/notifications/ws",
        description:
          "Authenticated user-scoped notification socket. A missing or invalid bearer session fails the HTTP upgrade with 401. After reconnect, reconcile the notification list and unread count through REST before treating socket events as current.",
        messages: channelMessageReferences(notificationChannelMessages),
        bindings: websocketChannelBinding(),
        "x-handshake-errors": {
          "401": "Authentication is missing, invalid, expired, or inactive.",
        },
      },
    },
    operations: {
      receiveChatCommands: {
        action: "receive",
        title: "Receive chat commands",
        description:
          "The backend receives chat commands from the mobile client. clientMessageId is correlation-only, is not persisted, provides no idempotency guarantee, and must not be blindly replayed after reconnect.",
        channel: { $ref: "#/channels/chat" },
        messages: channelOperationMessageReferences("chat", chatClientCommandRegistry),
        security: [{ $ref: "#/components/securitySchemes/bearerAuth" }],
      },
      sendChatEvents: {
        action: "send",
        title: "Send chat events",
        description:
          "The backend sends transient chat events to the mobile client. Events have no replay cursor or durable event identifier.",
        channel: { $ref: "#/channels/chat" },
        messages: channelOperationMessageReferences("chat", chatServerEventRegistry),
        security: [{ $ref: "#/components/securitySchemes/bearerAuth" }],
      },
      receiveNotificationCommands: {
        action: "receive",
        title: "Receive notification commands",
        description: "The backend receives notification commands from the mobile client.",
        channel: { $ref: "#/channels/notifications" },
        messages: channelOperationMessageReferences(
          "notifications",
          notificationClientCommandRegistry,
        ),
        security: [{ $ref: "#/components/securitySchemes/bearerAuth" }],
      },
      sendNotificationEvents: {
        action: "send",
        title: "Send notification events",
        description:
          "The backend sends transient notification events to the mobile client. Events have no replay cursor or durable event identifier.",
        channel: { $ref: "#/channels/notifications" },
        messages: channelOperationMessageReferences(
          "notifications",
          notificationServerEventRegistry,
        ),
        security: [{ $ref: "#/components/securitySchemes/bearerAuth" }],
      },
    },
    components: {
      messages: componentMessages([...chatChannelMessages, ...notificationChannelMessages]),
      schemas: createAsyncApiSchemaComponents(app),
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "Better Auth session token",
          description:
            "Better Auth bearer session token sent in the Authorization header during the WebSocket HTTP upgrade.",
        },
      },
      correlationIds: {
        clientMessageId: {
          description:
            "Ephemeral chat command correlation value. This is not a durable message ID or idempotency key.",
          location: "$message.payload#/clientMessageId",
        },
      },
    },
    "x-frame-format": {
      frameType: "text",
      encoding: "UTF-8",
      payload: "JSON",
      binaryFramesSupported: false,
    },
    "x-heartbeat": {
      mechanism: "application-level ping/pong",
      intervalSeconds: REALTIME_HEARTBEAT_INTERVAL_SECONDS,
      initiator: "client",
      commandType: "ping",
      eventType: "pong",
    },
    "x-protocol-version": {
      current: REALTIME_PROTOCOL_VERSION,
      announcedBy: ["ChatConnectedEvent", "NotificationConnectedEvent"],
      behavior:
        "The connected event announces protocolVersion before normal processing. A client that does not support the announced value must stop processing that socket and update before reconnecting.",
    },
    "x-recovery": {
      replay: false,
      cursor: false,
      resumeToken: false,
      durableSocketEventId: false,
      restReconciliationRequiredAfterReconnect: true,
      clientMessageIdReplaySafe: false,
      description:
        "Socket delivery is best-effort and in-memory. After every reconnect, clients must refresh canonical state through REST. clientMessageId correlates a live send_message result only and must not be blindly replayed.",
    },
    "x-compatibility": {
      additiveChanges: [
        "New optional fields that old clients can ignore.",
        "New client command variants that do not change existing command behavior.",
      ],
      breakingChanges: [
        "Removing or renaming a field or wire discriminator.",
        "Changing a field type, nullability, requiredness, or meaning.",
        "Adding a server event variant unless all supported clients safely ignore unknown discriminators.",
        "Changing heartbeat, recovery, authentication, or close semantics.",
      ],
      versioning:
        "Breaking wire changes require a contract major version and a new protocolVersion. Description and example-only corrections are patch changes.",
    },
  };
}

function createAsyncApiSchemaComponents(app: AnyElysia) {
  const schemas = createRealtimeSchemaComponents(app);
  for (const envelopeName of realtimeEnvelopeNames) delete schemas[envelopeName];
  return schemas;
}

function componentMessages(registry: readonly RealtimeSchemaVariant[]) {
  return Object.fromEntries(
    registry.map((variant) => [
      variant.name,
      {
        name: variant.name,
        title: variant.summary,
        summary: variant.summary,
        description: variant.description,
        contentType: "application/json",
        payload: { $ref: `#/components/schemas/${variant.name}` },
        examples: [
          {
            name: `${variant.name}Example`,
            summary: variant.summary,
            payload: variant.example,
          },
        ],
        ...(variant.correlationId
          ? { correlationId: { $ref: "#/components/correlationIds/clientMessageId" } }
          : {}),
      },
    ]),
  );
}

function channelMessageReferences(registry: readonly RealtimeSchemaVariant[]) {
  return Object.fromEntries(
    registry.map(({ name }) => [name, { $ref: `#/components/messages/${name}` }]),
  );
}

function channelOperationMessageReferences(
  channelName: string,
  registry: readonly RealtimeSchemaVariant[],
) {
  return registry.map(({ name }) => ({
    $ref: `#/channels/${channelName}/messages/${name}`,
  }));
}

function websocketChannelBinding() {
  return {
    ws: {
      method: "GET",
      headers: {
        type: "object",
        required: ["Authorization"],
        properties: {
          Authorization: {
            type: "string",
            pattern: "^Bearer .+$",
            description: "Better Auth bearer session token using the Bearer scheme.",
          },
        },
      },
      bindingVersion: "0.1.0",
    },
  };
}
