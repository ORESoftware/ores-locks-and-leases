//// Deterministic, fail-closed supervision for long-running Fiducia leases.
////
//// Checkpoint before every authoritative commit. This is cooperative
//// cancellation; it cannot undo an unfenced effect already emitted by the
//// caller. Protected datastores must still admit the fencing token atomically.

import gleam/option.{type Option, None, Some}
import ores_locks_and_leases as core

pub const max_renewal_clock_ms = 9_007_199_254_740_991

pub const max_renewal_ttl_ms = 9_223_372_036_854

pub type RenewalPolicy {
  RenewalPolicy(renew_every_ms: Int, safety_margin_ms: Int)
}

pub fn default_policy() -> RenewalPolicy {
  RenewalPolicy(renew_every_ms: 20_000, safety_margin_ms: 10_000)
}

pub type LossReason {
  InvalidPolicy
  ClockRegression
  Expired
  RenewalFailed
  IdentityChanged
  TokenChanged
  DeadlineMissing
  DeadlineInvalid
  DeadlineRegressed
  CompletionAfterDeadline
  DeadlineOverflow
  InvalidTtl
}

pub fn loss_reason_to_string(reason: LossReason) -> String {
  case reason {
    InvalidPolicy -> "invalid_policy"
    ClockRegression -> "clock_regression"
    Expired -> "expired"
    RenewalFailed -> "renewal_failed"
    IdentityChanged -> "identity_changed"
    TokenChanged -> "token_changed"
    DeadlineMissing -> "deadline_missing"
    DeadlineInvalid -> "deadline_invalid"
    DeadlineRegressed -> "deadline_regressed"
    CompletionAfterDeadline -> "completion_after_deadline"
    DeadlineOverflow -> "deadline_overflow"
    InvalidTtl -> "invalid_ttl"
  }
}

pub type Decision {
  Wait(check_in_ms: Int)
  RenewNow
  Lost(reason: LossReason)
}

pub type Checkpoint {
  CheckpointWait(check_in_ms: Int)
  Renewed(check_in_ms: Int)
}

pub type Supervisor {
  Supervisor(
    grant: core.LeaseGrant,
    policy: RenewalPolicy,
    local_deadline_ms: Int,
    next_renewal_ms: Int,
    last_observed_ms: Int,
    loss: Option(LossReason),
  )
}

pub fn new(
  grant: core.LeaseGrant,
  policy: RenewalPolicy,
  now_ms: Int,
) -> Result(Supervisor, LossReason) {
  case valid_clock(now_ms) {
    False -> Error(DeadlineOverflow)
    True ->
      case valid_authority_deadline(grant.lease_expires_ms) {
        False -> Error(DeadlineInvalid)
        True ->
          case schedule(now_ms, grant.ttl_ms, policy) {
            Error(reason) -> Error(reason)
            Ok(#(deadline_ms, next_renewal_ms)) ->
              Ok(Supervisor(
                grant: grant,
                policy: policy,
                local_deadline_ms: deadline_ms,
                next_renewal_ms: next_renewal_ms,
                last_observed_ms: now_ms,
                loss: None,
              ))
          }
      }
  }
}

pub fn decision(supervisor: Supervisor, now_ms: Int) -> #(Supervisor, Decision) {
  case supervisor.loss {
    Some(reason) -> #(supervisor, Lost(reason))
    None ->
      case valid_clock(now_ms), now_ms < supervisor.last_observed_ms,
        now_ms >= supervisor.local_deadline_ms
      {
        False, _, _ -> lose(supervisor, DeadlineOverflow)
        _, True, _ -> lose(supervisor, ClockRegression)
        _, _, True ->
          lose(Supervisor(..supervisor, last_observed_ms: now_ms), Expired)
        _ -> {
          let next = Supervisor(..supervisor, last_observed_ms: now_ms)
          case now_ms >= next.next_renewal_ms {
            True -> #(next, RenewNow)
            False -> #(next, Wait(next.next_renewal_ms - now_ms))
          }
        }
      }
  }
}

pub fn checkpoint(
  supervisor: Supervisor,
  started_ms: Int,
  completed_ms: Int,
  renew: fn(core.LeaseGrant, Int) -> Result(core.LeaseGrant, core.LockError),
) -> #(Supervisor, Result(Checkpoint, LossReason)) {
  let #(supervisor, action) = decision(supervisor, started_ms)
  case action {
    Wait(check_in_ms) -> #(supervisor, Ok(CheckpointWait(check_in_ms)))
    Lost(reason) -> #(supervisor, Error(reason))
    RenewNow ->
      case renew(supervisor.grant, supervisor.grant.ttl_ms) {
        Error(_) -> {
          let #(lost, _) = lose(supervisor, RenewalFailed)
          #(lost, Error(RenewalFailed))
        }
        Ok(renewed) -> accept_renewal(supervisor, completed_ms, renewed)
      }
  }
}

pub fn accept_renewal(
  supervisor: Supervisor,
  completed_ms: Int,
  renewed: core.LeaseGrant,
) -> #(Supervisor, Result(Checkpoint, LossReason)) {
  case supervisor.loss {
    Some(reason) -> #(supervisor, Error(reason))
    None ->
      case valid_clock(completed_ms),
        completed_ms < supervisor.last_observed_ms,
        completed_ms >= supervisor.local_deadline_ms,
        core.key_to_string(renewed.key)
          == core.key_to_string(supervisor.grant.key)
          && renewed.holder == supervisor.grant.holder,
        renewed.fencing_token == supervisor.grant.fencing_token,
        deadline_progress(
          supervisor.grant.lease_expires_ms,
          renewed.lease_expires_ms,
        )
      {
        False, _, _, _, _, _ -> fail(supervisor, DeadlineOverflow)
        _, True, _, _, _, _ -> fail(supervisor, ClockRegression)
        _, _, True, _, _, _ -> fail(supervisor, CompletionAfterDeadline)
        _, _, _, False, _, _ -> fail(supervisor, IdentityChanged)
        _, _, _, _, False, _ -> fail(supervisor, TokenChanged)
        _, _, _, _, _, Error(reason) -> fail(supervisor, reason)
        _, _, _, _, _, Ok(Nil) ->
          case schedule(completed_ms, renewed.ttl_ms, supervisor.policy) {
            Error(reason) -> fail(supervisor, reason)
            Ok(#(deadline_ms, next_renewal_ms)) -> {
              let next = Supervisor(
                ..supervisor,
                grant: renewed,
                local_deadline_ms: deadline_ms,
                next_renewal_ms: next_renewal_ms,
                last_observed_ms: completed_ms,
              )
              #(next, Ok(Renewed(next_renewal_ms - completed_ms)))
            }
          }
      }
  }
}

fn fail(
  supervisor: Supervisor,
  reason: LossReason,
) -> #(Supervisor, Result(Checkpoint, LossReason)) {
  let #(lost, _) = lose(supervisor, reason)
  #(lost, Error(reason))
}

fn lose(supervisor: Supervisor, reason: LossReason) -> #(Supervisor, Decision) {
  let recorded = case supervisor.loss {
    Some(existing) -> existing
    None -> reason
  }
  let next = Supervisor(..supervisor, loss: Some(recorded))
  #(next, Lost(recorded))
}

fn schedule(
  now_ms: Int,
  ttl_ms: Int,
  policy: RenewalPolicy,
) -> Result(#(Int, Int), LossReason) {
  case valid_clock(now_ms),
    ttl_ms > 0 && ttl_ms <= max_renewal_ttl_ms,
    policy.renew_every_ms > 0 && policy.renew_every_ms < ttl_ms,
    policy.safety_margin_ms > 0 && policy.safety_margin_ms < ttl_ms,
    now_ms <= max_renewal_clock_ms - ttl_ms,
    now_ms <= max_renewal_clock_ms - policy.renew_every_ms
  {
    False, _, _, _, _, _ -> Error(DeadlineOverflow)
    _, False, _, _, _, _ -> Error(InvalidTtl)
    _, _, False, _, _, _ -> Error(InvalidPolicy)
    _, _, _, False, _, _ -> Error(InvalidPolicy)
    _, _, _, _, False, _ -> Error(DeadlineOverflow)
    _, _, _, _, _, False -> Error(DeadlineOverflow)
    _ -> {
      let deadline_ms = now_ms + ttl_ms
      let interval_due = now_ms + policy.renew_every_ms
      let margin_due = deadline_ms - policy.safety_margin_ms
      let next_renewal_ms = case interval_due < margin_due {
        True -> interval_due
        False -> margin_due
      }
      case next_renewal_ms > now_ms {
        True -> Ok(#(deadline_ms, next_renewal_ms))
        False -> Error(InvalidPolicy)
      }
    }
  }
}

fn deadline_progress(
  previous: Option(Int),
  renewed: Option(Int),
) -> Result(Nil, LossReason) {
  case previous, renewed {
    _, Some(value) if value <= 0 || value > max_renewal_clock_ms ->
      Error(DeadlineInvalid)
    Some(_), None -> Error(DeadlineMissing)
    Some(old), Some(next) if next <= old -> Error(DeadlineRegressed)
    _, _ -> Ok(Nil)
  }
}

fn valid_authority_deadline(deadline: Option(Int)) -> Bool {
  case deadline {
    None -> True
    Some(value) -> value > 0 && value <= max_renewal_clock_ms
  }
}

fn valid_clock(value: Int) -> Bool {
  value >= 0 && value <= max_renewal_clock_ms
}
