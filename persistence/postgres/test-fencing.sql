\set ON_ERROR_STOP on
\ir fencing.sql

BEGIN;

TRUNCATE TABLE ores_locks.fencing_watermarks;

CREATE TEMP TABLE protected_state (
    tenant_scope text NOT NULL,
    resource_key text NOT NULL,
    value text NOT NULL,
    fencing_token numeric(20, 0) NOT NULL,
    PRIMARY KEY (tenant_scope, resource_key)
) ON COMMIT DROP;

DO $test$
DECLARE
    r record;
    v_value text;
    v_token text;
BEGIN
    SELECT *
    INTO STRICT r
    FROM ores_locks.try_advance_fence(
        'tenant/acme',
        'example/jobs/rebuild',
        '1',
        'op-1',
        repeat('a', 64),
        'worker-a',
        'lease-1'
    );

    IF r.decision <> 'advanced'
        OR r.should_apply IS NOT TRUE
        OR r.current_token <> '1'
        OR r.previous_token IS NOT NULL
    THEN
        RAISE EXCEPTION 'unexpected first decision: %', row_to_json(r);
    END IF;

    IF r.should_apply THEN
        INSERT INTO protected_state (
            tenant_scope,
            resource_key,
            value,
            fencing_token
        )
        VALUES (
            'tenant/acme',
            'example/jobs/rebuild',
            'first',
            r.current_token::numeric
        );
    END IF;

    SELECT *
    INTO STRICT r
    FROM ores_locks.try_advance_fence(
        'tenant/acme',
        'example/jobs/rebuild',
        '1',
        'op-1',
        repeat('a', 64),
        'worker-a-retry',
        'lease-1'
    );

    IF r.decision <> 'replay' OR r.should_apply IS NOT FALSE THEN
        RAISE EXCEPTION 'unexpected replay decision: %', row_to_json(r);
    END IF;

    SELECT value
    INTO STRICT v_value
    FROM protected_state
    WHERE tenant_scope = 'tenant/acme'
      AND resource_key = 'example/jobs/rebuild';

    IF v_value <> 'first' THEN
        RAISE EXCEPTION 'replay reapplied protected mutation';
    END IF;

    SELECT *
    INTO STRICT r
    FROM ores_locks.try_advance_fence(
        'tenant/acme',
        'example/jobs/rebuild',
        '1',
        'op-1',
        repeat('b', 64),
        NULL,
        NULL
    );

    IF r.decision <> 'token_reuse' OR r.should_apply IS NOT FALSE THEN
        RAISE EXCEPTION 'unexpected token-reuse decision: %', row_to_json(r);
    END IF;

    SELECT *
    INTO STRICT r
    FROM ores_locks.try_advance_fence(
        'tenant/acme',
        'example/jobs/rebuild',
        '2',
        'op-2',
        repeat('b', 64),
        'worker-b',
        'lease-2'
    );

    IF r.decision <> 'advanced'
        OR r.should_apply IS NOT TRUE
        OR r.previous_token <> '1'
    THEN
        RAISE EXCEPTION 'unexpected advance decision: %', row_to_json(r);
    END IF;

    IF r.should_apply THEN
        UPDATE protected_state
        SET value = 'second',
            fencing_token = r.current_token::numeric
        WHERE tenant_scope = 'tenant/acme'
          AND resource_key = 'example/jobs/rebuild';
    END IF;

    SELECT *
    INTO STRICT r
    FROM ores_locks.try_advance_fence(
        'tenant/acme',
        'example/jobs/rebuild',
        '1',
        'op-late',
        repeat('a', 64),
        'worker-a',
        'lease-1'
    );

    IF r.decision <> 'stale' OR r.should_apply IS NOT FALSE THEN
        RAISE EXCEPTION 'unexpected stale decision: %', row_to_json(r);
    END IF;

    SELECT value, fencing_token::text
    INTO STRICT v_value, v_token
    FROM protected_state
    WHERE tenant_scope = 'tenant/acme'
      AND resource_key = 'example/jobs/rebuild';

    IF v_value <> 'second' OR v_token <> '2' THEN
        RAISE EXCEPTION 'stale writer changed protected state: %, %', v_value, v_token;
    END IF;

    SELECT *
    INTO STRICT r
    FROM ores_locks.try_advance_fence(
        'tenant/acme',
        'example/jobs/rebuild',
        '18446744073709551615',
        'op-max',
        repeat('c', 64),
        'worker-max',
        'lease-max'
    );

    IF r.decision <> 'advanced'
        OR r.should_apply IS NOT TRUE
        OR r.current_token <> '18446744073709551615'
    THEN
        RAISE EXCEPTION 'uint64 maximum was not preserved: %', row_to_json(r);
    END IF;
END;
$test$;

DO $test$
BEGIN
    BEGIN
        PERFORM *
        FROM ores_locks.try_advance_fence(
            'tenant/acme',
            'example/jobs/invalid',
            '18446744073709551616',
            'op-invalid',
            repeat('d', 64),
            NULL,
            NULL
        );
        RAISE EXCEPTION 'out-of-range token unexpectedly accepted';
    EXCEPTION
        WHEN SQLSTATE '22023' THEN
            NULL;
    END;

    BEGIN
        PERFORM *
        FROM ores_locks.try_advance_fence(
            'tenant/acme',
            'example/jobs/invalid',
            '01',
            'op-invalid',
            repeat('d', 64),
            NULL,
            NULL
        );
        RAISE EXCEPTION 'non-canonical token unexpectedly accepted';
    EXCEPTION
        WHEN SQLSTATE '22023' THEN
            NULL;
    END;
END;
$test$;

ROLLBACK;
