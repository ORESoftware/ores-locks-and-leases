import gleeunit/should
import ores_locks_and_leases/local_file
import simplifile

pub fn retry_sleep_never_outlives_remaining_budget_test() {
  let root = "./.tmp-local-file-retry-budget-v6"
  let _ = simplifile.delete_all([root])
  let assert Ok(Some(holder)) =
    local_file.try_acquire(root, "retry-budget.lock", "owner-a")

  let started = monotonic_ms()
  let assert Error(error) =
    local_file.acquire(
      root,
      "retry-budget.lock",
      "owner-b",
      local_file.LocalFileLockOptions(
        wait: True,
        wait_timeout_ms: 40,
        retry_interval_ms: 5000,
      ),
    )
  let elapsed = monotonic_ms() - started

  error.kind |> should.equal(local_file.Timeout)
  let assert True = elapsed < 1000
  local_file.release(holder) |> should.equal(Ok(Nil))
  let _ = simplifile.delete_all([root])
  Nil
}

@external(erlang, "local_file_budget_test_ffi", "monotonic_ms")
fn monotonic_ms() -> Int
