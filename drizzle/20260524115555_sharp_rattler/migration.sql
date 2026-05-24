CREATE VIEW "profile_match" AS (
  select
    liked.profile_id,
    liked.target_profile_id as matched_profile_id,
    greatest(liked.updated_at, liked_back.updated_at) as matched_at
  from "profile_reaction" liked
  inner join "profile_reaction" liked_back
    on liked.profile_id = liked_back.target_profile_id
    and liked.target_profile_id = liked_back.profile_id
  where liked.reaction = 'like'
    and liked_back.reaction = 'like'
);