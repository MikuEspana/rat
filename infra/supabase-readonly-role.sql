-- Read-only database user for the public API (DATABASE_URL_READONLY).
-- Run once in the Supabase SQL editor AFTER the worker has run its migrations. Replace the password.
create role rat_api login password 'CHANGE_ME_TO_A_LONG_RANDOM_PASSWORD';
grant usage on schema public to rat_api;
grant select on all tables in schema public to rat_api;
alter default privileges in schema public grant select on tables to rat_api;
