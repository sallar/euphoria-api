import { sendRandomTestNotification } from "@/services/test-notification-service";

const userId = process.argv[2]?.trim();

const main = async () => {
  if (!userId || userId === "--help" || userId === "-h") {
    console.error("Usage: bun run notifications:test <user-id>");
    process.exit(userId ? 0 : 1);
  }

  const result = await sendRandomTestNotification(userId);
  if (!result) {
    console.error(`No Better Auth user found for id: ${userId}`);
    process.exit(1);
  }

  console.log(
    `Sent ${result.notification.type} notification to ${result.recipient.email} (${result.recipient.id})`,
  );
  console.log(`Notification ID: ${result.notification.id}`);
  console.log(`Title: ${result.notification.title}`);
  console.log(`Body: ${result.notification.body}`);
  console.log("");
  console.log(
    "Note: this script writes to the database. Use POST /api/notifications/test/:userId to test websocket delivery.",
  );
};

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error("Failed to send test notification");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

export {};
