CREATE TABLE IF NOT EXISTS "messages" (
  "id" serial PRIMARY KEY,
  "mess_id" integer NOT NULL REFERENCES "messes"("id") ON DELETE CASCADE,
  "sender_user_id" integer NOT NULL REFERENCES "users"("id"),
  "body" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "messages_mess_created_id_idx"
ON "messages" ("mess_id", "created_at", "id");

DROP INDEX IF EXISTS "messages_mess_created_idx";

CREATE INDEX IF NOT EXISTS "messages_sender_created_idx"
ON "messages" ("sender_user_id", "created_at");

CREATE TABLE IF NOT EXISTS "message_read_states" (
  "id" serial PRIMARY KEY,
  "mess_id" integer NOT NULL REFERENCES "messes"("id") ON DELETE CASCADE,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "last_read_message_id" integer,
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "message_read_states_mess_user_uq" UNIQUE ("mess_id", "user_id")
);

CREATE INDEX IF NOT EXISTS "message_read_states_user_idx"
ON "message_read_states" ("user_id");

-- Existing members start with the current conversation marked as read. This
-- prevents old historical messages from suddenly appearing as new.
INSERT INTO "message_read_states" ("mess_id", "user_id", "last_read_message_id")
SELECT
  c."mess_id",
  c."user_id",
  MAX(m."id")
FROM "consumers" c
LEFT JOIN "messages" m ON m."mess_id" = c."mess_id"
WHERE c."user_id" IS NOT NULL AND c."account_deleted_at" IS NULL
GROUP BY c."mess_id", c."user_id"
ON CONFLICT ("mess_id", "user_id") DO NOTHING;
