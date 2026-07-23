export const CHAT_MESSAGE_SEND_COMMAND_NAME = "chat.message.send" as const;
export const CHAT_MESSAGE_SEND_COMMAND_VERSION = 1 as const;
export const CHAT_MESSAGE_SEND_RESULT_VERSION = 1 as const;
export const CHAT_EVENT_VERSION = 1 as const;
export const NOTIFICATION_PUSH_DELIVERY_JOB_KIND = "notification.push.deliver" as const;
export const NOTIFICATION_PUSH_DELIVERY_JOB_VERSION = 1 as const;

export type TransactionalChatPolicy = {
  commandRetentionSeconds: number;
  eventRetentionSeconds: number;
  pushJobAvailableInSeconds: number;
  pushJobMaxAttempts: number;
  pushJobTerminalRetentionSeconds: number;
};

const parseInteger = ({
  allowZero = false,
  env,
  name,
}: {
  allowZero?: boolean;
  env: NodeJS.ProcessEnv;
  name: string;
}) => {
  const raw = env[name];
  const value = raw === undefined ? Number.NaN : Number(raw);
  const valid = Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0);

  if (!valid) {
    const expectation = allowZero ? "a nonnegative" : "a positive";
    throw new Error(`${name} must be explicitly configured as ${expectation} safe integer`);
  }

  return value;
};

export const readTransactionalChatPolicy = (
  env: NodeJS.ProcessEnv = process.env,
): TransactionalChatPolicy => ({
  commandRetentionSeconds: parseInteger({
    env,
    name: "CHAT_COMMAND_RETENTION_SECONDS",
  }),
  eventRetentionSeconds: parseInteger({
    env,
    name: "CHAT_EVENT_RETENTION_SECONDS",
  }),
  pushJobAvailableInSeconds: parseInteger({
    allowZero: true,
    env,
    name: "NOTIFICATION_PUSH_JOB_AVAILABLE_IN_SECONDS",
  }),
  pushJobMaxAttempts: parseInteger({
    env,
    name: "NOTIFICATION_PUSH_JOB_MAX_ATTEMPTS",
  }),
  pushJobTerminalRetentionSeconds: parseInteger({
    env,
    name: "NOTIFICATION_PUSH_JOB_TERMINAL_RETENTION_SECONDS",
  }),
});
