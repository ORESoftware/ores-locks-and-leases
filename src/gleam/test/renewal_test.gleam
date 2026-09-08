import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/option.{Some}
import gleeunit
import gleeunit/should
import ores_locks_and_leases as core
import ores_locks_and_leases/renewal
import simplifile

pub fn main() {
  gleeunit.main()
}

fn grant(token: Int, ttl_ms: Int, deadline: Int) -> core.LeaseGrant {
  let assert Ok(key) = core.lock_key("renewal/test/resource")
  core.LeaseGrant(
    key: key,
    holder: "holder-a",
    fencing_token: token,
    lease_expires_ms: Some(deadline),
    ttl_ms: ttl_ms,
  )
}

pub fn renewal_decision_corpus_test() {
  let expect_decoder = {
    use kind <- decode.field("kind", decode.string)
    use check_in_ms <- decode.field("checkInMs", decode.int)
    use reason <- decode.field("reason", decode.string)
    decode.success(#(kind, check_in_ms, reason))
  }
  let case_decoder = {
    use name <- decode.field("name", decode.string)
    use start_ms <- decode.field("startMs", decode.int)
    use ttl_ms <- decode.field("ttlMs", decode.int)
    use renew_every_ms <- decode.field("renewEveryMs", decode.int)
    use safety_margin_ms <- decode.field("safetyMarginMs", decode.int)
    use now_ms <- decode.field("nowMs", decode.int)
    use expect <- decode.field("expect", expect_decoder)
    decode.success(#(
      name,
      start_ms,
      ttl_ms,
      renew_every_ms,
      safety_margin_ms,
      now_ms,
      expect,
    ))
  }
  let decoder = {
    use cases <- decode.field("cases", decode.list(case_decoder))
    decode.success(cases)
  }
  let assert Ok(text) =
    simplifile.read("../../conformance/cases/renewal-decision.json")
  let assert Ok(cases) = json.parse(text, decoder)
  list.each(cases, fn(entry) {
    let #(
      _name,
      start_ms,
      ttl_ms,
      renew_every_ms,
      safety_margin_ms,
      now_ms,
      #(expected_kind, expected_check, expected_reason),
    ) = entry
    let created =
      renewal.new(
        grant(18_446_744_073_709_551_615, ttl_ms, 100_000),
        renewal.RenewalPolicy(renew_every_ms, safety_margin_ms),
        start_ms,
      )
    case expected_kind, created {
      "invalid", Error(reason) ->
        renewal.loss_reason_to_string(reason) |> should.equal(expected_reason)
      _, Ok(supervisor) -> {
        let #(supervisor, decision) = renewal.decision(supervisor, now_ms)
        supervisor.grant.fencing_token
        |> should.equal(18_446_744_073_709_551_615)
        case decision {
          renewal.Wait(check_in_ms) -> {
            expected_kind |> should.equal("wait")
            check_in_ms |> should.equal(expected_check)
          }
          renewal.RenewNow -> expected_kind |> should.equal("renew_now")
          renewal.Lost(reason) -> {
            expected_kind |> should.equal("lost")
            renewal.loss_reason_to_string(reason)
            |> should.equal(expected_reason)
          }
        }
      }
      _, _ -> False |> should.be_true
    }
  })
}

pub fn successful_renewal_preserves_identity_test() {
  let assert Ok(supervisor) =
    renewal.new(
      grant(18_446_744_073_709_551_615, 10_000, 100_000),
      renewal.RenewalPolicy(4000, 2000),
      1000,
    )
  let renew = fn(old, _ttl_ms) {
    Ok(core.LeaseGrant(..old, lease_expires_ms: Some(110_000)))
  }
  let #(next, result) = renewal.checkpoint(supervisor, 5000, 5100, renew)
  result |> should.equal(Ok(renewal.Renewed(4000)))
  next.local_deadline_ms |> should.equal(15_100)
  next.next_renewal_ms |> should.equal(9100)
  next.grant.fencing_token |> should.equal(18_446_744_073_709_551_615)
}

pub fn identity_and_token_drift_are_terminal_test() {
  let assert Ok(supervisor) =
    renewal.new(
      grant(7, 10_000, 100_000),
      renewal.RenewalPolicy(4000, 2000),
      1000,
    )
  let changed_holder =
    core.LeaseGrant(
      ..supervisor.grant,
      holder: "holder-b",
      lease_expires_ms: Some(110_000),
    )
  let #(lost, result) = renewal.accept_renewal(supervisor, 5100, changed_holder)
  result |> should.equal(Error(renewal.IdentityChanged))
  let #(_, sticky) = renewal.decision(lost, 5200)
  sticky |> should.equal(renewal.Lost(renewal.IdentityChanged))
}

pub fn renewal_failure_is_sticky_test() {
  let assert Ok(supervisor) =
    renewal.new(
      grant(7, 10_000, 100_000),
      renewal.RenewalPolicy(4000, 2000),
      1000,
    )
  let renew = fn(old, _ttl_ms) {
    Error(core.transport_error(old.key, "partition"))
  }
  let #(lost, result) = renewal.checkpoint(supervisor, 5000, 5100, renew)
  result |> should.equal(Error(renewal.RenewalFailed))
  let #(_, second) = renewal.checkpoint(lost, 5200, 5300, renew)
  second |> should.equal(Error(renewal.RenewalFailed))
}
