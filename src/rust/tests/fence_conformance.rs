use ores_locks_and_leases::{
    FenceAttempt, FenceDecisionKind, FenceWatermark, decide_fence,
};
use serde_json::Value;

const CORPUS: &str = include_str!("../../../conformance/cases/fence-decision.json");

fn watermark(value: &Value) -> FenceWatermark {
    FenceWatermark::from_decimal(
        value["fencingToken"].as_str().unwrap(),
        value["operationId"].as_str().unwrap(),
        value["payloadSha256"].as_str().unwrap(),
    )
    .unwrap()
}

fn attempt(value: &Value) -> FenceAttempt {
    FenceAttempt::from_decimal(
        value["fencingToken"].as_str().unwrap(),
        value["operationId"].as_str().unwrap(),
        value["payloadSha256"].as_str().unwrap(),
    )
    .unwrap()
}

#[test]
fn shared_decision_corpus() {
    let doc: Value = serde_json::from_str(CORPUS).unwrap();
    for case in doc["cases"].as_array().unwrap() {
        let current = (!case["current"].is_null()).then(|| watermark(&case["current"]));
        let result = decide_fence(current.as_ref(), &attempt(&case["incoming"])).unwrap();
        let expected = &case["expect"];
        assert_eq!(
            result.kind,
            FenceDecisionKind::parse(expected["kind"].as_str().unwrap()).unwrap(),
            "{}",
            case["name"]
        );
        assert_eq!(result.apply, expected["apply"].as_bool().unwrap());
        assert_eq!(result.watermark, watermark(&expected["watermark"]));
    }
}

#[test]
fn invalid_boundary_values_fail_closed() {
    let doc: Value = serde_json::from_str(CORPUS).unwrap();
    for case in doc["invalid"].as_array().unwrap() {
        let incoming = &case["incoming"];
        let error = FenceAttempt::from_decimal(
            incoming["fencingToken"].as_str().unwrap(),
            incoming["operationId"].as_str().unwrap(),
            incoming["payloadSha256"].as_str().unwrap(),
        )
        .unwrap_err();
        assert_eq!(error.field, case["field"].as_str().unwrap());
    }
}
