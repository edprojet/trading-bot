-- Restreindre les RPCs sensibles au rôle service_role uniquement.
-- Par défaut PostgreSQL accorde EXECUTE à PUBLIC — on révoque et on ré-accorde explicitement.

REVOKE EXECUTE ON FUNCTION try_claim_bot_run() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION release_bot_run() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_bot_run_logs(int) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION try_claim_bot_run() TO service_role;
GRANT EXECUTE ON FUNCTION release_bot_run() TO service_role;
GRANT EXECUTE ON FUNCTION get_bot_run_logs(int) TO service_role;
