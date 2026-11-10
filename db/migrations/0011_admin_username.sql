-- Admins may also sign in with a username (ADR 0005). Compared without case, unique the same way.

ALTER TABLE admin_users
  ADD COLUMN username text CHECK (username ~ '^[A-Za-z0-9._-]{1,64}$');

CREATE UNIQUE INDEX admin_users_username_lower_idx ON admin_users (lower(username));

-- Test account, password in docs/SEED_CREDENTIALS.md. db/seed/seed.sql inserts the same row so a
-- test reset brings it back. Only the scrypt hash is stored.
INSERT INTO admin_users (email, username, password_hash, role) VALUES
  ('admin@inblackm.test', 'Admin',
   'scrypt$16384$8$1$uEdjqmeOQjC26Dsycg97yg==$MQfupWOMcg760C6QreMESitYaQLhC5s8N8EPYzcYzH4=', 'superadmin')
ON CONFLICT DO NOTHING;
