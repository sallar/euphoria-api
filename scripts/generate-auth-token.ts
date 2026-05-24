const userId = process.argv[2]?.trim();

if (!userId || userId === "--help" || userId === "-h") {
  console.error("Usage: bun run auth:token <user-id>");
  process.exit(userId ? 0 : 1);
}

try {
  const { betterAuth } = await import("@/lib/auth");
  const context = await betterAuth.$context;
  const user = await context.internalAdapter.findUserById(userId);

  if (!user) {
    console.error(`No Better Auth user found for id: ${userId}`);
    process.exit(1);
  }

  const session = await context.internalAdapter.createSession(userId);

  console.log(`Created Better Auth session for ${user.email} (${user.id})`);
  console.log(`Expires: ${session.expiresAt.toISOString()}`);
  console.log("");
  console.log(session.token);
  console.log("");
  console.log("Use it with:");
  console.log(`Authorization: Bearer ${session.token}`);
  console.log("");
  console.log(`curl -H "Authorization: Bearer ${session.token}" http://localhost:3000/api/profile`);
  process.exit(0);
} catch (error) {
  console.error("Failed to generate Better Auth token");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

export {};
