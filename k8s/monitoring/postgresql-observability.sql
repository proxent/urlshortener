CREATE ROLE postgres_exporter LOGIN PASSWORD 'REPLACE_ME';
GRANT CONNECT ON DATABASE url_shortener TO postgres_exporter;
GRANT pg_monitor TO postgres_exporter;

\c url_shortener
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
