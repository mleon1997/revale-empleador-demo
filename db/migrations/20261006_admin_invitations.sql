-- Personal staging administration enrollment. Tokens are stored only as hashes.
BEGIN;
CREATE TABLE revale.admin_access_invites (
  admin_user_id text PRIMARY KEY REFERENCES revale.admin_users(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  email text NOT NULL,
  invited_role text NOT NULL CHECK (invited_role IN ('superadmin','finance','ops','support')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  attempt_window timestamptz,
  claim_id text,
  claim_until timestamptz
);
COMMIT;
