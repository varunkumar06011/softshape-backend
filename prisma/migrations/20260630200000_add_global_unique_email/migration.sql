-- Add global unique index on User.email
-- PostgreSQL treats NULL values as distinct in unique constraints,
-- so captains/cashiers with NULL emails are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");
