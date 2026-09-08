\set ON_ERROR_STOP on
\ir fencing.sql

TRUNCATE TABLE ores_locks.fencing_watermarks;

-- Tuple identity is structural. These pairs collide under naive concatenation
-- but must remain two independent authority rows.
SELECT * FROM ores_locks.try_advance_fence(
    'ab', 'c', '1', 'op-alias-a', repeat('a', 64), NULL, NULL
);
SELECT * FROM ores_locks.try_advance_fence(
    'a', 'bc', '1', 'op-alias-b', repeat('b', 64), NULL, NULL
);

DO $test$
BEGIN
    IF (
        SELECT count(*)
        FROM ores_locks.fencing_watermarks
        WHERE (tenant_scope, resource_key) IN (('ab', 'c'), ('a', 'bc'))
    ) <> 2 THEN
        RAISE EXCEPTION 'tenant/resource tuple identities aliased';
    END IF;
END;
$test$;

-- Byte limits, not code-point counts, are the cross-runtime contract.
SELECT * FROM ores_locks.try_advance_fence(
    repeat('é', 128),
    'example/utf8/tenant-boundary',
    '1',
    repeat('é', 64),
    repeat('c', 64),
    repeat('é', 128),
    repeat('é', 128)
);

DO $test$
BEGIN
    BEGIN
        PERFORM * FROM ores_locks.try_advance_fence(
            repeat('é', 129),
            'example/utf8/tenant-overlong',
            '1',
            'op-overlong',
            repeat('d', 64),
            NULL,
            NULL
        );
        RAISE EXCEPTION 'overlong UTF-8 tenant unexpectedly accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        NULL;
    END;

    BEGIN
        PERFORM * FROM ores_locks.try_advance_fence(
            'tenant/acme',
            'example/utf8/operation-overlong',
            '1',
            repeat('é', 65),
            repeat('d', 64),
            NULL,
            NULL
        );
        RAISE EXCEPTION 'overlong UTF-8 operation unexpectedly accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        NULL;
    END;
END;
$test$;

-- A transaction rollback must remove both the watermark advance and every
-- protected side effect performed in that same transaction.
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
        'example/jobs/rollback',
        '77',
        'op-rollback',
        repeat('e', 64),
        'worker-rollback',
        'lease-rollback'
    )
), state_write AS (
    INSERT INTO protected_state (tenant_scope, resource_key, value)
    SELECT 'tenant/rollback', 'example/jobs/rollback', 'must-disappear'
    FROM fence
    WHERE should_apply
    RETURNING 1
)
INSERT INTO fence_receipts (tenant_scope, resource_key, operation_id)
SELECT 'tenant/rollback', 'example/jobs/rollback', 'op-rollback'
FROM fence
WHERE should_apply;
ROLLBACK;

DO $test$
BEGIN
    IF EXISTS (
        SELECT 1 FROM ores_locks.fencing_watermarks
        WHERE tenant_scope = 'tenant/rollback'
          AND resource_key = 'example/jobs/rollback'
    ) THEN
        RAISE EXCEPTION 'rolled-back watermark remained visible';
    END IF;
    IF EXISTS (
        SELECT 1 FROM protected_state
        WHERE tenant_scope = 'tenant/rollback'
          AND resource_key = 'example/jobs/rollback'
    ) THEN
        RAISE EXCEPTION 'rolled-back protected state remained visible';
    END IF;
    IF EXISTS (
        SELECT 1 FROM fence_receipts
        WHERE tenant_scope = 'tenant/rollback'
          AND resource_key = 'example/jobs/rollback'
    ) THEN
        RAISE EXCEPTION 'rolled-back receipt remained visible';
    END IF;
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
    'example/jobs/corrupt',
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
      AND resource_key = 'example/jobs/corrupt';

    BEGIN
        PERFORM * FROM ores_locks.try_advance_fence(
            'tenant/corrupt',
            'example/jobs/corrupt',
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
      AND resource_key = 'example/jobs/corrupt';

    IF before_row <> after_row THEN
        RAISE EXCEPTION 'malformed stored watermark changed after rejection';
    END IF;
END;
$test$;
ROLLBACK;

TRUNCATE TABLE ores_locks.fencing_watermarks;
