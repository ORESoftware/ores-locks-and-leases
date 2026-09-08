\set ON_ERROR_STOP on
\ir fencing.sql

TRUNCATE TABLE ores_locks.fencing_watermarks;

-- Exact UTF-8 byte ceilings are valid and remain separate identities.
DO $test$
DECLARE
    r record;
    v_rows integer;
BEGIN
    SELECT * INTO STRICT r
    FROM ores_locks.try_advance_fence(
        repeat('é', 128),
        repeat('é', 256),
        '18446744073709551615',
        repeat('é', 64),
        repeat('a', 64),
        repeat('é', 128),
        repeat('é', 128)
    );
    IF r.decision <> 'advanced'
        OR r.current_token <> '18446744073709551615'
    THEN
        RAISE EXCEPTION 'exact byte boundary failed: %', row_to_json(r);
    END IF;

    PERFORM * FROM ores_locks.try_advance_fence(
        'tenant/a', 'resource/bc', '1', 'op-a', repeat('b', 64), NULL, NULL
    );
    PERFORM * FROM ores_locks.try_advance_fence(
        'tenant/ab', 'resource/c', '2', 'op-b', repeat('c', 64), NULL, NULL
    );
    SELECT count(*) INTO STRICT v_rows
    FROM ores_locks.fencing_watermarks
    WHERE (tenant_scope, resource_key) IN (
        ('tenant/a', 'resource/bc'),
        ('tenant/ab', 'resource/c')
    );
    IF v_rows <> 2 THEN
        RAISE EXCEPTION 'composite identities aliased: % rows', v_rows;
    END IF;
END;
$test$;

-- Every byte limit is measured with octet_length, not character count.
DO $test$
BEGIN
    BEGIN
        PERFORM * FROM ores_locks.try_advance_fence(
            repeat('é', 129), 'resource', '1', 'op', repeat('a', 64), NULL, NULL
        );
        RAISE EXCEPTION 'oversized tenant unexpectedly accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
    END;

    BEGIN
        PERFORM * FROM ores_locks.try_advance_fence(
            'tenant', repeat('é', 257), '1', 'op', repeat('a', 64), NULL, NULL
        );
        RAISE EXCEPTION 'oversized resource unexpectedly accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
    END;

    BEGIN
        PERFORM * FROM ores_locks.try_advance_fence(
            'tenant', 'resource', '1', repeat('é', 65), repeat('a', 64), NULL, NULL
        );
        RAISE EXCEPTION 'oversized operation unexpectedly accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
    END;

    BEGIN
        PERFORM * FROM ores_locks.try_advance_fence(
            'tenant', 'resource', '1', 'op', repeat('a', 64), repeat('é', 129), NULL
        );
        RAISE EXCEPTION 'oversized holder unexpectedly accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
    END;

    BEGIN
        PERFORM * FROM ores_locks.try_advance_fence(
            'tenant', 'resource', '1', 'op', repeat('a', 64), NULL, repeat('é', 129)
        );
        RAISE EXCEPTION 'oversized lease unexpectedly accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
    END;
END;
$test$;

-- A watermark advance, protected state write, and durable idempotency receipt
-- must share one transaction. Rollback must erase all three side effects.
CREATE TEMP TABLE protected_state (
    tenant_scope text NOT NULL,
    resource_key text NOT NULL,
    value text NOT NULL,
    PRIMARY KEY (tenant_scope, resource_key)
) ON COMMIT PRESERVE ROWS;
CREATE TEMP TABLE fence_receipts (
    tenant_scope text NOT NULL,
    resource_key text NOT NULL,
    operation_id text NOT NULL,
    PRIMARY KEY (tenant_scope, resource_key, operation_id)
) ON COMMIT PRESERVE ROWS;

BEGIN;
WITH fence AS MATERIALIZED (
    SELECT * FROM ores_locks.try_advance_fence(
        'tenant/rollback',
        'resource/rollback',
        '9007199254740993',
        'op-rollback',
        repeat('d', 64),
        'worker-rollback',
        'lease-rollback'
    )
), state_write AS (
    INSERT INTO protected_state (tenant_scope, resource_key, value)
    SELECT 'tenant/rollback', 'resource/rollback', 'must-disappear'
    FROM fence
    WHERE should_apply
    RETURNING 1
)
INSERT INTO fence_receipts (tenant_scope, resource_key, operation_id)
SELECT 'tenant/rollback', 'resource/rollback', 'op-rollback'
FROM fence
WHERE should_apply;
ROLLBACK;

DO $test$
BEGIN
    IF EXISTS (
        SELECT 1 FROM ores_locks.fencing_watermarks
        WHERE tenant_scope = 'tenant/rollback'
          AND resource_key = 'resource/rollback'
    ) THEN
        RAISE EXCEPTION 'rolled-back watermark remained visible';
    END IF;
    IF EXISTS (
        SELECT 1 FROM protected_state
        WHERE tenant_scope = 'tenant/rollback'
          AND resource_key = 'resource/rollback'
    ) THEN
        RAISE EXCEPTION 'rolled-back protected state remained visible';
    END IF;
    IF EXISTS (
        SELECT 1 FROM fence_receipts
        WHERE tenant_scope = 'tenant/rollback'
          AND resource_key = 'resource/rollback'
    ) THEN
        RAISE EXCEPTION 'rolled-back receipt remained visible';
    END IF;
END;
$test$;

-- Table constraints reject malformed stored state for normal writes.
DO $test$
BEGIN
    BEGIN
        INSERT INTO ores_locks.fencing_watermarks (
            tenant_scope, resource_key, fencing_token, operation_id,
            payload_sha256, holder, lease_id
        ) VALUES (
            'tenant/corrupt', 'resource/token',
            18446744073709551616, 'op', repeat('a', 64), NULL, NULL
        );
        RAISE EXCEPTION 'out-of-range stored token unexpectedly accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO ores_locks.fencing_watermarks (
            tenant_scope, resource_key, fencing_token, operation_id,
            payload_sha256, holder, lease_id
        ) VALUES (
            'tenant/corrupt', 'resource/digest', 1, 'op', repeat('A', 64), NULL, NULL
        );
        RAISE EXCEPTION 'uppercase stored digest unexpectedly accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
END;
$test$;

-- Simulate a row imported from an old or corrupted source while its check was
-- disabled. The function must fail closed and leave the malformed authority
-- byte-for-byte unchanged; a newer token may not silently repair it.
BEGIN;
ALTER TABLE ores_locks.fencing_watermarks
    DROP CONSTRAINT fencing_watermarks_payload_sha256_check;
INSERT INTO ores_locks.fencing_watermarks (
    tenant_scope,
    resource_key,
    fencing_token,
    operation_id,
    payload_sha256,
    holder,
    lease_id
) VALUES (
    'tenant/corrupt',
    'resource/legacy-corrupt',
    7,
    'op-corrupt',
    'not-a-digest',
    'worker-corrupt',
    'lease-corrupt'
);

DO $test$
DECLARE
    before_row jsonb;
    after_row jsonb;
BEGIN
    SELECT to_jsonb(watermark.*)
    INTO STRICT before_row
    FROM ores_locks.fencing_watermarks AS watermark
    WHERE tenant_scope = 'tenant/corrupt'
      AND resource_key = 'resource/legacy-corrupt';

    BEGIN
        PERFORM * FROM ores_locks.try_advance_fence(
            'tenant/corrupt',
            'resource/legacy-corrupt',
            '8',
            'op-new',
            repeat('f', 64),
            'worker-new',
            'lease-new'
        );
        RAISE EXCEPTION 'malformed stored watermark was silently repaired';
    EXCEPTION WHEN SQLSTATE '22000' THEN
        NULL;
    END;

    SELECT to_jsonb(watermark.*)
    INTO STRICT after_row
    FROM ores_locks.fencing_watermarks AS watermark
    WHERE tenant_scope = 'tenant/corrupt'
      AND resource_key = 'resource/legacy-corrupt';

    IF before_row <> after_row THEN
        RAISE EXCEPTION 'malformed stored watermark changed after rejection';
    END IF;
END;
$test$;
ROLLBACK;

-- The entire unsigned range and critical JavaScript/signed-bigint boundaries
-- are accepted as canonical text without narrowing.
DO $test$
DECLARE
    token text;
    tokens text[] := ARRAY[
        '0', '1', '9007199254740991', '9007199254740992',
        '9007199254740993', '9223372036854775807',
        '9223372036854775808', '9223372036854775809',
        '18446744073709551615'
    ];
    r record;
BEGIN
    FOREACH token IN ARRAY tokens LOOP
        SELECT * INTO STRICT r
        FROM ores_locks.try_advance_fence(
            'tenant/boundaries',
            'resource/' || token,
            token,
            'op-' || token,
            repeat('f', 64),
            NULL,
            NULL
        );
        IF r.decision <> 'advanced' OR r.current_token <> token THEN
            RAISE EXCEPTION 'token boundary % changed: %', token, row_to_json(r);
        END IF;
    END LOOP;
END;
$test$;

SELECT 'postgres adversarial fencing checks passed' AS result;
