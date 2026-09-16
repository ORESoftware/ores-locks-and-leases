const LOCAL_FILE_TEST_FAULTS_ENV = "ORES_LOCAL_FILE_TEST_FAULTS";

function configured_faults(): Set<string> {
  if (process.env.NODE_ENV !== "test") return new Set();
  return new Set(
    (process.env[LOCAL_FILE_TEST_FAULTS_ENV] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
}

/** Internal deterministic fault seam. It is inert unless NODE_ENV=test. */
export function local_file_test_fault_enabled(point: string): boolean {
  return configured_faults().has(point);
}

/** Internal deterministic syscall failure seam. It is not re-exported publicly. */
export function maybe_inject_local_file_test_fault(point: string, code = "EIO"): void {
  if (!local_file_test_fault_enabled(point)) return;
  const error = new Error(`injected local-file fault at ${point}`) as Error & { code: string };
  error.code = code;
  throw error;
}

/** Internal abrupt-process seam used only by child-process conformance probes. */
export function maybe_crash_local_file_test_fault(point: string, exitCode: number): void {
  if (!local_file_test_fault_enabled(point)) return;
  process.exit(exitCode);
}
