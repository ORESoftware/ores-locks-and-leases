//! Cross-runtime fencing decision conformance.

use std::path::PathBuf;

use ores_locks_and_leases::{
    FenceWatermark, FencedWriteRequest, FencingTokenText, LockKey, evaluate_fence,
};
use serde_json::Value;

fn corpus() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../conformance/cases/fence-decision.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn request(value: &Value) -> FencedWriteRequest {
    FencedWriteRequest::new(
        value["tenantScope"].as_str().unwrap(),
        LockKey::new(value["resourceKey"].as_str().unwrap()).unwrap(),
        FencingTokenText::parse(value["fencingToken"].as_str().unwrap()).unwrap(),
        value["operationId"].as_str().unwrap(),
        value["payloadSha256"].as_str().unwrap(),
        value["holder"].as_str().map(str::to_owned),
        value["leaseId"].as_str().map(str::to_owned),
    )
    .unwrap()
}

fn watermark(value: &Value) -> FenceWatermark {
    let request = request(value);
    FenceWatermark::from_request(&request)
}

#[test]
fn fence_decisions_match_the_shared_corpus() {
    let corpus = corpus();
    for case in corpus["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let incoming = request(&case["incoming"]);
        let current = case["current"]
            .as_object()
            .map(|_| watermark(&case["current"]));

        match case["expectedError"].as_str() {
            Some(expected_code) => {
                let error = evaluate_fence(current.as_ref(), &incoming).unwrap_err();
                assert_eq!(error.code(), expected_code, "{name}");
            }
            None => {
                let expected = &case["expected"];
                let decision = evaluate_fence(current.as_ref(), &incoming).unwrap();
                assert_eq!(
                    decision.kind.as_str(),
                    expected["kind"].as_str().unwrap(),
                    "{name}"
                );
                assert_eq!(
                    decision.should_apply,
                    expected["shouldApply"].as_bool().unwrap(),
                    "{name}"
                );
                assert_eq!(
                    decision.incoming_token.as_str(),
                    expected["incomingToken"].as_str().unwrap(),
                    "{name}"
                );
                assert_eq!(
                    decision.current_token.as_str(),
                    expected["currentToken"].as_str().unwrap(),
                    "{name}"
                );
                assert_eq!(
                    decision
                        .previous_token
                        .as_ref()
                        .map(FencingTokenText::as_str),
                    expected["previousToken"].as_str(),
                    "{name}"
                );
            }
        }
    }
}

#[test]
fn invalid_token_cases_fail_closed() {
    let corpus = corpus();
    for value in corpus["invalidTokens"].as_array().unwrap() {
        let token = value.as_str().unwrap();
        assert!(
            FencingTokenText::parse(token).is_err(),
            "invalid token unexpectedly accepted: {token:?}"
        );
    }
}
