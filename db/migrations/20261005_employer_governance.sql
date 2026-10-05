-- ReVale company access and internal approvals. Existing financial approvals remain separate.

ALTER TABLE revale.employer_users ADD COLUMN IF NOT EXISTS activation_required boolean NOT NULL DEFAULT false;

ALTER TABLE revale.employer_users ADD COLUMN IF NOT EXISTS approval_limit numeric(14,2) CHECK (approval_limit>=0);

ALTER TABLE revale.employer_users ADD COLUMN IF NOT EXISTS access_version integer NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS revale.employer_team_invites (
    user_id text PRIMARY KEY REFERENCES revale.employer_users(id), employer_id text NOT NULL REFERENCES revale.employers(id),
    token_hash text NOT NULL UNIQUE, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL, accepted_at timestamptz, attempts integer NOT NULL DEFAULT 0,
    attempt_window timestamptz, claim_id text, claim_until timestamptz);

CREATE INDEX IF NOT EXISTS employer_team_invites_company_idx ON revale.employer_team_invites(employer_id,expires_at);

CREATE TABLE IF NOT EXISTS revale.employer_approval_policies (
    employer_id text PRIMARY KEY REFERENCES revale.employers(id), threshold numeric(14,2) NOT NULL DEFAULT 5000 CHECK(threshold>0),
    version integer NOT NULL DEFAULT 1, updated_by text, updated_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS revale.employer_funding_approvals (
    funding_batch_id text PRIMARY KEY REFERENCES revale.funding_batches(id), employer_id text NOT NULL REFERENCES revale.employers(id),
    program_id text NOT NULL REFERENCES revale.benefit_programs(id), requested_by text NOT NULL REFERENCES revale.employer_users(id),
    requester_auth_id uuid NOT NULL, requester_name text NOT NULL, amount numeric(14,2) NOT NULL CHECK(amount>0), roster_hash text NOT NULL,
    required_approvals integer NOT NULL CHECK(required_approvals IN(1,2)), policy_version integer NOT NULL, threshold numeric(14,2) NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected','cancelled')),
    created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz);

CREATE INDEX IF NOT EXISTS employer_funding_approvals_queue_idx ON revale.employer_funding_approvals(employer_id,status,created_at DESC);

CREATE TABLE IF NOT EXISTS revale.employer_funding_decisions (
    funding_batch_id text NOT NULL REFERENCES revale.employer_funding_approvals(funding_batch_id),
    user_id text NOT NULL REFERENCES revale.employer_users(id), auth_user_id uuid NOT NULL, actor_name text NOT NULL, actor_role text NOT NULL,
    decision text NOT NULL CHECK(decision IN('approve','reject','cancel')), note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(funding_batch_id,user_id), UNIQUE(funding_batch_id,auth_user_id));

INSERT INTO revale.employer_approval_policies(employer_id) SELECT id FROM revale.employers ON CONFLICT(employer_id) DO NOTHING;
