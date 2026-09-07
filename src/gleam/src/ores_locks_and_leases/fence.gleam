//// Application-side fencing decisions.
////
//// Tokens use canonical unsigned-64 decimal text at every wire/storage
//// boundary. Gleam's Erlang-target Int is arbitrary precision, so comparison
//// stays exact without converting through a float.

import gleam/bit_array
import gleam/int
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import ores_locks_and_leases as locks

pub const max_fencing_token_text = "18446744073709551615"

pub const max_tenant_scope_bytes = 256

pub const max_operation_id_bytes = 128

pub const max_fence_metadata_bytes = 256

const max_fencing_token = 18_446_744_073_709_551_615

/// Canonical, lossless decimal representation of a Fiducia uint64 token.
pub opaque type FencingTokenText {
  FencingTokenText(text: String, value: Int)
}

pub fn fencing_token_text(
  text: String,
) -> Result(FencingTokenText, FenceValidationError) {
  let graphemes = string.to_graphemes(text)
  let canonical = case text {
    "0" -> True
    _ ->
      list.length(graphemes) > 0
      && list.length(graphemes) <= 20
      && !string.starts_with(text, "0")
      && list.all(graphemes, is_decimal_digit)
  }

  case canonical, int.parse(text) {
    True, Ok(value) if value >= 0 && value <= max_fencing_token ->
      Ok(FencingTokenText(text: text, value: value))
    _, _ -> Error(InvalidFencingToken(text))
  }
}

pub fn fencing_token_to_string(token: FencingTokenText) -> String {
  token.text
}

pub fn fencing_token_value(token: FencingTokenText) -> Int {
  token.value
}

fn is_decimal_digit(value: String) -> Bool {
  list.contains(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"], value)
}

/// Stable decision vocabulary shared by SQL, Redis, and every runtime.
pub type FenceDecisionKind {
  Advanced
  Replay
  Stale
  TokenReuse
}

pub fn fence_decision_kind_to_string(kind: FenceDecisionKind) -> String {
  case kind {
    Advanced -> "advanced"
    Replay -> "replay"
    Stale -> "stale"
    TokenReuse -> "token_reuse"
  }
}

/// One application mutation guarded by a Fiducia token.
pub type FencedWriteRequest {
  FencedWriteRequest(
    tenant_scope: String,
    resource_key: locks.LockKey,
    fencing_token: FencingTokenText,
    operation_id: String,
    payload_sha256: String,
    holder: Option(String),
    lease_id: Option(String),
  )
}

pub fn new_fenced_write_request(
  tenant_scope: String,
  resource_key: locks.LockKey,
  fencing_token: FencingTokenText,
  operation_id: String,
  payload_sha256: String,
  holder: Option(String),
  lease_id: Option(String),
) -> Result(FencedWriteRequest, FenceValidationError) {
  use _ <- result.try(validate_field(
    "tenantScope",
    tenant_scope,
    max_tenant_scope_bytes,
  ))
  use _ <- result.try(validate_field(
    "resourceKey",
    locks.key_to_string(resource_key),
    locks.max_lock_key_bytes,
  ))
  use _ <- result.try(validate_field(
    "operationId",
    operation_id,
    max_operation_id_bytes,
  ))
  use _ <- result.try(validate_optional_field(
    "holder",
    holder,
    max_fence_metadata_bytes,
  ))
  use _ <- result.try(validate_optional_field(
    "leaseId",
    lease_id,
    max_fence_metadata_bytes,
  ))
  use _ <- result.try(validate_payload_sha256(payload_sha256))

  Ok(FencedWriteRequest(
    tenant_scope: tenant_scope,
    resource_key: resource_key,
    fencing_token: fencing_token,
    operation_id: operation_id,
    payload_sha256: payload_sha256,
    holder: holder,
    lease_id: lease_id,
  ))
}

/// Last accepted write for one tenant/resource identity.
pub type FenceWatermark {
  FenceWatermark(
    tenant_scope: String,
    resource_key: locks.LockKey,
    fencing_token: FencingTokenText,
    operation_id: String,
    payload_sha256: String,
    holder: Option(String),
    lease_id: Option(String),
  )
}

pub fn watermark_from_request(request: FencedWriteRequest) -> FenceWatermark {
  FenceWatermark(
    tenant_scope: request.tenant_scope,
    resource_key: request.resource_key,
    fencing_token: request.fencing_token,
    operation_id: request.operation_id,
    payload_sha256: request.payload_sha256,
    holder: request.holder,
    lease_id: request.lease_id,
  )
}

/// Pure decision data. `should_apply` is true only for `Advanced`.
pub type FenceDecision {
  FenceDecision(
    kind: FenceDecisionKind,
    should_apply: Bool,
    incoming_token: FencingTokenText,
    current_token: FencingTokenText,
    previous_token: Option(FencingTokenText),
  )
}

/// Compare an incoming request with an optional current watermark.
///
/// The datastore adapter must persist an `Advanced` watermark and perform the
/// protected mutation in the same transaction or Redis script.
pub fn evaluate_fence(
  current: Option(FenceWatermark),
  incoming: FencedWriteRequest,
) -> Result(FenceDecision, FenceValidationError) {
  case current {
    None ->
      Ok(FenceDecision(
        kind: Advanced,
        should_apply: True,
        incoming_token: incoming.fencing_token,
        current_token: incoming.fencing_token,
        previous_token: None,
      ))
    Some(current) -> {
      case
        current.tenant_scope == incoming.tenant_scope
        && current.resource_key == incoming.resource_key
      {
        False -> Error(IdentityMismatch)
        True -> {
          let previous = Some(current.fencing_token)
          let incoming_value = fencing_token_value(incoming.fencing_token)
          let current_value = fencing_token_value(current.fencing_token)
          case incoming_value > current_value, incoming_value < current_value {
            True, _ ->
              Ok(FenceDecision(
                kind: Advanced,
                should_apply: True,
                incoming_token: incoming.fencing_token,
                current_token: incoming.fencing_token,
                previous_token: previous,
              ))
            False, True ->
              Ok(FenceDecision(
                kind: Stale,
                should_apply: False,
                incoming_token: incoming.fencing_token,
                current_token: current.fencing_token,
                previous_token: previous,
              ))
            False, False -> {
              let kind = case
                current.operation_id == incoming.operation_id
                && current.payload_sha256 == incoming.payload_sha256
              {
                True -> Replay
                False -> TokenReuse
              }
              Ok(FenceDecision(
                kind: kind,
                should_apply: False,
                incoming_token: incoming.fencing_token,
                current_token: current.fencing_token,
                previous_token: previous,
              ))
            }
          }
        }
      }
    }
  }
}

/// Validation failures surfaced before any datastore mutation.
pub type FenceValidationError {
  EmptyField(String)
  TooLong(field: String, bytes: Int, max: Int)
  InvalidFencingToken(String)
  InvalidPayloadSha256
  IdentityMismatch
}

pub fn fence_validation_error_code(error: FenceValidationError) -> String {
  case error {
    EmptyField(_) -> "empty_field"
    TooLong(_, _, _) -> "too_long"
    InvalidFencingToken(_) -> "invalid_fencing_token"
    InvalidPayloadSha256 -> "invalid_payload_sha256"
    IdentityMismatch -> "identity_mismatch"
  }
}

fn validate_field(
  field: String,
  value: String,
  max: Int,
) -> Result(Nil, FenceValidationError) {
  let bytes = bit_array.byte_size(bit_array.from_string(value))
  case bytes {
    0 -> Error(EmptyField(field))
    bytes if bytes > max -> Error(TooLong(field: field, bytes: bytes, max: max))
    _ -> Ok(Nil)
  }
}

fn validate_optional_field(
  field: String,
  value: Option(String),
  max: Int,
) -> Result(Nil, FenceValidationError) {
  case value {
    None -> Ok(Nil)
    Some(value) -> validate_field(field, value, max)
  }
}

fn validate_payload_sha256(value: String) -> Result(Nil, FenceValidationError) {
  let graphemes = string.to_graphemes(value)
  case list.length(graphemes) == 64 && list.all(graphemes, is_lower_hex_digit) {
    True -> Ok(Nil)
    False -> Error(InvalidPayloadSha256)
  }
}

fn is_lower_hex_digit(value: String) -> Bool {
  list.contains(
    [
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ],
    value,
  )
}
