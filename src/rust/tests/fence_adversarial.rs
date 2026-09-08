//! Deterministic adversarial cross-runtime fencing corpus.

use std::path::PathBuf;

use ores_locks_and_leases::{
    FenceWatermark, FencedWriteRequest, FencingTokenText, LockKey, evaluate_fence,
};
use serde_json::Value;

fn corpus() -> Value {
    let path = std::env::var_os("ORES_FENCE_ADVERSARIAL_CORPUS")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../conformance/cases/fence-adversarial.json")
        });
    serde_json::from_str(&std::fs::read_to_string(path).expect("read adversarial corpus"))
        .expect("parse adversarial corpus")
}

fn request(value: &Value) -> Result<FencedWriteRequest, String> {
    let key = LockKey::new(
        value["resourceKey"]
            .as_str()
            .ok_or_else(|| "invalid_type".to_owned())?,
    )
    .map_err(|_| "invalid_type".to_owned())?;
    let token = FencingTokenText::parse(
        value["fencingToken"]
            .as_str()
            .ok_or_else(|| "invalid_fencing_token".to_owned())?,
    )
    .map_err(|error| error.code().to_owned())?;
    FencedWriteRequest::new(
        value["tenantScope"]
            .as_str()
            .ok_or_else(|| "invalid_type".to_owned())?,
        key,
        token,
        value["operationId"]
            .as_str()
            .ok_or_else(|| "invalid_type".to_owned())?,
        value["payloadSha256"]
            .as_str()
            .ok_or_else(|| "invalid_payload_sha256".to_owned())?,
        value.get("holder").and_then(Value::as_str).map(str::to_owned),
        value.get("leaseId").and_then(Value::as_str).map(str::to_owned),
    )
    .map_err(|error| error.code().to_owned())
}

fn watermark(value: &Value) -> Result<FenceWatermark, String> {
    request(value).map(|request| FenceWatermark::from_request(&request))
}

#[test]
fn adversarial_token_classification_matches_the_seeded_corpus() {
    let corpus = corpus();
    assert_eq!(corpus["schema"], "ores.locks.fence-adversarial/v1");
    assert_eq!(corpus["generator"], "splitmix64-v1");
    assert_eq!(corpus["seed"], "0x4f5245534c4f434b");

    for case in corpus["tokenCases"].as_array().expect("token cases") {
        let name = case["name"].as_str().expect("case name");
        let value = case["value"].as_str().expect("token text");
        let expected = &case["expected"];
        match FencingTokenText::parse(value) {
            Ok(token) => {
                assert_eq!(expected["ok"].as_bool(), Some(true), "{name}");
                assert_eq!(
                    token.as_str(),
                    expected["canonical"].as_str().expect("canonical token"),
                    "{name}"
                );
            }
            Err(error) => {
                assert_eq!(expected["ok"].as_bool(), Some(false), "{name}");
                assert_eq!(
                    error.code(),
                    expected["error"].as_str().expect("error code"),
                    "{name}"
                );
            }
        }
    }
}

#[test]
fn adversarial_request_validation_matches_the_seeded_corpus() {
    let corpus = corpus();
    for case in corpus["requestCases"].as_array().expect("request cases") {
        let name = case["name"].as_str().expect("case name");
        let expected = &case["expected"];
        match request(&case["incoming"]) {
            Ok(_) => assert_eq!(expected["ok"].as_bool(), Some(true), "{name}"),
            Err(code) => {
                assert_eq!(expected["ok"].as_bool(), Some(false), "{name}");
                assert_eq!(
                    code,
                    expected["error"].as_str().expect("error code"),
                    "{name}"
                );
            }
        }
    }
}

#[test]
fn adversarial_decisions_match_the_seeded_corpus() {
    let corpus = corpus();
    for case in corpus["decisionCases"].as_array().expect("decision cases") {
        let name = case["name"].as_str().expect("case name");
        let incoming = request(&case["incoming"]).unwrap_or_else(|code| {
            panic!("{name}: incoming request failed validation with {code}")
        });
        let current = if case["current"].is_null() {
            None
        } else {
            Some(watermark(&case["current"]).unwrap_or_else(|code| {
                panic!("{name}: current watermark failed validation with {code}")
            }))
        };

        if let Some(expected_code) = case["expectedError"].as_str() {
            let error = evaluate_fence(current.as_ref(), &incoming)
                .expect_err("expected adversarial validation failure");
            assert_eq!(error.code(), expected_code, "{name}");
            continue;
        }

        let expected = &case["expected"];
        let decision = evaluate_fence(current.as_ref(), &incoming).expect("decision");
        assert_eq!(
            decision.kind.as_str(),
            expected["kind"].as_str().expect("decision kind"),
            "{name}"
        );
        assert_eq!(
            decision.should_apply,
            expected["shouldApply"].as_bool().expect("shouldApply"),
            "{name}"
        );
        assert_eq!(
            decision.incoming_token.as_str(),
            expected["incomingToken"].as_str().expect("incomingToken"),
            "{name}"
        );
        assert_eq!(
            decision.current_token.as_str(),
            expected["currentToken"].as_str().expect("currentToken"),
            "{name}"
        );
        assert_eq!(
            decision.previous_token.as_ref().map(FencingTokenText::as_str),
            expected["previousToken"].as_str(),
            "{name}"
        );
    }
}
