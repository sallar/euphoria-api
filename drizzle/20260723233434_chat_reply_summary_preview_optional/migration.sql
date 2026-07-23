UPDATE "chat_message"
SET "reply_summary" = CASE
  WHEN "reply_summary"->>'state' IN ('deleted', 'unavailable')
    THEN "reply_summary" - 'preview'
  WHEN "reply_summary"->>'state' = 'available'
    AND jsonb_typeof("reply_summary"->'preview') = 'object'
    THEN "reply_summary"
  WHEN "reply_summary"->>'state' = 'available'
    THEN jsonb_set(
      "reply_summary" - 'preview',
      '{state}',
      '"unavailable"'::jsonb,
      true
    )
  ELSE "reply_summary"
END
WHERE jsonb_typeof("reply_summary") = 'object'
  AND (
    (
      "reply_summary"->>'state' IN ('deleted', 'unavailable')
      AND "reply_summary" ? 'preview'
    )
    OR (
      "reply_summary"->>'state' = 'available'
      AND jsonb_typeof("reply_summary"->'preview') IS DISTINCT FROM 'object'
    )
  );
