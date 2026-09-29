-- Read-only database user for the public API (DATABASE_URL_READONLY).
-- Run once AFTER the worker has run its migrations, in psql opened with `railway connect Postgres`:
--   \i infra/readonly-role.sql
--   \password rat_api          (paste the value of the RAT_API_DB_PASSWORD shared variable)
create role rat_api login;
grant usage on schema public to rat_api;
grant select on all tables in schema public to rat_api;
alter default privileges in schema public grant select on tables to rat_api;
-- never the encrypted keys: the API does not need them (run this after the worker's migrations created key_pool)
revoke all on key_pool from rat_api;
