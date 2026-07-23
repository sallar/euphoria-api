import { and, eq, isNull, sql } from "drizzle-orm";

import { user } from "@/db/auth-schema";
import { profile, profileUser, profileUserRoleValues } from "@/db/profile-schema";
import { db } from "@/lib/db";

type ProfileInsert = typeof profile.$inferInsert;
type ProfileUserRole = (typeof profileUserRoleValues)[number];

type DatabaseError = {
  cause?: unknown;
  code?: string;
  constraint?: string;
  constraint_name?: string;
};

export type ProfileInvariantErrorCode =
  | "active_profile_conflict"
  | "final_owner_required"
  | "membership_exists"
  | "membership_forbidden"
  | "membership_not_found"
  | "profile_not_found"
  | "solo_profile_membership_forbidden"
  | "user_not_found";

export type ProfileInvariantError = {
  code: ProfileInvariantErrorCode;
  message: string;
};

type ProfileMutationResult<Value> =
  | {
      ok: true;
      data: Value;
    }
  | {
      ok: false;
      error: ProfileInvariantError;
    };

const invariantErrors: Record<ProfileInvariantErrorCode, ProfileInvariantError> = {
  active_profile_conflict: {
    code: "active_profile_conflict",
    message: "User already belongs to an active profile",
  },
  final_owner_required: {
    code: "final_owner_required",
    message: "An active profile must retain at least one owner",
  },
  membership_exists: {
    code: "membership_exists",
    message: "User is already a member of this profile",
  },
  membership_forbidden: {
    code: "membership_forbidden",
    message: "Only an active profile owner can manage memberships",
  },
  membership_not_found: {
    code: "membership_not_found",
    message: "Profile membership not found",
  },
  profile_not_found: {
    code: "profile_not_found",
    message: "Active profile not found",
  },
  solo_profile_membership_forbidden: {
    code: "solo_profile_membership_forbidden",
    message: "Solo profiles cannot have additional members",
  },
  user_not_found: {
    code: "user_not_found",
    message: "User not found",
  },
};

const failure = (code: ProfileInvariantErrorCode) =>
  ({
    ok: false,
    error: invariantErrors[code],
  }) as const;

const getConstraintName = (error: unknown) => {
  let currentError = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!currentError || typeof currentError !== "object") return undefined;
    const databaseError = currentError as DatabaseError;
    const constraint = databaseError.constraint ?? databaseError.constraint_name;
    if (constraint) return constraint;
    currentError = databaseError.cause;
  }
  return undefined;
};

export const profileInvariantFailureForDatabaseError = (error: unknown) => {
  const constraint = getConstraintName(error);
  if (constraint === "profile_user_one_active_profile_check")
    return failure("active_profile_conflict");
  if (constraint === "profile_user_solo_membership_check")
    return failure("solo_profile_membership_forbidden");
  if (constraint === "profile_user_active_owner_check") return failure("final_owner_required");
  if (constraint === "profile_user_pkey") return failure("membership_exists");
  return undefined;
};

const lockProfileMembershipScope = (executor: { execute: typeof db.execute }, profileId: string) =>
  executor.execute(
    sql`select pg_advisory_xact_lock(
      hashtextextended(${"euphoria:profile-membership:profile:"} || ${profileId}, 0)
    )`,
  );

const findActorMembership = async (
  executor: Pick<typeof db, "select">,
  profileId: string,
  actorUserId: string,
) => {
  const [membership] = await executor
    .select({
      profileType: profile.profileType,
      role: profileUser.role,
    })
    .from(profileUser)
    .innerJoin(profile, eq(profile.id, profileUser.profileId))
    .where(
      and(
        eq(profileUser.profileId, profileId),
        eq(profileUser.userId, actorUserId),
        isNull(profile.deletedAt),
      ),
    )
    .limit(1);

  return membership;
};

export const createProfileForUser = async ({
  profileInput,
  userId,
}: {
  profileInput: ProfileInsert;
  userId: string;
}): Promise<ProfileMutationResult<typeof profile.$inferSelect>> => {
  try {
    const result = await db.transaction(async (tx) => {
      const [existingMembership] = await tx
        .select({ profileId: profileUser.profileId })
        .from(profileUser)
        .innerJoin(profile, eq(profile.id, profileUser.profileId))
        .where(and(eq(profileUser.userId, userId), isNull(profile.deletedAt)))
        .limit(1);

      if (existingMembership) return failure("active_profile_conflict");

      const [createdProfile] = await tx.insert(profile).values(profileInput).returning();
      await tx.insert(profileUser).values({
        profileId: createdProfile.id,
        userId,
        role: "owner",
      });

      return {
        ok: true as const,
        data: createdProfile,
      };
    });

    return result;
  } catch (error) {
    const mappedFailure = profileInvariantFailureForDatabaseError(error);
    if (mappedFailure) return mappedFailure;
    throw error;
  }
};

export const addProfileMember = async ({
  actorUserId,
  profileId,
  role,
  userId,
}: {
  actorUserId: string;
  profileId: string;
  role: ProfileUserRole;
  userId: string;
}): Promise<ProfileMutationResult<typeof profileUser.$inferSelect>> => {
  try {
    return await db.transaction(async (tx) => {
      await lockProfileMembershipScope(tx, profileId);
      const actorMembership = await findActorMembership(tx, profileId, actorUserId);
      if (!actorMembership) return failure("profile_not_found");
      if (actorMembership.role !== "owner") return failure("membership_forbidden");
      if (actorMembership.profileType === "solo")
        return failure("solo_profile_membership_forbidden");

      const [targetUser] = await tx
        .select({ id: user.id })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1);
      if (!targetUser) return failure("user_not_found");

      const [existingMembership] = await tx
        .select({ profileId: profileUser.profileId })
        .from(profileUser)
        .where(and(eq(profileUser.profileId, profileId), eq(profileUser.userId, userId)))
        .limit(1);
      if (existingMembership) return failure("membership_exists");

      const [membership] = await tx
        .insert(profileUser)
        .values({ profileId, userId, role })
        .returning();

      return {
        ok: true as const,
        data: membership,
      };
    });
  } catch (error) {
    const mappedFailure = profileInvariantFailureForDatabaseError(error);
    if (mappedFailure) return mappedFailure;
    throw error;
  }
};

export const removeProfileMember = async ({
  actorUserId,
  profileId,
  userId,
}: {
  actorUserId: string;
  profileId: string;
  userId: string;
}): Promise<ProfileMutationResult<typeof profileUser.$inferSelect>> => {
  try {
    return await db.transaction(async (tx) => {
      await lockProfileMembershipScope(tx, profileId);
      const actorMembership = await findActorMembership(tx, profileId, actorUserId);
      if (!actorMembership) return failure("profile_not_found");
      if (actorMembership.role !== "owner") return failure("membership_forbidden");

      const [removedMembership] = await tx
        .delete(profileUser)
        .where(and(eq(profileUser.profileId, profileId), eq(profileUser.userId, userId)))
        .returning();
      if (!removedMembership) return failure("membership_not_found");

      return {
        ok: true as const,
        data: removedMembership,
      };
    });
  } catch (error) {
    const mappedFailure = profileInvariantFailureForDatabaseError(error);
    if (mappedFailure) return mappedFailure;
    throw error;
  }
};

export const setProfileMemberRole = async ({
  actorUserId,
  profileId,
  role,
  userId,
}: {
  actorUserId: string;
  profileId: string;
  role: ProfileUserRole;
  userId: string;
}): Promise<ProfileMutationResult<typeof profileUser.$inferSelect>> => {
  try {
    return await db.transaction(async (tx) => {
      await lockProfileMembershipScope(tx, profileId);
      const actorMembership = await findActorMembership(tx, profileId, actorUserId);
      if (!actorMembership) return failure("profile_not_found");
      if (actorMembership.role !== "owner") return failure("membership_forbidden");

      const [updatedMembership] = await tx
        .update(profileUser)
        .set({ role })
        .where(and(eq(profileUser.profileId, profileId), eq(profileUser.userId, userId)))
        .returning();
      if (!updatedMembership) return failure("membership_not_found");

      return {
        ok: true as const,
        data: updatedMembership,
      };
    });
  } catch (error) {
    const mappedFailure = profileInvariantFailureForDatabaseError(error);
    if (mappedFailure) return mappedFailure;
    throw error;
  }
};
