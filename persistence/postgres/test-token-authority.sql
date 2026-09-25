\set ON_ERROR_STOP on

BEGIN;

\ir token-authority.sql

DO $test$
DECLARE
    v1 numeric(20, 0);
    v2 numeric(20, 0);
    v_other numeric(20, 0);
    v_scoped numeric(20, 0);
    overflowed boolean := false;
BEGIN
    DELETE FROM ores_locks.fencing_counters;

    v1 := ores_locks.next_fencing_token('tenant-a', 'orders/42')::numeric;
    v2 := ores_locks.next_fencing_token('tenant-a', 'orders/42')::numeric;
    v_other := ores_locks.next_fencing_token('tenant-a', 'orders/43')::numeric;
    v_scoped := ores_locks.next_fencing_token('tenant-b', 'orders/42')::numeric;

    IF v1 <> 1 OR v2 <> 2 THEN
        RAISE EXCEPTION 'same scoped resource was not strictly monotonic: %, %', v1, v2;
    END IF;
    IF v_other <> 1 THEN
        RAISE EXCEPTION 'independent resource did not start its own epoch: %', v_other;
    END IF;
    IF v_scoped <> 1 THEN
        RAISE EXCEPTION 'independent tenant did not start its own epoch: %', v_scoped;
    END IF;

    -- Prove the allocator uses full uint64 decimal state rather than the
    -- JavaScript safe-integer range.
    UPDATE ores_locks.fencing_counters
    SET last_token = 9007199254740991::numeric
    WHERE tenant_scope = 'tenant-a' AND resource_key = 'orders/42';

    v2 := ores_locks.next_fencing_token('tenant-a', 'orders/42')::numeric;
    IF v2 <> 9007199254740992::numeric THEN
        RAISE EXCEPTION 'allocator failed to advance past 2^53-1: %', v2;
    END IF;

    UPDATE ores_locks.fencing_counters
    SET last_token = 18446744073709551615::numeric
    WHERE tenant_scope = 'tenant-a' AND resource_key = 'orders/42';

    BEGIN
        PERFORM ores_locks.next_fencing_token('tenant-a', 'orders/42');
    EXCEPTION WHEN numeric_value_out_of_range THEN
        overflowed := true;
    END;

    IF NOT overflowed THEN
        RAISE EXCEPTION 'allocator did not fail closed at uint64 exhaustion';
    END IF;

    BEGIN
        PERFORM ores_locks.next_fencing_token('', 'orders/42');
        RAISE EXCEPTION 'empty tenant scope was accepted';
    EXCEPTION WHEN invalid_parameter_value THEN
        NULL;
    END;

    BEGIN
        PERFORM ores_locks.next_fencing_token('tenant-a', '');
        RAISE EXCEPTION 'empty resource key was accepted';
    EXCEPTION WHEN invalid_parameter_value THEN
        NULL;
    END;
END;
$test$;

ROLLBACK;
