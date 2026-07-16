import { Parser } from "@asyncapi/parser";
import { Value } from "@sinclair/typebox/value";
import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, test } from "bun:test";

import { application } from "@/app";
import { createMobileAsyncApiDocument } from "@/lib/asyncapi-document";
import { createMobileOpenApiDocument } from "@/lib/openapi-document";
import {
  ChatClientCommand,
  ChatServerEvent,
  chatClientCommandRegistry,
  chatServerEventRegistry,
} from "@/models/chat";
import {
  NotificationClientCommand,
  NotificationReadEvent,
  NotificationServerEvent,
  notificationClientCommandRegistry,
  notificationServerEventRegistry,
} from "@/models/notification";
import {
  REALTIME_CONTRACT_VERSION,
  REALTIME_HEARTBEAT_INTERVAL_SECONDS,
  REALTIME_PROTOCOL_VERSION,
} from "@/models/realtime";

type JsonObject = Record<string, any>;

const asyncApiDocument = createMobileAsyncApiDocument(application) as JsonObject;
const mobileOpenApiDocument = createMobileOpenApiDocument(application) as JsonObject;
const testUuid = "00000000-0000-4000-8000-000000000000";
const registryContracts = [
  {
    envelopeName: "ChatClientCommand",
    operationName: "receiveChatCommands",
    channelName: "chat",
    runtimeUnion: ChatClientCommand,
    registry: chatClientCommandRegistry,
  },
  {
    envelopeName: "ChatServerEvent",
    operationName: "sendChatEvents",
    channelName: "chat",
    runtimeUnion: ChatServerEvent,
    registry: chatServerEventRegistry,
  },
  {
    envelopeName: "NotificationClientCommand",
    operationName: "receiveNotificationCommands",
    channelName: "notifications",
    runtimeUnion: NotificationClientCommand,
    registry: notificationClientCommandRegistry,
  },
  {
    envelopeName: "NotificationServerEvent",
    operationName: "sendNotificationEvents",
    channelName: "notifications",
    runtimeUnion: NotificationServerEvent,
    registry: notificationServerEventRegistry,
  },
] as const;

describe("mobile AsyncAPI contract", () => {
  test("validates as AsyncAPI 3.1 with the official parser", async () => {
    const parser = new Parser();
    const { diagnostics, document } = await parser.parse(JSON.stringify(asyncApiDocument));

    expect(asyncApiDocument.asyncapi).toBe("3.1.0");
    expect(diagnostics).toEqual([]);
    expect(document).toBeDefined();
  });

  test("is served from the hidden unauthenticated endpoint", async () => {
    const response = await application.handle(new Request("http://localhost/asyncapi/mobile.json"));
    const document = await response.json();

    expect(response.status).toBe(200);
    expect(document.asyncapi).toBe("3.1.0");
    expect(document.info.title).toBe("Euphoria Mobile Realtime API");
  });

  test("publishes the expected metadata, servers, channels, and directions", () => {
    expect(asyncApiDocument.info).toMatchObject({
      title: "Euphoria Mobile Realtime API",
      version: REALTIME_CONTRACT_VERSION,
    });
    expect(asyncApiDocument.defaultContentType).toBe("application/json");
    expect(asyncApiDocument.servers.local).toMatchObject({
      host: "localhost:3000",
      protocol: "ws",
    });
    expect(asyncApiDocument.servers.production).toMatchObject({
      host: "euphoria-api.sallar.dev",
      protocol: "wss",
    });
    expect(asyncApiDocument.channels.chat.address).toBe("/api/chat/profiles/{profileId}/ws");
    expect(asyncApiDocument.channels.notifications.address).toBe("/api/notifications/ws");
    expect(asyncApiDocument.operations.receiveChatCommands.action).toBe("receive");
    expect(asyncApiDocument.operations.sendChatEvents.action).toBe("send");
    expect(asyncApiDocument.operations.receiveNotificationCommands.action).toBe("receive");
    expect(asyncApiDocument.operations.sendNotificationEvents.action).toBe("send");
  });

  test("derives runtime unions and published operation messages from the registries", () => {
    for (const contract of registryContracts) {
      const runtimeVariants = (contract.runtimeUnion as JsonObject).anyOf;
      expect(runtimeVariants).toHaveLength(contract.registry.length);
      runtimeVariants.forEach((schema: unknown, index: number) => {
        expect(schema).toBe(contract.registry[index]!.schema);
      });

      const expectedMessageReferences = contract.registry.map(({ name }) => ({
        $ref: `#/channels/${contract.channelName}/messages/${name}`,
      }));
      expect(asyncApiDocument.operations[contract.operationName].messages).toEqual(
        expectedMessageReferences,
      );
    }

    expect(chatClientCommandRegistry).toHaveLength(8);
    expect(chatServerEventRegistry).toHaveLength(12);
    expect(notificationClientCommandRegistry).toHaveLength(3);
    expect(notificationServerEventRegistry).toHaveLength(6);
  });

  test("creates one message with a valid example for every variant", () => {
    const allVariants = registryContracts.flatMap(({ registry }) => [...registry]);
    expect(Object.keys(asyncApiDocument.components.messages)).toHaveLength(29);

    for (const variant of allVariants) {
      const message = asyncApiDocument.components.messages[variant.name];
      expect(message.payload).toEqual({
        $ref: `#/components/schemas/${variant.name}`,
      });
      expect(message.examples).toHaveLength(1);

      const validate = componentValidator(asyncApiDocument, variant.name);
      expect(validate(message.examples[0].payload)).toBeTrue();
      expect(validate.errors).toBeNull();
    }
  });

  test("publishes complete unique OpenAPI discriminators and only named oneOf references", () => {
    for (const contract of registryContracts) {
      const envelope = mobileOpenApiDocument.components.schemas[contract.envelopeName];
      const expectedMapping = Object.fromEntries(
        contract.registry.map(({ name, wireType }) => [wireType, `#/components/schemas/${name}`]),
      );
      const expectedReferences = Object.values(expectedMapping);

      expect(envelope.discriminator.propertyName).toBe("type");
      expect(envelope.discriminator.mapping).toEqual(expectedMapping);
      expect(new Set(expectedReferences).size).toBe(contract.registry.length);
      expect(envelope.oneOf).toEqual(expectedReferences.map(($ref) => ({ $ref })));
      expect(envelope.anyOf).toBeUndefined();

      for (const variant of contract.registry) {
        const schema = mobileOpenApiDocument.components.schemas[variant.name];
        expect(schema.required).toContain("type");
        expect(schema.properties.type).toEqual({
          const: variant.wireType,
          type: "string",
        });
      }
    }
  });

  test("keeps every shared realtime schema identical to mobile OpenAPI", () => {
    for (const [name, schema] of Object.entries(asyncApiDocument.components.schemas)) {
      expect(mobileOpenApiDocument.components.schemas[name]).toEqual(schema);
    }
  });

  test("reuses the required nullable Notification payload for read events", () => {
    const asyncApiEvent = asyncApiDocument.components.schemas.NotificationReadEvent;
    const openApiEvent = mobileOpenApiDocument.components.schemas.NotificationReadEvent;
    const expectedPayload = {
      $ref: "#/components/schemas/Notification",
      type: ["object", "null"],
    };

    expect(asyncApiEvent.required).toContain("notification");
    expect(asyncApiEvent.properties.notification).toEqual(expectedPayload);
    expect(openApiEvent.properties.notification).toEqual(expectedPayload);
    expect(asyncApiEvent).toEqual(openApiEvent);
    expect(
      Value.Check(NotificationReadEvent, { type: "notification_read", notification: null }),
    ).toBeTrue();
    expect(Value.Check(NotificationReadEvent, { type: "notification_read" })).toBeFalse();
  });

  test("documents bearer-authenticated GET handshakes and authorization failures", () => {
    expect(asyncApiDocument.components.securitySchemes.bearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
    });

    for (const server of Object.values(asyncApiDocument.servers) as JsonObject[]) {
      expect(server.security).toEqual([{ $ref: "#/components/securitySchemes/bearerAuth" }]);
    }

    for (const channel of Object.values(asyncApiDocument.channels) as JsonObject[]) {
      expect(channel.bindings.ws.bindingVersion).toBe("0.1.0");
      expect(channel.bindings.ws.method).toBe("GET");
      expect(channel.bindings.ws.headers.required).toEqual(["Authorization"]);
      expect(channel.bindings.ws.headers.properties.Authorization.pattern).toBe("^Bearer .+$");
      expect(channel["x-handshake-errors"]["401"]).toBeString();
    }
  });

  test("documents correlation, heartbeat, close, protocol, and recovery semantics", () => {
    expect(asyncApiDocument.components.correlationIds.clientMessageId.location).toBe(
      "$message.payload#/clientMessageId",
    );

    const correlatedMessages = Object.entries(asyncApiDocument.components.messages)
      .filter(([, message]: [string, any]) => message.correlationId !== undefined)
      .map(([name]) => name);
    expect(correlatedMessages).toEqual([
      "ChatSendMessageCommand",
      "ChatMessageEvent",
      "ChatErrorEvent",
    ]);

    expect(asyncApiDocument["x-frame-format"]).toMatchObject({
      frameType: "text",
      payload: "JSON",
      binaryFramesSupported: false,
    });
    expect(asyncApiDocument["x-heartbeat"]).toMatchObject({
      intervalSeconds: REALTIME_HEARTBEAT_INTERVAL_SECONDS,
      commandType: "ping",
      eventType: "pong",
    });
    expect(asyncApiDocument.channels.chat["x-close-codes"]["1008"]).toBeString();
    expect(asyncApiDocument["x-protocol-version"].current).toBe(REALTIME_PROTOCOL_VERSION);
    expect(asyncApiDocument["x-recovery"]).toMatchObject({
      replay: false,
      cursor: false,
      resumeToken: false,
      durableSocketEventId: false,
      restReconciliationRequiredAfterReconnect: true,
      clientMessageIdReplaySafe: false,
    });
    expect(asyncApiDocument["x-compatibility"].additiveChanges.length).toBeGreaterThan(0);
    expect(asyncApiDocument["x-compatibility"].breakingChanges.length).toBeGreaterThan(0);
  });

  test("requires protocolVersion 1 on both connected events", () => {
    for (const schemaName of ["ChatConnectedEvent", "NotificationConnectedEvent"]) {
      const schema = asyncApiDocument.components.schemas[schemaName];
      expect(schema.required).toContain("protocolVersion");
      expect(schema.properties.protocolVersion).toMatchObject({
        const: REALTIME_PROTOCOL_VERSION,
        type: "number",
      });
    }
  });

  test("rejects invalid runtime discriminators and malformed command payloads", () => {
    expect(Value.Check(ChatClientCommand, { type: "unknown" })).toBeFalse();
    expect(
      Value.Check(ChatClientCommand, {
        type: "send_message",
        conversationId: testUuid,
        text: "",
      }),
    ).toBeFalse();
    expect(Value.Check(NotificationClientCommand, { type: "mark_read" })).toBeFalse();
    expect(
      Value.Check(ChatServerEvent, {
        type: "connected",
        profileId: testUuid,
      }),
    ).toBeFalse();
  });

  test("rejects invalid published envelope fixtures", () => {
    const chatValidator = componentValidator(mobileOpenApiDocument, "ChatClientCommand");
    const notificationValidator = componentValidator(
      mobileOpenApiDocument,
      "NotificationClientCommand",
    );

    expect(chatValidator({ type: "not_a_command" })).toBeFalse();
    expect(
      chatValidator({
        type: "typing",
        conversationId: testUuid,
      }),
    ).toBeFalse();
    expect(notificationValidator({ type: "mark_read" })).toBeFalse();
  });

  test("keeps WebSocket paths out of mobile OpenAPI", () => {
    expect(
      Object.keys(mobileOpenApiDocument.paths).some((path) => path.includes("/ws")),
    ).toBeFalse();
  });
});

function componentValidator(document: JsonObject, schemaName: string) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);

  return ajv.compile({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $ref: `#/components/schemas/${schemaName}`,
    components: {
      schemas: structuredClone(document.components.schemas),
    },
  });
}
