-- ReVale employee onboarding. Existing accounts keep their current access.
ALTER TABLE revale.persons ADD COLUMN IF NOT EXISTS activation_required boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS activated_at timestamptz;

CREATE TABLE IF NOT EXISTS revale.employee_imports (
    id text PRIMARY KEY, employer_id text NOT NULL REFERENCES revale.employers(id),
    request_hash text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS revale.employee_access_invites (
    person_id text PRIMARY KEY REFERENCES revale.persons(id),
    enrollment_id bigint NOT NULL REFERENCES revale.employee_enrollments(id),
    employer_id text NOT NULL REFERENCES revale.employers(id), token_hash text NOT NULL UNIQUE,
    created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
    accepted_at timestamptz, attempts integer NOT NULL DEFAULT 0, attempt_window timestamptz,
    claim_id text, claim_until timestamptz);

CREATE INDEX IF NOT EXISTS employee_access_invites_employer_idx ON revale.employee_access_invites(employer_id,expires_at);
