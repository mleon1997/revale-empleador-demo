-- Existing staging runtime role; no new login, ownership or identity access.
GRANT SELECT, INSERT, UPDATE ON revale.admin_access_invites TO revale_runtime;
