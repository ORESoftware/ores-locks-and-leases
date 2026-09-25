-- Strong monotonic fencing-token authority for PostgreSQL 14+.
--
-- Install independently in Supabase, Neon, or ordinary PostgreSQL when a
-- distributed mutex (for example Redis Redlock) needs a fencing token that the
-- mutex protocol itself does not provide. The returned token is full uint64
-- decimal text. Callers must still enforce that token at EVERY datastore that
-- owns protected state, using fencing.sql in the same transaction as the
-- business mutation.
--
-- This function is intentionally NOT a lock. It only allocates monotonically
-- increasing epochs. Acquire the outer lock first, mint the fence second, then
-- start guarded work. A token-mint failure means guarded work must not begin.

CREATE SCHEMA IF NOT EXISTS ores_locks;

CREATE TABLE IF NOT EXISTS ores_locks.fencing_counters (
    tenant_scope text NOT NULL,
    resource_key text NOT NULL,
    last_token numeric(20, 0) NOT NULL DEFAULT 0,
    advanced_at timestamptz NOT NULL DEFAULT statement_timestamp(),

    CONSTRAINT fencing_counters_pkey
        PRIMARY KEY (tenant_scope, resource_key),
    CONSTRAINT fencing_counters_tenant_scope_check
        CHECK (octet_length(tenant_scope) BETWEEN 1 AND 256),
    CONSTRAINT fencing_counters_resource_key_check
        CHECK (octet_length(resource_key) BETWEEN 1 AND 512),
    CONSTRAINT fencing_counters_token_check
        CHECK (
            last_token >= 0
            AND last_token <= 18446744073709551615::numeric
            AND scale(last_token) = 0
        )
);

COMMENT ON TABLE ores_locks.fencing_counters IS
    'Independent monotonic fencing-token allocator; this is an epoch source, not a mutex.';

CREATE OR REPLACE FUNCTION ores_locks.next_fencing_token(
    p_tenant_scope text,
    p_resource_key text
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_next numeric(20, 0);
BEGIN
    IF p_tenant_scope IS NULL
        OR octet_length(p_tenant_scope) NOT BETWEEN 1 AND 256
    THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'tenantScope must contain 1..256 UTF-8 bytes';
    END IF;

    IF p_resource_key IS NULL
        OR octet_length(p_resource_key) NOT BETWEEN 1 AND 512
    THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'resourceKey must contain 1..512 UTF-8 bytes';
    END IF;

    -- UPSERT takes the unique-row lock for this resource. PostgreSQL evaluates
    -- the DO UPDATE expression against the current committed row after any
    -- conflicting transaction finishes, so concurrent callers serialize on the
    -- one counter row without an application-side read/modify/write race.
    INSERT INTO ores_locks.fencing_counters AS counters (
        tenant_scope,
        resource_key,
        last_token
    )
    VALUES (
        p_tenant_scope,
        p_resource_key,
        1
    )
    ON CONFLICT (tenant_scope, resource_key) DO UPDATE
    SET
        last_token = counters.last_token + 1,
        advanced_at = statement_timestamp()
    WHERE counters.last_token < 18446744073709551615::numeric
    RETURNING last_token INTO v_next;

    IF v_next IS NULL THEN
        RAISE EXCEPTION USING
            ERRCODE = '22003',
            MESSAGE = 'uint64 fencing token exhausted';
    END IF;

    RETURN v_next::text;
END;
$function$;

COMMENT ON FUNCTION ores_locks.next_fencing_token(text, text) IS
    'Atomically allocate the next full-width uint64 fencing epoch for one scoped resource.';

-- Backend-only by default. Supabase anon/authenticated roles and PostgreSQL
-- PUBLIC receive no access. Product infra should grant EXECUTE only to the
-- trusted worker/API role that acquires the outer lock.
REVOKE ALL ON SCHEMA ores_locks FROM PUBLIC;
REVOKE ALL ON TABLE ores_locks.fencing_counters FROM PUBLIC;
REVOKE ALL ON FUNCTION ores_locks.next_fencing_token(text, text) FROM PUBLIC;
