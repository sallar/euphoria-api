-- Custom SQL migration file, put your code below! --
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "profile_user" membership
		INNER JOIN "profile" active_profile
			ON active_profile.id = membership.profile_id
			AND active_profile.deleted_at IS NULL
		GROUP BY membership.user_id
		HAVING count(DISTINCT membership.profile_id) > 1
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23505',
			MESSAGE = 'F2 precondition failed: a user belongs to more than one active profile',
			CONSTRAINT = 'profile_user_one_active_profile_check';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "profile" active_profile
		INNER JOIN "profile_user" membership ON membership.profile_id = active_profile.id
		WHERE active_profile.deleted_at IS NULL
			AND active_profile.profile_type = 'solo'
		GROUP BY active_profile.id
		HAVING count(*) > 1
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'F2 precondition failed: an active solo profile has multiple members',
			CONSTRAINT = 'profile_user_solo_membership_check';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "profile" active_profile
		INNER JOIN "profile_user" membership ON membership.profile_id = active_profile.id
		WHERE active_profile.deleted_at IS NULL
		GROUP BY active_profile.id
		HAVING count(*) FILTER (WHERE membership.role = 'owner') = 0
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'F2 precondition failed: an active profile with memberships has no owner',
			CONSTRAINT = 'profile_user_active_owner_check';
	END IF;
END
$$;
--> statement-breakpoint
CREATE FUNCTION "profile_membership_lock_keys"(
	profile_ids uuid[],
	user_ids text[]
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
	locked_profile_id uuid;
	locked_user_id text;
BEGIN
	FOR locked_profile_id IN
		SELECT DISTINCT value
		FROM unnest(profile_ids) value
		WHERE value IS NOT NULL
		ORDER BY value
	LOOP
		PERFORM pg_advisory_xact_lock(
			hashtextextended('euphoria:profile-membership:profile:' || locked_profile_id::text, 0)
		);
	END LOOP;

	FOR locked_user_id IN
		SELECT DISTINCT value
		FROM unnest(user_ids) value
		WHERE value IS NOT NULL
		ORDER BY value
	LOOP
		PERFORM pg_advisory_xact_lock(
			hashtextextended('euphoria:profile-membership:user:' || locked_user_id, 0)
		);
	END LOOP;
END
$$;
--> statement-breakpoint
CREATE FUNCTION "profile_membership_assert_user_cardinality"(checked_user_id text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
	IF (
		SELECT count(DISTINCT membership.profile_id)
		FROM "profile_user" membership
		INNER JOIN "profile" active_profile
			ON active_profile.id = membership.profile_id
			AND active_profile.deleted_at IS NULL
		WHERE membership.user_id = checked_user_id
	) > 1 THEN
		RAISE EXCEPTION USING
			ERRCODE = '23505',
			MESSAGE = 'User already belongs to an active profile',
			CONSTRAINT = 'profile_user_one_active_profile_check';
	END IF;
END
$$;
--> statement-breakpoint
CREATE FUNCTION "profile_membership_assert_profile"(checked_profile_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
	checked_profile_type "profile_type";
	is_active boolean;
	member_count integer;
	owner_count integer;
BEGIN
	SELECT
		active_profile.profile_type,
		active_profile.deleted_at IS NULL
	INTO checked_profile_type, is_active
	FROM "profile" active_profile
	WHERE active_profile.id = checked_profile_id;

	IF NOT FOUND OR NOT is_active THEN
		RETURN;
	END IF;

	SELECT
		count(*)::integer,
		count(*) FILTER (WHERE membership.role = 'owner')::integer
	INTO member_count, owner_count
	FROM "profile_user" membership
	WHERE membership.profile_id = checked_profile_id;

	IF checked_profile_type = 'solo' AND member_count > 1 THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'Solo profiles cannot have additional members',
			CONSTRAINT = 'profile_user_solo_membership_check';
	END IF;

	IF member_count > 0 AND owner_count = 0 THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'An active profile must retain at least one owner',
			CONSTRAINT = 'profile_user_active_owner_check';
	END IF;
END
$$;
--> statement-breakpoint
CREATE FUNCTION "profile_membership_before_write"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	new_profile_deleted_at timestamptz;
BEGIN
	IF TG_OP = 'INSERT' THEN
		PERFORM "profile_membership_lock_keys"(
			ARRAY[NEW.profile_id],
			ARRAY[NEW.user_id]
		);
	ELSIF TG_OP = 'UPDATE' THEN
		PERFORM "profile_membership_lock_keys"(
			ARRAY[OLD.profile_id, NEW.profile_id],
			ARRAY[OLD.user_id, NEW.user_id]
		);
	ELSE
		PERFORM "profile_membership_lock_keys"(
			ARRAY[OLD.profile_id],
			ARRAY[OLD.user_id]
		);
		RETURN OLD;
	END IF;

	SELECT candidate_profile.deleted_at
	INTO new_profile_deleted_at
	FROM "profile" candidate_profile
	WHERE candidate_profile.id = NEW.profile_id;

	IF TG_OP = 'INSERT' AND new_profile_deleted_at IS NOT NULL THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'Memberships cannot be added to a deleted profile',
			CONSTRAINT = 'profile_user_active_profile_check';
	END IF;

	PERFORM "profile_membership_assert_user_cardinality"(NEW.user_id);
	PERFORM "profile_membership_assert_profile"(NEW.profile_id);
	RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "profile_membership_before_write"
BEFORE INSERT OR UPDATE OR DELETE
ON "profile_user"
FOR EACH ROW
EXECUTE FUNCTION "profile_membership_before_write"();
--> statement-breakpoint
CREATE FUNCTION "profile_membership_after_write"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		PERFORM "profile_membership_assert_user_cardinality"(NEW.user_id);
		PERFORM "profile_membership_assert_profile"(NEW.profile_id);
	ELSIF TG_OP = 'UPDATE' THEN
		PERFORM "profile_membership_assert_user_cardinality"(OLD.user_id);
		PERFORM "profile_membership_assert_user_cardinality"(NEW.user_id);
		PERFORM "profile_membership_assert_profile"(OLD.profile_id);
		PERFORM "profile_membership_assert_profile"(NEW.profile_id);
	ELSE
		PERFORM "profile_membership_assert_user_cardinality"(OLD.user_id);
		PERFORM "profile_membership_assert_profile"(OLD.profile_id);
	END IF;

	RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "profile_membership_after_write"
AFTER INSERT OR UPDATE OR DELETE
ON "profile_user"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "profile_membership_after_write"();
--> statement-breakpoint
CREATE FUNCTION "profile_membership_after_profile_state_write"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	member_user_id text;
BEGIN
	IF NEW.deleted_at IS NOT NULL THEN
		RETURN NULL;
	END IF;

	PERFORM "profile_membership_assert_profile"(NEW.id);

	FOR member_user_id IN
		SELECT membership.user_id
		FROM "profile_user" membership
		WHERE membership.profile_id = NEW.id
		ORDER BY membership.user_id
	LOOP
		PERFORM pg_advisory_xact_lock(
			hashtextextended('euphoria:profile-membership:user:' || member_user_id, 0)
		);
		PERFORM "profile_membership_assert_user_cardinality"(member_user_id);
	END LOOP;

	RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "profile_membership_after_profile_state_write"
AFTER UPDATE OF "deleted_at", "profile_type"
ON "profile"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "profile_membership_after_profile_state_write"();
