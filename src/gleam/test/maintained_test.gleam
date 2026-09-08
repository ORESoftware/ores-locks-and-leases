import gleam/list
import gleam/option.{None, Some}
import gleeunit
import gleeunit/should
import ores_locks_and_leases as locks

pub fn main() {
  gleeunit.main()
}

fn key() -> locks.LockKey {
  let assert Ok(key) = locks.lock_key("tests/maintained")
  key
}

fn grant() -> locks.LeaseGrant {
  locks.LeaseGrant(
    key: key(),
    holder: "holder-a",
    fencing_token: 41,
    lease_expires_ms: None,
    ttl_ms: 60_000,
  )
}

fn lease_with_renew(
  renew: fn(locks.LeaseGrant, Int) -> Result(locks.LeaseGrant, locks.LockError),
) -> locks.Lease {
  locks.Lease(
    acquire: fn(_, _, _) { Ok(grant()) },
    renew: renew,
    release: fn(_) { Ok(True) },
  )
}

pub fn renewal_step_round_trips_without_changing_legacy_plan_test() {
  locks.step_from_string("fiducia.renew")
  |> should.equal(Ok(locks.FiduciaRenew))

  let legacy = locks.plan(locks.layers_both, locks.Transaction, True)
  legacy.steps
  |> list.contains(locks.FiduciaRenew)
  |> should.be_false
}

pub fn maintenance_options_are_fail_closed_test() {
  let opts =
    locks.AcquireOptions(
      ttl_ms: 100,
      wait_timeout_ms: 30,
      retry_interval_ms: 5,
      holder: None,
    )

  locks.validate_lease_maintenance_options(
    key(),
    opts,
    locks.LeaseMaintenanceOptions(renew_interval_ms: 50),
    True,
  )
  |> should.equal(Ok(Nil))

  let assert Error(error) =
    locks.validate_lease_maintenance_options(
      key(),
      opts,
      locks.LeaseMaintenanceOptions(renew_interval_ms: 51),
      True,
    )
  error.kind |> should.equal(locks.InvalidPlan)
}

pub fn renewal_preserves_fenced_identity_test() {
  let original = grant()
  let lease =
    lease_with_renew(fn(value, ttl_ms) {
      Ok(locks.LeaseGrant(..value, ttl_ms: ttl_ms))
    })
  locks.renew_checked(lease, original, 90_000)
  |> should.equal(Ok(locks.LeaseGrant(..original, ttl_ms: 90_000)))
}

pub fn changed_fencing_token_is_lost_lease_test() {
  let original = grant()
  let lease =
    lease_with_renew(fn(value, _) {
      Ok(locks.LeaseGrant(..value, fencing_token: value.fencing_token + 1))
    })
  let assert Error(error) = locks.renew_checked(lease, original, 90_000)
  error.kind |> should.equal(locks.LostLease)
  error.step |> should.equal(Some(locks.FiduciaRenew))
}
