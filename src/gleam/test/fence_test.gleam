import gleam/list
import gleam/option
import gleeunit
import gleeunit/should
import ores_locks_and_leases as locks
import ores_locks_and_leases/fence

pub fn main() {
  gleeunit.main()
}

fn request(
  tenant: String,
  token_text: String,
  operation_id: String,
  payload_sha256: String,
) -> fence.FencedWriteRequest {
  let assert Ok(key) = locks.lock_key("example/jobs/rebuild")
  let assert Ok(token) = fence.fencing_token_text(token_text)
  let assert Ok(request) =
    fence.new_fenced_write_request(
      tenant,
      key,
      token,
      operation_id,
      payload_sha256,
      option.None,
      option.None,
    )
  request
}

pub fn fencing_token_preserves_full_unsigned_64_range_test() {
  let assert Ok(token) = fence.fencing_token_text("18446744073709551615")
  fence.fencing_token_to_string(token)
  |> should.equal("18446744073709551615")
  fence.fencing_token_value(token)
  |> should.equal(18_446_744_073_709_551_615)
}

pub fn invalid_tokens_fail_closed_test() {
  list.each(
    [
      "",
      "00",
      "01",
      "+1",
      "-1",
      "1.0",
      " 1",
      "18446744073709551616",
    ],
    fn(value) {
      let assert Error(error) = fence.fencing_token_text(value)
      fence.fence_validation_error_code(error)
      |> should.equal("invalid_fencing_token")
    },
  )
}

pub fn decision_matrix_matches_shared_corpus_test() {
  let digest_a =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  let digest_b =
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

  let first = request("tenant/acme", "41", "op-41", digest_a)
  let current = fence.watermark_from_request(first)

  let assert Ok(advanced) =
    fence.evaluate_fence(
      option.Some(current),
      request("tenant/acme", "42", "op-42", digest_b),
    )
  fence.fence_decision_kind_to_string(advanced.kind)
  |> should.equal("advanced")
  advanced.should_apply |> should.be_true

  let current =
    fence.watermark_from_request(request("tenant/acme", "42", "op-42", digest_b))
  let assert Ok(replay) =
    fence.evaluate_fence(
      option.Some(current),
      request("tenant/acme", "42", "op-42", digest_b),
    )
  fence.fence_decision_kind_to_string(replay.kind)
  |> should.equal("replay")
  replay.should_apply |> should.be_false

  let assert Ok(reused) =
    fence.evaluate_fence(
      option.Some(current),
      request("tenant/acme", "42", "op-other", digest_b),
    )
  fence.fence_decision_kind_to_string(reused.kind)
  |> should.equal("token_reuse")

  let assert Ok(stale) =
    fence.evaluate_fence(
      option.Some(current),
      request("tenant/acme", "41", "op-late", digest_a),
    )
  fence.fence_decision_kind_to_string(stale.kind)
  |> should.equal("stale")
}

pub fn identity_mismatch_fails_validation_test() {
  let current =
    fence.watermark_from_request(request(
      "tenant/other",
      "42",
      "op-42",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ))
  let incoming =
    request(
      "tenant/acme",
      "43",
      "op-43",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    )
  let assert Error(error) = fence.evaluate_fence(option.Some(current), incoming)
  fence.fence_validation_error_code(error)
  |> should.equal("identity_mismatch")
}
