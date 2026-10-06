-- Run once as the schema owner in a new isolated database, after review.
-- This role cannot log in. A separate dedicated login must be provisioned and
-- assigned this role explicitly; never give it membership in neon_superuser.
-- Future migrations must explicitly review grants for any added objects.
DO $runtime_role$
BEGIN
  CREATE ROLE revale_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOREPLICATION NOBYPASSRLS;
  GRANT USAGE ON SCHEMA revale TO revale_runtime;
  GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA revale TO revale_runtime;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA revale TO revale_runtime;
END
$runtime_role$;
