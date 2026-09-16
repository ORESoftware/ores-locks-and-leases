const configuredFaults = new Set<string>();

export class LocalFileTestCrash extends Error {
  readonly point: string;

  constructor(point: string) {
    super(`simulated abrupt local-file crash at ${point}`);
    this.name = "LocalFileTestCrash";
    this.point = point;
  }
}

/** Internal test-only control surface; intentionally not re-exported by index.ts. */
export function set_local_file_test_faults(points: readonly string[]): void {
  configuredFaults.clear();
  for (const point of points) configuredFaults.add(point);
}

export function clear_local_file_test_faults(): void {
  configuredFaults.clear();
}

export function local_file_test_fault_enabled(point: string): boolean {
  return configuredFaults.has(point);
}

/** Internal deterministic syscall failure seam. */
export function maybe_inject_local_file_test_fault(point: string, code = "EIO"): void {
  if (!local_file_test_fault_enabled(point)) return;
  const error = new Error(`injected local-file fault at ${point}`) as Error & { code: string };
  error.code = code;
  throw error;
}

/**
 * Simulates abrupt termination by throwing a distinguished internal error.
 * Acquisition code must rethrow it before rollback so tests can inspect the
 * exact filesystem state an abruptly terminated process would leave behind.
 */
export function maybe_simulate_local_file_test_crash(point: string): void {
  if (local_file_test_fault_enabled(point)) throw new LocalFileTestCrash(point);
}

export function is_local_file_test_crash(error: unknown): error is LocalFileTestCrash {
  return error instanceof LocalFileTestCrash;
}
