import "dotenv/config";
export declare const db: import("drizzle-orm/bun-sql/postgres/driver").BunSQLDatabase<Record<string, never>, import("drizzle-orm").ExtractTablesWithRelations<{
    account: {
        user: import("drizzle-orm").One<"user", true>;
    };
    user: {
        accounts: import("drizzle-orm").Many<"account">;
        profiles: import("drizzle-orm").Many<"profile">;
        sessions: import("drizzle-orm").Many<"session">;
    };
    profile: {
        users: import("drizzle-orm").Many<"user">;
    };
    session: {
        user: import("drizzle-orm").One<"user", true>;
    };
}, import("drizzle-orm").ExtractTablesFromSchema<typeof import("../db/schema")>>> & {
    $client: SQL;
};
