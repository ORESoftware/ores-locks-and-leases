import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/os
import gleam/result
import gleeunit
import gleeunit/should
import ores_locks_and_leases as locks
import ores_locks_and_leases/fence
import simplifile

pub fn main() {
  gleeunit.main()
}

type Input {
  Input(
    tenant_scope: String,
    resource_key: String,
    fencing_token: String,
    operation_id: String,
    payload_sha256: String,
    holder: Option(String),
    lease_id: Option(String),
  )
}

type TokenExpected {
  TokenExpected(ok: Bool, canonical: Option(String), error: Option(String))
}

type TokenCase {
  TokenCase(name: String, value: String, expected: TokenExpected)
}

type RequestExpected {
  RequestExpected(ok: Bool, error: Option(String))
}

type RequestCase {
  RequestCase(name: String, incoming: Input, expected: RequestExpected)
}

type DecisionExpected {
  DecisionExpected(
    kind: String,
    should_apply: Bool,
    incoming_token: String,
    current_token: String,
    previous_token: Option(String),
  )
}

type DecisionCase {
  DecisionCase(
    name: String,
    current: Option(Input),
    incoming: Input,
    expected: Option(DecisionExpected),
    expected_error: Option(String),
  )
}

type Corpus {
  Corpus(
    schema: String,
    generator: String,
    seed: String,
    token_cases: List(TokenCase),
    request_cases: List(RequestCase),
    decision_cases: List(DecisionCase),
  )
}

fn option_string() -> decode.Decoder(Option(String)) {
  decode.optional(decode.string)
}

fn input_decoder() -> decode.Decoder(Input) {
  use tenant_scope <- decode.field("tenantScope", decode.string)
  use resource_key <- decode.field("resourceKey", decode.string)
  use fencing_token <- decode.field("fencingToken", decode.string)
  use operation_id <- decode.field("operationId", decode.string)
  use payload_sha256 <- decode.field("payloadSha256", decode.string)
  use holder <- decode.optional_field("holder", None, option_string())
  use lease_id <- decode.optional_field("leaseId", None, option_string())
  decode.success(Input(
    tenant_scope: tenant_scope,
    resource_key: resource_key,
    fencing_token: fencing_token,
    operation_id: operation_id,
    payload_sha256: payload_sha256,
    holder: holder,
    lease_id: lease_id,
  ))
}

fn token_expected_decoder() -> decode.Decoder(TokenExpected) {
  use ok <- decode.field("ok", decode.bool)
  use canonical <- decode.optional_field("canonical", None, option_string())
  use error <- decode.optional_field("error", None, option_string())
  decode.success(TokenExpected(ok: ok, canonical: canonical, error: error))
}

fn token_case_decoder() -> decode.Decoder(TokenCase) {
  use name <- decode.field("name", decode.string)
  use value <- decode.field("value", decode.string)
  use expected <- decode.field("expected", token_expected_decoder())
  decode.success(TokenCase(name: name, value: value, expected: expected))
}

fn request_expected_decoder() -> decode.Decoder(RequestExpected) {
  use ok <- decode.field("ok", decode.bool)
  use error <- decode.optional_field("error", None, option_string())
  decode.success(RequestExpected(ok: ok, error: error))
}

fn request_case_decoder() -> decode.Decoder(RequestCase) {
  use name <- decode.field("name", decode.string)
  use incoming <- decode.field("incoming", input_decoder())
  use expected <- decode.field("expected", request_expected_decoder())
  decode.success(RequestCase(name: name, incoming: incoming, expected: expected))
}

fn decision_expected_decoder() -> decode.Decoder(DecisionExpected) {
  use kind <- decode.field("kind", decode.string)
  use should_apply <- decode.field("shouldApply", decode.bool)
  use incoming_token <- decode.field("incomingToken", decode.string)
  use current_token <- decode.field("currentToken", decode.string)
  use previous_token <- decode.field("previousToken", option_string())
  decode.success(DecisionExpected(
    kind: kind,
    should_apply: should_apply,
    incoming_token: incoming_token,
    current_token: current_token,
    previous_token: previous_token,
  ))
}

fn decision_case_decoder() -> decode.Decoder(DecisionCase) {
  use name <- decode.field("name", decode.string)
  use current <- decode.field("current", decode.optional(input_decoder()))
  use incoming <- decode.field("incoming", input_decoder())
  use expected <- decode.optional_field(
    "expected",
    None,
    decode.optional(decision_expected_decoder()),
  )
  use expected_error <- decode.optional_field(
    "expectedError",
    None,
    option_string(),
  )
  decode.success(DecisionCase(
    name: name,
    current: current,
    incoming: incoming,
    expected: expected,
    expected_error: expected_error,
  ))
}

fn corpus_decoder() -> decode.Decoder(Corpus) {
  use schema <- decode.field("schema", decode.string)
  use generator <- decode.field("generator", decode.string)
  use seed <- decode.field("seed", decode.string)
  use token_cases <- decode.field("tokenCases", decode.list(token_case_decoder()))
  use request_cases <- decode.field(
    "requestCases",
    decode.list(request_case_decoder()),
  )
  use decision_cases <- decode.field(
    "decisionCases",
    decode.list(decision_case_decoder()),
  )
  decode.success(Corpus(
    schema: schema,
    generator: generator,
    seed: seed,
    token_cases: token_cases,
    request_cases: request_cases,
    decision_cases: decision_cases,
  ))
}

fn corpus() -> Corpus {
  let path =
    os.get_env("ORES_FENCE_ADVERSARIAL_CORPUS")
    |> result.unwrap("../../conformance/cases/fence-adversarial.json")
  let assert Ok(text) = simplifile.read(path)
  let assert Ok(value) = json.parse(text, corpus_decoder())
  value
}

fn request(input: Input) -> Result(fence.FencedWriteRequest, String) {
  case locks.lock_key(input.resource_key) {
    Error(_) -> Error("invalid_type")
    Ok(key) ->
      case fence.fencing_token_text(input.fencing_token) {
        Error(error) -> Error(fence.fence_validation_error_code(error))
        Ok(token) ->
          case
            fence.new_fenced_write_request(
              input.tenant_scope,
              key,
              token,
              input.operation_id,
              input.payload_sha256,
              input.holder,
              input.lease_id,
            )
          {
            Ok(value) -> Ok(value)
            Error(error) -> Error(fence.fence_validation_error_code(error))
          }
      }
  }
}

pub fn adversarial_corpus_identity_test() {
  let value = corpus()
  value.schema |> should.equal("ores.locks.fence-adversarial/v1")
  value.generator |> should.equal("splitmix64-v1")
  value.seed |> should.equal("0x4f5245534c4f434b")
}

pub fn adversarial_token_classification_test() {
  list.each(corpus().token_cases, fn(test_case) {
    case fence.fencing_token_text(test_case.value), test_case.expected {
      Ok(token), TokenExpected(True, Some(canonical), _) ->
        fence.fencing_token_to_string(token) |> should.equal(canonical)
      Error(error), TokenExpected(False, _, Some(expected_error)) ->
        fence.fence_validation_error_code(error)
        |> should.equal(expected_error)
      _, _ -> panic as "token classification mismatch: " <> test_case.name
    }
  })
}

pub fn adversarial_request_classification_test() {
  list.each(corpus().request_cases, fn(test_case) {
    case request(test_case.incoming), test_case.expected {
      Ok(_), RequestExpected(True, _) -> Nil
      Error(code), RequestExpected(False, Some(expected_error)) ->
        code |> should.equal(expected_error)
      _, _ -> panic as "request classification mismatch: " <> test_case.name
    }
  })
}

pub fn adversarial_decision_classification_test() {
  list.each(corpus().decision_cases, fn(test_case) {
    let assert Ok(incoming) = request(test_case.incoming)
    let current = case test_case.current {
      None -> None
      Some(value) -> {
        let assert Ok(current_request) = request(value)
        Some(fence.watermark_from_request(current_request))
      }
    }
    case fence.evaluate_fence(current, incoming), test_case.expected,
      test_case.expected_error
    {
      Error(error), None, Some(expected_error) ->
        fence.fence_validation_error_code(error)
        |> should.equal(expected_error)
      Ok(decision), Some(expected), None -> {
        fence.fence_decision_kind_to_string(decision.kind)
        |> should.equal(expected.kind)
        decision.should_apply |> should.equal(expected.should_apply)
        fence.fencing_token_to_string(decision.incoming_token)
        |> should.equal(expected.incoming_token)
        fence.fencing_token_to_string(decision.current_token)
        |> should.equal(expected.current_token)
        option.map(decision.previous_token, fence.fencing_token_to_string)
        |> should.equal(expected.previous_token)
      }
      _, _, _ -> panic as "decision classification mismatch: " <> test_case.name
    }
  })
}
