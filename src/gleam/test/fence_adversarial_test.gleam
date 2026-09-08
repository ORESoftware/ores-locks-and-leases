import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleeunit
import gleeunit/should
import ores_locks_and_leases as locks
import ores_locks_and_leases/fence
import simplifile

pub fn main() {
  gleeunit.main()
}

type RequestFixture {
  RequestFixture(
    tenant_scope: String,
    resource_key: String,
    fencing_token: String,
    operation_id: String,
    payload_sha256: String,
    holder: Option(String),
    lease_id: Option(String),
  )
}

type InvalidFieldFixture {
  InvalidFieldFixture(
    name: String,
    field: String,
    value: String,
    expected_error: String,
  )
}

type ExpectedFixture {
  ExpectedFixture(
    kind: String,
    should_apply: Bool,
    incoming_token: String,
    current_token: String,
    previous_token: Option(String),
  )
}

type CaseFixture {
  CaseFixture(
    name: String,
    current: Option(RequestFixture),
    incoming: RequestFixture,
    expected: Option(ExpectedFixture),
    expected_error: Option(String),
  )
}

fn request_decoder() -> decode.Decoder(RequestFixture) {
  use tenant_scope <- decode.field("tenantScope", decode.string)
  use resource_key <- decode.field("resourceKey", decode.string)
  use fencing_token <- decode.field("fencingToken", decode.string)
  use operation_id <- decode.field("operationId", decode.string)
  use payload_sha256 <- decode.field("payloadSha256", decode.string)
  use holder <- decode.optional_field(
    "holder",
    None,
    decode.optional(decode.string),
  )
  use lease_id <- decode.optional_field(
    "leaseId",
    None,
    decode.optional(decode.string),
  )
  decode.success(RequestFixture(
    tenant_scope: tenant_scope,
    resource_key: resource_key,
    fencing_token: fencing_token,
    operation_id: operation_id,
    payload_sha256: payload_sha256,
    holder: holder,
    lease_id: lease_id,
  ))
}

fn expected_decoder() -> decode.Decoder(ExpectedFixture) {
  use kind <- decode.field("kind", decode.string)
  use should_apply <- decode.field("shouldApply", decode.bool)
  use incoming_token <- decode.field("incomingToken", decode.string)
  use current_token <- decode.field("currentToken", decode.string)
  use previous_token <- decode.field(
    "previousToken",
    decode.optional(decode.string),
  )
  decode.success(ExpectedFixture(
    kind: kind,
    should_apply: should_apply,
    incoming_token: incoming_token,
    current_token: current_token,
    previous_token: previous_token,
  ))
}

fn case_decoder() -> decode.Decoder(CaseFixture) {
  use name <- decode.field("name", decode.string)
  use current <- decode.field("current", decode.optional(request_decoder()))
  use incoming <- decode.field("incoming", request_decoder())
  use expected <- decode.optional_field(
    "expected",
    None,
    decode.optional(expected_decoder()),
  )
  use expected_error <- decode.optional_field(
    "expectedError",
    None,
    decode.optional(decode.string),
  )
  decode.success(CaseFixture(
    name: name,
    current: current,
    incoming: incoming,
    expected: expected,
    expected_error: expected_error,
  ))
}

fn invalid_field_decoder() -> decode.Decoder(InvalidFieldFixture) {
  use name <- decode.field("name", decode.string)
  use field <- decode.field("field", decode.string)
  use value <- decode.field("value", decode.string)
  use expected_error <- decode.field("expectedError", decode.string)
  decode.success(InvalidFieldFixture(
    name: name,
    field: field,
    value: value,
    expected_error: expected_error,
  ))
}

fn build_request(value: RequestFixture) -> fence.FencedWriteRequest {
  let assert Ok(key) = locks.lock_key(value.resource_key)
  let assert Ok(token) = fence.fencing_token_text(value.fencing_token)
  let assert Ok(request) =
    fence.new_fenced_write_request(
      value.tenant_scope,
      key,
      token,
      value.operation_id,
      value.payload_sha256,
      value.holder,
      value.lease_id,
    )
  request
}

fn build_watermark(value: RequestFixture) -> fence.FenceWatermark {
  value |> build_request |> fence.watermark_from_request
}

fn invalid_field_code(fixture: InvalidFieldFixture) -> String {
  let tenant = case fixture.field {
    "tenantScope" -> fixture.value
    _ -> "tenant/acme"
  }
  let resource = case fixture.field {
    "resourceKey" -> fixture.value
    _ -> "example/jobs/rebuild"
  }
  let operation = case fixture.field {
    "operationId" -> fixture.value
    _ -> "operation-0001"
  }
  let holder = case fixture.field {
    "holder" -> Some(fixture.value)
    _ -> Some("worker-a")
  }
  let lease_id = case fixture.field {
    "leaseId" -> Some(fixture.value)
    _ -> Some("lease-a")
  }
  case locks.lock_key(resource) {
    Error(_) -> "too_long"
    Ok(key) -> {
      let assert Ok(token) = fence.fencing_token_text("1")
      let assert Error(error) =
        fence.new_fenced_write_request(
          tenant,
          key,
          token,
          operation,
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          holder,
          lease_id,
        )
      fence.fence_validation_error_code(error)
    }
  }
}

pub fn generated_adversarial_corpus_test() {
  let assert Ok(text) =
    simplifile.read("../../conformance/cases/fence-decision.json")
  let decoder = {
    use cases <- decode.field("cases", decode.list(case_decoder()))
    use invalid_tokens <- decode.field(
      "invalidTokens",
      decode.list(decode.string),
    )
    use invalid_fields <- decode.optional_field(
      "invalidFields",
      [],
      decode.list(invalid_field_decoder()),
    )
    decode.success(#(cases, invalid_tokens, invalid_fields))
  }
  let assert Ok(#(cases, invalid_tokens, invalid_fields)) =
    json.parse(text, decoder)

  list.each(cases, fn(fixture) {
    let current = case fixture.current {
      None -> None
      Some(value) -> Some(build_watermark(value))
    }
    let incoming = build_request(fixture.incoming)

    case fixture.expected_error, fixture.expected {
      Some(code), _ -> {
        let assert Error(error) = fence.evaluate_fence(current, incoming)
        fence.fence_validation_error_code(error)
        |> should.equal(code)
      }
      None, Some(expected) -> {
        let assert Ok(decision) = fence.evaluate_fence(current, incoming)
        fence.fence_decision_kind_to_string(decision.kind)
        |> should.equal(expected.kind)
        decision.should_apply |> should.equal(expected.should_apply)
        fence.fencing_token_to_string(decision.incoming_token)
        |> should.equal(expected.incoming_token)
        fence.fencing_token_to_string(decision.current_token)
        |> should.equal(expected.current_token)
        let previous_token = case decision.previous_token {
          None -> None
          Some(token) -> Some(fence.fencing_token_to_string(token))
        }
        previous_token |> should.equal(expected.previous_token)
      }
      _, _ -> panic as "fixture has neither expected decision nor error"
    }
  })

  list.each(invalid_tokens, fn(value) {
    let assert Error(error) = fence.fencing_token_text(value)
    fence.fence_validation_error_code(error)
    |> should.equal("invalid_fencing_token")
  })

  list.each(invalid_fields, fn(fixture) {
    invalid_field_code(fixture)
    |> should.equal(fixture.expected_error)
  })
}
