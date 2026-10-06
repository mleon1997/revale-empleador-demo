-- Staging only. Reviewed separately from the application runtime role.
-- No password is embedded here. Provision a dedicated login via Neon and
-- store it only in Vercel revale-staging / Preview after approval.
DO $identity_role$
BEGIN
  CREATE ROLE revale_identity_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOREPLICATION NOBYPASSRLS;
  REVOKE ALL ON SCHEMA revale_identity FROM PUBLIC;
  REVOKE ALL ON ALL TABLES IN SCHEMA revale_identity FROM PUBLIC;
  GRANT USAGE ON SCHEMA revale_identity TO revale_identity_runtime;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA revale_identity
    TO revale_identity_runtime;
END
$identity_role$;
-- Dedicated login: revale_staging_identity. Sole membership:
-- GRANT revale_identity_runtime TO revale_staging_identity;
-- No memberships in revale_runtime or neon_superuser. No DDL, role management,
-- schema creation, table ownership, identity-provider (neon_auth) or business
-- (revale) table grants. DELETE is needed for sessions/challenges/recovery flows.
