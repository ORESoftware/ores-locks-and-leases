import gleam/list
import gleam/option.{None, Some}
import gleeunit
import gleeunit/should
import ores_locks_and_leases as locks
import ores_locks_and_leases/maintained

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

pub fn acquired_grant_preserves_holder_ttl_and_expiry_test() {
  let opts =
    locks.AcquireOptions(
      ttl_ms: 60_000,
      wait_timeout_ms: 30_000,
      retry_interval_ms: 250,
      holder: Some("holder-a"),
    )
  maintained.validate_acquired_grant(key(), True, opts, grant())
  |> should.equal(Ok(Nil))

  let changed_ttl = locks.LeaseGrant(..grant(), ttl_ms: 59_999)
  let assert Error(ttl_error) =
    maintained.validate_acquired_grant(key(), False, opts, changed_ttl)
  ttl_error.kind |> should.equal(locks.LostLease)
  ttl_error.step |> should.equal(Some(locks.FiduciaTryAcquire))

  let changed_holder = locks.LeaseGrant(..grant(), holder: "holder-b")
  let assert Error(holder_error) =
    maintained.validate_acquired_grant(key(), True, opts, changed_holder)
  holder_error.kind |> should.equal(locks.LostLease)

  let invalid_expiry = locks.LeaseGrant(..grant(), lease_expires_ms: Some(0))
  let assert Error(expiry_error) =
    maintained.validate_acquired_grant(key(), True, opts, invalid_expiry)
  expiry_error.kind |> should.equal(locks.LostLease)
}

pub fn maintained_renewal_preserves_identity_and_effective_ttl_test() {
  let original = grant()
  let lease =
    lease_with_renew(fn(value, ttl_ms) {
      Ok(locks.LeaseGrant(..value, ttl_ms: ttl_ms))
    })
  maintained.renew_checked(lease, original, 60_000)
  |> should.equal(Ok(original))
}

pub fn changed_fencing_token_or_ttl_is_lost_lease_test() {
  let original = grant()
  let changed_token =
    lease_with_renew(fn(value, _) {
      Ok(locks.LeaseGrant(
        ..value,
        fencing_token: value.fencing_token + 1,
      ))
    })
  let assert Error(token_error) =
    maintained.renew_checked(changed_token, original, 60_000)
  token_error.kind |> should.equal(locks.LostLease)
  token_error.step |> should.equal(Some(locks.FiduciaRenew))

  let changed_ttl =
    lease_with_renew(fn(value, _) {
      Ok(locks.LeaseGrant(..value, ttl_ms: 59_999))
    })
  let assert Error(ttl_error) =
    maintained.renew_checked(changed_ttl, original, 60_000)
  ttl_error.kind |> should.equal(locks.LostLease)
  ttl_error.step |> should.equal(Some(locks.FiduciaRenew))
}
