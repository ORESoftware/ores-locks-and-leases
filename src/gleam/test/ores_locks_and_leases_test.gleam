import gleam/dynamic/decode
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/string
import gleeunit
import gleeunit/should
import ores_locks_and_leases as locks
import simplifile

pub fn main() {
  gleeunit.main()
}

fn read_cases(name: String) -> String {
  let assert Ok(text) = simplifile.read("../../conformance/cases/" <> name)
  text
}

pub fn advisory_key_vectors_test() {
  let case_decoder = {
    use key <- decode.field("key", decode.string)
    use unsigned <- decode.field("fnv1a64_unsigned", decode.string)
    use signed <- decode.field("advisory_key", decode.string)
    decode.success(#(key, unsigned, signed))
  }
  let decoder = {
    use cases <- decode.field("cases", decode.list(case_decoder))
    decode.success(cases)
  }
  let assert Ok(cases) = json.parse(read_cases("advisory-key.json"), decoder)
  should.be_true(list.length(cases) >= 8)
  list.each(cases, fn(c) {
    let #(key, unsigned, signed) = c
    let assert Ok(unsigned) = int.parse(unsigned)
    let assert Ok(signed) = int.parse(signed)
    locks.fnv1a64(key) |> should.equal(unsigned)
    locks.advisory_key(key) |> should.equal(signed)
  })
}

pub fn lock_plan_matrix_test() {
  let layers_decoder = {
    use fiducia <- decode.field("fiducia", decode.bool)
    use pg_advisory <- decode.field("pgAdvisory", decode.bool)
    decode.success(locks.Layers(fiducia, pg_advisory))
  }
  let case_decoder = {
    use name <- decode.field("name", decode.string)
    use layers <- decode.field("layers", layers_decoder)
    use scope <- decode.field("pgScope", decode.string)
    use wait <- decode.field("wait", decode.bool)
    use steps <- decode.subfield(
      ["expect", "steps"],
      decode.list(decode.string),
    )
    decode.success(#(name, layers, scope, wait, steps))
  }
  let decoder = {
    use cases <- decode.field("cases", decode.list(case_decoder))
    decode.success(cases)
  }
  let assert Ok(cases) = json.parse(read_cases("lock-plan.json"), decoder)
  list.length(cases) |> should.equal(11)
  list.each(cases, fn(c) {
    let #(_name, layers, scope, wait, expected) = c
    let assert Ok(scope) = locks.pg_scope_from_string(scope)
    let assert Ok(expected) = list.try_map(expected, locks.step_from_string)
    locks.plan(layers, scope, wait).steps |> should.equal(expected)
  })
}

pub fn key_length_is_bounded_test() {
  let assert Ok(_) = locks.lock_key(string_repeat("x", 512))
  let assert Error(_) = locks.lock_key(string_repeat("x", 513))
}

fn string_repeat(s: String, n: Int) -> String {
  list.repeat(s, n) |> list.fold("", fn(acc, x) { acc <> x })
}

// --- fake lease -------------------------------------------------------------

type Fake {
  Fake(held: Bool, lapse_on_release: Bool, fail_release: Bool)
}

fn fake_lease(fake: Fake) -> locks.Lease {
  locks.Lease(
    acquire: fn(key, opts, wait) {
      case fake.held, wait {
        True, True ->
          Error(locks.timeout(key, locks.FiduciaAcquire, opts.wait_timeout_ms))
        True, False -> Error(locks.contention(key, locks.FiduciaTryAcquire))
        False, _ ->
          Ok(locks.LeaseGrant(
            key: key,
            holder: "fake",
            fencing_token: 1,
            lease_expires_ms: None,
            ttl_ms: opts.ttl_ms,
          ))
      }
    },
    renew: fn(grant, ttl_ms) { Ok(locks.LeaseGrant(..grant, ttl_ms: ttl_ms)) },
    release: fn(grant) {
      case fake.fail_release {
        True ->
          Error(locks.transport_error(
            grant.key,
            "release transport failed; ownership is unknown",
          ))
        False -> Ok(!fake.lapse_on_release)
      }
    },
  )
}

fn key() -> locks.LockKey {
  let assert Ok(key) = locks.lock_key("t/unit")
  key
}

pub fn with_lease_disabled_is_pass_through_test() {
  locks.with_lease(
    key(),
    False,
    True,
    locks.default_acquire_options(),
    Some(fake_lease(Fake(False, False, False))),
    fn(grant) { Ok(option.is_none(grant)) },
  )
  |> should.equal(Ok(True))
}

pub fn with_lease_without_authority_is_invalid_plan_test() {
  let assert Error(error) =
    locks.with_lease(
      key(),
      True,
      True,
      locks.default_acquire_options(),
      None,
      fn(_) { Ok(Nil) },
    )
  error.kind |> should.equal(locks.InvalidPlan)
}

pub fn with_lease_threads_the_fencing_token_test() {
  locks.with_lease(
    key(),
    True,
    True,
    locks.default_acquire_options(),
    Some(fake_lease(Fake(False, False, False))),
    fn(grant) {
      let assert Some(grant) = grant
      Ok(grant.fencing_token)
    },
  )
  |> should.equal(Ok(1))
}

pub fn with_lease_work_failure_is_work_test() {
  let assert Error(error) =
    locks.with_lease(
      key(),
      True,
      False,
      locks.default_acquire_options(),
      Some(fake_lease(Fake(False, False, False))),
      fn(_) { Error("kaboom") },
    )
  error.kind |> should.equal(locks.WorkFailed)
  error.step |> should.equal(Some(locks.Work))
  error.message |> should.equal("kaboom")
}

pub fn with_lease_contention_timeout_and_lost_lease_test() {
  let busy = Some(fake_lease(Fake(True, False, False)))
  let assert Error(contended) =
    locks.with_lease(
      key(),
      True,
      False,
      locks.default_acquire_options(),
      busy,
      fn(_) { Ok(Nil) },
    )
  contended.kind |> should.equal(locks.Contention)
  locks.retryable(contended) |> should.be_true
  let assert Error(timed_out) =
    locks.with_lease(
      key(),
      True,
      True,
      locks.default_acquire_options(),
      busy,
      fn(_) { Ok(Nil) },
    )
  timed_out.kind |> should.equal(locks.Timeout)
  let assert Error(lost) =
    locks.with_lease(
      key(),
      True,
      True,
      locks.default_acquire_options(),
      Some(fake_lease(Fake(False, True, False))),
      fn(_) { Ok(Nil) },
    )
  lost.kind |> should.equal(locks.LostLease)
  lost.step |> should.equal(Some(locks.FiduciaRelease))
}

pub fn cleanup_failure_wins_over_work_failure_test() {
  let assert Error(error) =
    locks.with_lease(
      key(),
      True,
      True,
      locks.default_acquire_options(),
      Some(fake_lease(Fake(False, False, True))),
      fn(_) { Error("work exploded") },
    )
  error.kind |> should.equal(locks.Transport)
  error.step |> should.equal(Some(locks.FiduciaRelease))
  string.contains(error.message, "work exploded") |> should.be_true
}

pub fn confirmed_lapse_wins_over_work_failure_test() {
  let assert Error(error) =
    locks.with_lease(
      key(),
      True,
      True,
      locks.default_acquire_options(),
      Some(fake_lease(Fake(False, True, False))),
      fn(_) { Error("work exploded") },
    )
  error.kind |> should.equal(locks.LostLease)
  error.step |> should.equal(Some(locks.FiduciaRelease))
  string.contains(error.message, "work exploded") |> should.be_true
}
