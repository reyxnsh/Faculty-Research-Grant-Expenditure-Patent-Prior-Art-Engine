-- Up Migration
ALTER TABLE users ADD COLUMN failed_login_count INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD CONSTRAINT chk_failed_login_count_nonnegative CHECK (failed_login_count >= 0);
ALTER TABLE users ADD COLUMN locked_until TIMESTAMPTZ NULL;
ALTER TABLE users ADD COLUMN last_login_at TIMESTAMPTZ NULL;
ALTER TABLE users ADD CONSTRAINT chk_user_email_lowercase CHECK (email = lower(email));

-- Down Migration
ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_user_email_lowercase;
ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_failed_login_count_nonnegative;
ALTER TABLE users DROP COLUMN IF EXISTS last_login_at;
ALTER TABLE users DROP COLUMN IF EXISTS locked_until;
ALTER TABLE users DROP COLUMN IF EXISTS failed_login_count;
