import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { application } from "@/app";
import { betterAuth } from "@/lib/auth";
import { CursorError } from "@/lib/cursor";
import { findActiveProfileMembership } from "@/lib/profile-queries";
import { listChatConversations } from "@/services/chat-service";
import { listProfileFeed } from "@/services/feed-service";
import { listNotifications } from "@/services/notification-service";
import {
  addProfileMember,
  createProfileForUser,
  removeProfileMember,
  setProfileMemberRole,
} from "@/services/profile-membership-service";

import { createIntegrationHarness, type IntegrationHarness } from "./harness";

const integrationTest = process.env.RUN_INTEGRATION_TESTS === "1" ? test : test.skip;

const profileInput = (name: string, profileType: "solo" | "couple" | "group") => ({
  profileType,
  name,
  bio: `${name} integration fixture`,
  gender: "man" as const,
  genderTags: ["cis_man" as const],
  genderInterests: ["woman" as const],
  orientation: "heterosexual" as const,
  orientationInterests: ["heterosexual" as const],
  relationshipTypes: ["dating" as const],
  location: { x: 24.94, y: 60.17 },
  country: "FI",
  dateOfBirth: "1990-01-01",
});

const insertUser = async (harness: IntegrationHarness, prefix: string) => {
  const id = `${prefix}-${randomUUID()}`;
  const now = new Date();
  await harness.postgres`
    insert into public."user" (
      id, name, email, email_verified, created_at, updated_at
    )
    values (
      ${id},
      ${prefix},
      ${`${id}@example.test`},
      true,
      ${now},
      ${now}
    )
  `;
  return id;
};

const cleanupFixtures = async (
  harness: IntegrationHarness,
  profileIds: Iterable<string>,
  userIds: Iterable<string>,
) => {
  for (const profileId of profileIds) {
    await harness.postgres`delete from public.profile where id = ${profileId}`;
  }
  for (const userId of userIds) {
    await harness.postgres`delete from public."user" where id = ${userId}`;
  }
  await harness.cleanup();
};

const createProfile = async (
  userId: string,
  name: string,
  profileType: "solo" | "couple" | "group",
) => {
  const result = await createProfileForUser({
    profileInput: profileInput(name, profileType),
    userId,
  });
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
};

describe("F2 profile ownership against migrated PostgreSQL", () => {
  integrationTest(
    "serializes concurrent profile creation and returns stable bootstrap conflicts",
    async () => {
      const harness = await createIntegrationHarness("profile_create");
      const userIds = new Set<string>();
      const profileIds = new Set<string>();

      try {
        const userId = await insertUser(harness, "profile-create");
        userIds.add(userId);
        const authContext = await betterAuth.$context;
        const session = await authContext.internalAdapter.createSession(userId);
        const authorization = { authorization: `Bearer ${session.token}` };

        const crossUserTestNotificationResponse = await application.handle(
          new Request("http://localhost/api/notifications/test/another-user", {
            headers: authorization,
          }),
        );
        expect(crossUserTestNotificationResponse.status).toBe(403);
        expect(await crossUserTestNotificationResponse.json()).toEqual({
          code: "forbidden",
          message: "Test notifications can only be sent to the authenticated user",
        });

        const zeroProfileResponse = await application.handle(
          new Request("http://localhost/api/profile/", { headers: authorization }),
        );
        expect(zeroProfileResponse.status).toBe(200);
        expect(await zeroProfileResponse.json()).toEqual([]);

        const attempts = await Promise.all([
          createProfileForUser({
            profileInput: profileInput("Concurrent Profile A", "solo"),
            userId,
          }),
          createProfileForUser({
            profileInput: profileInput("Concurrent Profile B", "solo"),
            userId,
          }),
        ]);
        expect(attempts.filter((result) => result.ok)).toHaveLength(1);
        expect(attempts.filter((result) => !result.ok)).toEqual([
          {
            ok: false,
            error: {
              code: "active_profile_conflict",
              message: "User already belongs to an active profile",
            },
          },
        ]);

        const [created] = attempts.filter((result) => result.ok);
        if (!created?.ok) throw new Error("Expected one created profile");
        profileIds.add(created.data.id);

        const oneProfileResponse = await application.handle(
          new Request("http://localhost/api/profile/", { headers: authorization }),
        );
        expect(oneProfileResponse.status).toBe(200);
        const bootstrapProfiles = await oneProfileResponse.json();
        expect(bootstrapProfiles).toHaveLength(1);
        expect(bootstrapProfiles[0].id).toBe(created.data.id);

        const conflictResponse = await application.handle(
          new Request("http://localhost/api/profile/", {
            method: "POST",
            headers: {
              ...authorization,
              "content-type": "application/json",
            },
            body: JSON.stringify(profileInput("Route Conflict", "solo")),
          }),
        );
        expect(conflictResponse.status).toBe(409);
        expect(await conflictResponse.json()).toEqual({
          code: "active_profile_conflict",
          message: "User already belongs to an active profile",
        });

        await harness.postgres`
          update public.profile
          set deleted_at = now()
          where id = ${created.data.id}
        `;

        const deletedBootstrapResponse = await application.handle(
          new Request("http://localhost/api/profile/", { headers: authorization }),
        );
        expect(deletedBootstrapResponse.status).toBe(200);
        expect(await deletedBootstrapResponse.json()).toEqual([]);

        const replacement = await createProfile(userId, "Replacement Profile", "solo");
        profileIds.add(replacement.id);
        const [membershipCounts] = await harness.postgres`
          select
            count(*)::integer as total_memberships,
            count(*) filter (where owned_profile.deleted_at is null)::integer as active_memberships
          from public.profile_user membership
          inner join public.profile owned_profile on owned_profile.id = membership.profile_id
          where membership.user_id = ${userId}
        `;
        expect(membershipCounts).toMatchObject({
          total_memberships: 2,
          active_memberships: 1,
        });
      } finally {
        await cleanupFixtures(harness, profileIds, userIds);
      }
    },
    30_000,
  );

  integrationTest(
    "prevents concurrent service and direct membership changes from selecting two active profiles",
    async () => {
      const harness = await createIntegrationHarness("profile_membership_race");
      const userIds = new Set<string>();
      const profileIds = new Set<string>();

      try {
        const ownerOneId = await insertUser(harness, "membership-owner-one");
        const ownerTwoId = await insertUser(harness, "membership-owner-two");
        const targetUserId = await insertUser(harness, "membership-target");
        const directTargetUserId = await insertUser(harness, "membership-direct-target");
        [ownerOneId, ownerTwoId, targetUserId, directTargetUserId].forEach((id) => userIds.add(id));

        const profileOne = await createProfile(ownerOneId, "Shared One", "couple");
        const profileTwo = await createProfile(ownerTwoId, "Shared Two", "group");
        profileIds.add(profileOne.id);
        profileIds.add(profileTwo.id);

        const serviceAttempts = await Promise.all([
          addProfileMember({
            actorUserId: ownerOneId,
            profileId: profileOne.id,
            role: "member",
            userId: targetUserId,
          }),
          addProfileMember({
            actorUserId: ownerTwoId,
            profileId: profileTwo.id,
            role: "member",
            userId: targetUserId,
          }),
        ]);
        expect(serviceAttempts.filter((result) => result.ok)).toHaveLength(1);
        expect(
          serviceAttempts.filter((result) => !result.ok).map((result) => result.error.code),
        ).toEqual(["active_profile_conflict"]);

        const [serviceCardinality] = await harness.postgres`
          select count(*)::integer as count
          from public.profile_user membership
          inner join public.profile active_profile
            on active_profile.id = membership.profile_id
            and active_profile.deleted_at is null
          where membership.user_id = ${targetUserId}
        `;
        expect(serviceCardinality?.count).toBe(1);

        const directAttempts = await Promise.allSettled([
          harness.postgres`
            insert into public.profile_user (profile_id, user_id, role)
            values (${profileOne.id}, ${directTargetUserId}, 'member')
          `,
          harness.postgres`
            insert into public.profile_user (profile_id, user_id, role)
            values (${profileTwo.id}, ${directTargetUserId}, 'member')
          `,
        ]);
        expect(directAttempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
        const [rejectedAttempt] = directAttempts.filter(({ status }) => status === "rejected");
        expect(rejectedAttempt?.status).toBe("rejected");
        if (rejectedAttempt?.status === "rejected") {
          expect(rejectedAttempt.reason.constraint).toBe("profile_user_one_active_profile_check");
        }

        const [directCardinality] = await harness.postgres`
          select count(*)::integer as count
          from public.profile_user membership
          inner join public.profile active_profile
            on active_profile.id = membership.profile_id
            and active_profile.deleted_at is null
          where membership.user_id = ${directTargetUserId}
        `;
        expect(directCardinality?.count).toBe(1);
      } finally {
        await cleanupFixtures(harness, profileIds, userIds);
      }
    },
    30_000,
  );

  integrationTest(
    "enforces solo restrictions, owner-only management, removal, and final-owner protection",
    async () => {
      const harness = await createIntegrationHarness("profile_roles");
      const userIds = new Set<string>();
      const profileIds = new Set<string>();

      try {
        const soloOwnerId = await insertUser(harness, "solo-owner");
        const sharedOwnerId = await insertUser(harness, "shared-owner");
        const memberId = await insertUser(harness, "shared-member");
        const anotherMemberId = await insertUser(harness, "shared-another-member");
        [soloOwnerId, sharedOwnerId, memberId, anotherMemberId].forEach((id) => userIds.add(id));

        const soloProfile = await createProfile(soloOwnerId, "Solo Profile", "solo");
        const sharedProfile = await createProfile(sharedOwnerId, "Shared Profile", "couple");
        profileIds.add(soloProfile.id);
        profileIds.add(sharedProfile.id);

        expect(
          await addProfileMember({
            actorUserId: soloOwnerId,
            profileId: soloProfile.id,
            role: "member",
            userId: memberId,
          }),
        ).toEqual({
          ok: false,
          error: {
            code: "solo_profile_membership_forbidden",
            message: "Solo profiles cannot have additional members",
          },
        });

        try {
          await harness.postgres`
            insert into public.profile_user (profile_id, user_id, role)
            values (${soloProfile.id}, ${memberId}, 'member')
          `;
          throw new Error("Expected the database to reject a second solo-profile member");
        } catch (error) {
          expect((error as { constraint?: string }).constraint).toBe(
            "profile_user_solo_membership_check",
          );
        }

        expect(
          await addProfileMember({
            actorUserId: sharedOwnerId,
            profileId: sharedProfile.id,
            role: "member",
            userId: memberId,
          }),
        ).toMatchObject({
          ok: true,
          data: {
            role: "member",
            userId: memberId,
          },
        });

        const authContext = await betterAuth.$context;
        const ownerSession = await authContext.internalAdapter.createSession(sharedOwnerId);
        const soloTypeResponse = await application.handle(
          new Request(`http://localhost/api/profile/${sharedProfile.id}`, {
            method: "PATCH",
            headers: {
              authorization: `Bearer ${ownerSession.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ profileType: "solo" }),
          }),
        );
        expect(soloTypeResponse.status).toBe(409);
        expect(await soloTypeResponse.json()).toEqual({
          code: "solo_profile_membership_forbidden",
          message: "Solo profiles cannot have additional members",
        });

        expect(
          await addProfileMember({
            actorUserId: memberId,
            profileId: sharedProfile.id,
            role: "member",
            userId: anotherMemberId,
          }),
        ).toEqual({
          ok: false,
          error: {
            code: "membership_forbidden",
            message: "Only an active profile owner can manage memberships",
          },
        });

        expect(
          await addProfileMember({
            actorUserId: sharedOwnerId,
            profileId: sharedProfile.id,
            role: "member",
            userId: anotherMemberId,
          }),
        ).toMatchObject({ ok: true });

        expect(
          await removeProfileMember({
            actorUserId: sharedOwnerId,
            profileId: sharedProfile.id,
            userId: anotherMemberId,
          }),
        ).toMatchObject({
          ok: true,
          data: {
            role: "member",
            userId: anotherMemberId,
          },
        });

        expect(
          await setProfileMemberRole({
            actorUserId: sharedOwnerId,
            profileId: sharedProfile.id,
            role: "owner",
            userId: memberId,
          }),
        ).toMatchObject({ ok: true, data: { role: "owner" } });

        const concurrentDemotions = await Promise.all([
          setProfileMemberRole({
            actorUserId: sharedOwnerId,
            profileId: sharedProfile.id,
            role: "member",
            userId: sharedOwnerId,
          }),
          setProfileMemberRole({
            actorUserId: memberId,
            profileId: sharedProfile.id,
            role: "member",
            userId: memberId,
          }),
        ]);
        expect(concurrentDemotions.filter((result) => result.ok)).toHaveLength(1);
        expect(
          concurrentDemotions.filter((result) => !result.ok).map((result) => result.error.code),
        ).toEqual(["final_owner_required"]);

        const [remainingOwner] = await harness.postgres`
          select user_id, role
          from public.profile_user
          where profile_id = ${sharedProfile.id}
            and role = 'owner'
        `;
        expect(remainingOwner?.role).toBe("owner");

        expect(
          await removeProfileMember({
            actorUserId: remainingOwner!.user_id,
            profileId: sharedProfile.id,
            userId: remainingOwner!.user_id,
          }),
        ).toEqual({
          ok: false,
          error: {
            code: "final_owner_required",
            message: "An active profile must retain at least one owner",
          },
        });
      } finally {
        await cleanupFixtures(harness, profileIds, userIds);
      }
    },
    30_000,
  );

  integrationTest(
    "keeps member acting scope explicit across feed, chat, notifications, and F1 cursors",
    async () => {
      const harness = await createIntegrationHarness("profile_scope");
      const userIds = new Set<string>();
      const profileIds = new Set<string>();

      try {
        const ownerId = await insertUser(harness, "scope-owner");
        const memberId = await insertUser(harness, "scope-member");
        userIds.add(ownerId);
        userIds.add(memberId);
        const sharedProfile = await createProfile(ownerId, "Scope Shared", "couple");
        profileIds.add(sharedProfile.id);
        const addedMember = await addProfileMember({
          actorUserId: ownerId,
          profileId: sharedProfile.id,
          role: "member",
          userId: memberId,
        });
        expect(addedMember.ok).toBeTrue();

        const [memberAccess] = await findActiveProfileMembership(sharedProfile.id, memberId);
        expect(memberAccess).toEqual({
          profileId: sharedProfile.id,
          profileType: "couple",
          role: "member",
        });

        const authContext = await betterAuth.$context;
        const memberSession = await authContext.internalAdapter.createSession(memberId);
        const memberActingResponse = await application.handle(
          new Request(`http://localhost/api/profile/${sharedProfile.id}`, {
            method: "PATCH",
            headers: {
              authorization: `Bearer ${memberSession.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ bio: "Updated by an active shared-profile member" }),
          }),
        );
        expect(memberActingResponse.status).toBe(200);
        expect((await memberActingResponse.json()).bio).toBe(
          "Updated by an active shared-profile member",
        );

        const candidateProfileIds = [
          "f1000000-0000-4000-8000-000000000001",
          "f1000000-0000-4000-8000-000000000002",
        ];
        for (const [index, candidateProfileId] of candidateProfileIds.entries()) {
          profileIds.add(candidateProfileId);
          await harness.postgres`
            insert into public.profile (
              id,
              profile_type,
              name,
              gender,
              gender_interests,
              orientation,
              orientation_interests,
              relationship_types,
              location,
              country,
              date_of_birth
            )
            values (
              ${candidateProfileId},
              'solo',
              ${`Scope Candidate ${index + 1}`},
              'woman',
              array['man']::profile_gender[],
              'heterosexual',
              array['heterosexual']::profile_orientation[],
              array['dating']::profile_relationship_type[],
              st_setsrid(st_makepoint(${24.941 + index * 0.001}, 60.17), 4326)::geography,
              'FI',
              '1990-01-01'
            )
          `;
        }

        const memberFeed = await listProfileFeed({
          limit: 1,
          minAge: 18,
          maxAge: 80,
          profileId: sharedProfile.id,
          radius: 10,
          userId: memberId,
        });
        expect(memberFeed.ok).toBeTrue();
        if (!memberFeed.ok || !memberFeed.data.cursor) {
          throw new Error("Expected a member-authorized feed continuation cursor");
        }
        expect(memberFeed.data.data).toHaveLength(1);

        try {
          await listProfileFeed({
            cursor: memberFeed.data.cursor,
            limit: 1,
            minAge: 18,
            maxAge: 80,
            profileId: sharedProfile.id,
            radius: 10,
            userId: ownerId,
          });
          throw new Error("Expected a cross-user cursor scope failure");
        } catch (error) {
          expect(error).toBeInstanceOf(CursorError);
          expect((error as CursorError).status).toBe(400);
        }

        const memberChat = await listChatConversations({
          profileId: sharedProfile.id,
          userId: memberId,
          limit: 1,
        });
        expect(memberChat).toEqual({
          ok: true,
          data: {
            data: [],
            cursor: null,
          },
        });

        const notificationId = randomUUID();
        await harness.postgres`
          insert into public.notification (
            id, recipient_user_id, type, title, body
          )
          values (
            ${notificationId},
            ${memberId},
            'system',
            'F2 scope',
            'User-scoped notification'
          )
        `;
        const memberNotifications = await listNotifications({ userId: memberId });
        const ownerNotifications = await listNotifications({ userId: ownerId });
        expect(memberNotifications.data.map(({ id }) => id)).toContain(notificationId);
        expect(ownerNotifications.data.map(({ id }) => id)).not.toContain(notificationId);

        await harness.postgres`
          update public.profile
          set deleted_at = now()
          where id = ${sharedProfile.id}
        `;
        expect(
          await listProfileFeed({
            minAge: 18,
            maxAge: 80,
            profileId: sharedProfile.id,
            radius: 10,
            userId: memberId,
          }),
        ).toEqual({ ok: false, message: "Profile not found" });
        expect(
          await listChatConversations({
            profileId: sharedProfile.id,
            userId: memberId,
          }),
        ).toEqual({
          ok: false,
          code: "profile_not_found",
          message: "Profile not found",
        });
      } finally {
        await cleanupFixtures(harness, profileIds, userIds);
      }
    },
    30_000,
  );

  integrationTest(
    "rejects reactivating a retained membership when the user has another active profile",
    async () => {
      const harness = await createIntegrationHarness("profile_reactivation");
      const userIds = new Set<string>();
      const profileIds = new Set<string>();

      try {
        const userId = await insertUser(harness, "reactivation-user");
        userIds.add(userId);
        const oldProfile = await createProfile(userId, "Old Profile", "solo");
        profileIds.add(oldProfile.id);
        await harness.postgres`
          update public.profile
          set deleted_at = now()
          where id = ${oldProfile.id}
        `;
        const currentProfile = await createProfile(userId, "Current Profile", "solo");
        profileIds.add(currentProfile.id);

        try {
          await harness.postgres`
            update public.profile
            set deleted_at = null
            where id = ${oldProfile.id}
          `;
          throw new Error("Expected profile reactivation to violate active cardinality");
        } catch (error) {
          expect((error as { constraint?: string }).constraint).toBe(
            "profile_user_one_active_profile_check",
          );
        }

        const [activeCount] = await harness.postgres`
          select count(*)::integer as count
          from public.profile_user membership
          inner join public.profile active_profile
            on active_profile.id = membership.profile_id
            and active_profile.deleted_at is null
          where membership.user_id = ${userId}
        `;
        expect(activeCount?.count).toBe(1);
      } finally {
        await cleanupFixtures(harness, profileIds, userIds);
      }
    },
    30_000,
  );
});
