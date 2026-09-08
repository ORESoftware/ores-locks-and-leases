-- ores-locks-and-leases application-side fencing for PostgreSQL 14+.
--
-- Supabase and Neon are PostgreSQL: install this migration independently in
-- every physical database that stores protected state. The fence check,
-- watermark advance, and business mutation MUST run in the same transaction.
-- A successful check in Supabase does not authorize a write in Neon, or vice
-- versa. Redis fencing likewise protects only Redis-resident state.
--
-- Fiducia tokens are uint64. PostgreSQL bigint is signed, so NUMERIC(20,0)
-- preserves the complete 0..18446744073709551615 range.

CREATE SCHEMA IF NOT EXISTS ores_locks;

CREATE TABLE IF NOT EXISTS ores_locks.fencing_watermarks (
    tenant_scope text NOT NULL,
    resource_key text NOT NULL,
    fencing_token numeric(20, 0) NOT NULL,
    operation_id text NOT NULL,
    payload_sha256 text NOT NULL,
    holder text,
    lease_id text,
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    advanced_at timestamptz NOT NULL DEFAULT statement_timestamp(),

    CONSTRAINT fencing_watermarks_pkey
        PRIMARY KEY (tenant_scope, resource_key),
    CONSTRAINT fencing_watermarks_tenant_scope_check
        CHECK (
            octet_length(tenant_scope) BETWEEN 1 AND 256
        ),
    CONSTRAINT fencing_watermarks_resource_key_check
        CHECK (
            octet_length(resource_key) BETWEEN 1 AND 512
        ),
    CONSTRAINT fencing_watermarks_token_check
        CHECK (
            fencing_token >= 0
            AND fencing_token <= 18446744073709551615::numeric
            AND scale(fencing_token) = 0
        ),
    CONSTRAINT fencing_watermarks_operation_id_check
        CHECK (
            octet_length(operation_id) BETWEEN 1 AND 128
        ),
    CONSTRAINT fencing_watermarks_payload_sha256_check
        CHECK (
            payload_sha256 ~ '^[0-9a-f]{64}$'
        ),
    CONSTRAINT fencing_watermarks_holder_check
        CHECK (
            holder IS NULL
            OR octet_length(holder) BETWEEN 1 AND 256
        ),
    CONSTRAINT fencing_watermarks_lease_id_check
        CHECK (
            lease_id IS NULL
            OR octet_length(lease_id) BETWEEN 1 AND 256
        )
);

COMMENT ON TABLE ores_locks.fencing_watermarks IS
    'Last accepted Fiducia fencing token and idempotency identity per protected resource.';
COMMENT ON COLUMN ores_locks.fencing_watermarks.fencing_token IS
    'Full unsigned-64 Fiducia token stored as NUMERIC(20,0), never signed BIGINT.';
COMMENT ON COLUMN ores_locks.fencing_watermarks.operation_id IS
    'Caller idempotency key. Equal token + equal operation_id + equal payload_sha256 is a replay.';
COMMENT ON COLUMN ores_locks.fencing_watermarks.payload_sha256 IS
    'Lowercase SHA-256 of the canonical mutation payload.';

CREATE OR REPLACE FUNCTION ores_locks.try_advance_fence(
    p_tenant_scope text,
    p_resource_key text,
    p_fencing_token text,
    p_operation_id text,
    p_payload_sha256 text,
    p_holder text DEFAULT NULL,
    p_lease_id text DEFAULT NULL
)
RETURNS TABLE (
    decision text,
    should_apply boolean,
    incoming_token text,
    current_token text,
    previous_token text
)
LANGUAGE plpgsql
SECURITY INVOKER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_incoming numeric(20, 0);
    v_current ores_locks.fencing_watermarks%ROWTYPE;
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

    IF p_fencing_token IS NULL
        OR p_fencing_token !~ '^(0|[1-9][0-9]{0,19})$'
    THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'fencingToken must be canonical unsigned-64 decimal text';
    END IF;

    v_incoming := p_fencing_token::numeric(20, 0);
    IF v_incoming > 18446744073709551615::numeric THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'fencingToken exceeds uint64 maximum';
    END IF;

    IF p_operation_id IS NULL
        OR octet_length(p_operation_id) NOT BETWEEN 1 AND 128
    THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'operationId must contain 1..128 UTF-8 bytes';
    END IF;

    IF p_payload_sha256 IS NULL
        OR p_payload_sha256 !~ '^[0-9a-f]{64}$'
    THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'payloadSha256 must be exactly 64 lowercase hexadecimal characters';
    END IF;

    IF p_holder IS NOT NULL
        AND octet_length(p_holder) NOT BETWEEN 1 AND 256
    THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'holder must be null or contain 1..256 UTF-8 bytes';
    END IF;

    IF p_lease_id IS NOT NULL
        AND octet_length(p_lease_id) NOT BETWEEN 1 AND 256
    THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'leaseId must be null or contain 1..256 UTF-8 bytes';
    END IF;

    -- The loop closes the race when two transactions attempt the first insert.
    -- The winning INSERT owns the new row lock until the caller commits; the
    -- loser waits, observes the committed row, then compares against it.
    LOOP
        SELECT watermark.*
        INTO v_current
        FROM ores_locks.fencing_watermarks AS watermark
        WHERE watermark.tenant_scope = p_tenant_scope
          AND watermark.resource_key = p_resource_key
        FOR UPDATE;

        EXIT WHEN FOUND;

        INSERT INTO ores_locks.fencing_watermarks (
            tenant_scope,
            resource_key,
            fencing_token,
            operation_id,
            payload_sha256,
            holder,
            lease_id
        )
        VALUES (
            p_tenant_scope,
            p_resource_key,
            v_incoming,
            p_operation_id,
            p_payload_sha256,
            p_holder,
            p_lease_id
        )
        ON CONFLICT (tenant_scope, resource_key) DO NOTHING;

        IF FOUND THEN
            RETURN QUERY
            SELECT
                'advanced'::text,
                true,
                p_fencing_token,
                p_fencing_token,
                NULL::text;
            RETURN;
        END IF;
    END LOOP;

    -- Defense in depth for rows created by an older migration, manual DBA
    -- intervention, disabled constraints, logical replication, or corrupted
    -- restore. A higher incoming token must never silently "repair" malformed
    -- authority state because that would turn untrusted storage into a grant.
    IF v_current.tenant_scope IS NULL
        OR octet_length(v_current.tenant_scope) NOT BETWEEN 1 AND 256
        OR v_current.resource_key IS NULL
        OR octet_length(v_current.resource_key) NOT BETWEEN 1 AND 512
        OR v_current.fencing_token IS NULL
        OR v_current.fencing_token < 0
        OR v_current.fencing_token > 18446744073709551615::numeric
        OR scale(v_current.fencing_token) <> 0
        OR v_current.operation_id IS NULL
        OR octet_length(v_current.operation_id) NOT BETWEEN 1 AND 128
        OR v_current.payload_sha256 IS NULL
        OR v_current.payload_sha256 !~ '^[0-9a-f]{64}$'
        OR (
            v_current.holder IS NOT NULL
            AND octet_length(v_current.holder) NOT BETWEEN 1 AND 256
        )
        OR (
            v_current.lease_id IS NOT NULL
            AND octet_length(v_current.lease_id) NOT BETWEEN 1 AND 256
        )
    THEN
        RAISE EXCEPTION USING
            ERRCODE = '22000',
            MESSAGE = 'stored fencing watermark is malformed; refusing mutation';
    END IF;

    IF v_incoming > v_current.fencing_token THEN
        UPDATE ores_locks.fencing_watermarks AS watermark
        SET
            fencing_token = v_incoming,
            operation_id = p_operation_id,
            payload_sha256 = p_payload_sha256,
            holder = p_holder,
            lease_id = p_lease_id,
            advanced_at = statement_timestamp()
        WHERE watermark.tenant_scope = p_tenant_scope
          AND watermark.resource_key = p_resource_key;

        RETURN QUERY
        SELECT
            'advanced'::text,
            true,
            p_fencing_token,
            p_fencing_token,
            v_current.fencing_token::text;
        RETURN;
    END IF;

    IF v_incoming < v_current.fencing_token THEN
        RETURN QUERY
        SELECT
            'stale'::text,
            false,
            p_fencing_token,
            v_current.fencing_token::text,
            v_current.fencing_token::text;
        RETURN;
    END IF;

    IF v_current.operation_id = p_operation_id
        AND v_current.payload_sha256 = p_payload_sha256
    THEN
        RETURN QUERY
        SELECT
            'replay'::text,
            false,
            p_fencing_token,
            v_current.fencing_token::text,
            v_current.fencing_token::text;
        RETURN;
    END IF;

    RETURN QUERY
    SELECT
        'token_reuse'::text,
        false,
        p_fencing_token,
        v_current.fencing_token::text,
        v_current.fencing_token::text;
END;
$function$;

COMMENT ON FUNCTION ores_locks.try_advance_fence(
    text,
    text,
    text,
    text,
    text,
    text,
    text
) IS
    'Atomically compare/advance one application fencing watermark. Call inside the same transaction as the protected mutation.';

-- Backend-only by default. Supabase anon/authenticated roles and PostgreSQL
-- PUBLIC receive no access. Product infra must grant USAGE/SELECT/INSERT/UPDATE
-- and EXECUTE only to the API/worker role that performs guarded mutations.
REVOKE ALL ON SCHEMA ores_locks FROM PUBLIC;
REVOKE ALL ON TABLE ores_locks.fencing_watermarks FROM PUBLIC;
REVOKE ALL ON FUNCTION ores_locks.try_advance_fence(
    text,
    text,
    text,
    text,
    text,
    text,
    text
) FROM PUBLIC;
