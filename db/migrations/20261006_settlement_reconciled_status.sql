-- Preserve all existing states and permit the state written after exact
-- reconciliation. Apply through the migration owner, never the runtime login.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE revale.settlements DROP CONSTRAINT settlements_status_check;
ALTER TABLE revale.settlements ADD CONSTRAINT settlements_status_check
  CHECK (status IN ('draft','closed','scheduled','paid','failed','cancelled','reconciled'));
COMMIT;
