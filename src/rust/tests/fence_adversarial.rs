//! Deterministic field-boundary adversaries from the shared fencing corpus.

use std::path::PathBuf;

use ores_locks_and_leases::{FencedWriteRequest, FencingTokenText, LockKey};
use serde_json::Value;

fn corpus() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../conformance/cases/fence-decision.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn classify_field(field: &str, value: &str) -> &'static str {
    let tenant = if field == "tenantScope" {
        value
    } else {
        "tenant/acme"
    };
    let resource = if field == "resourceKey" {
        value
    } else {
        "example/jobs/rebuild"
    };
    let operation = if field == "operationId" {
        value
    } else {
        "operation-0001"
    };
    let holder = if field == "holder" {
        Some(value.to_owned())
    } else {
        Some("worker-a".to_owned())
    };
    let lease_id = if field == "leaseId" {
        Some(value.to_owned())
    } else {
        Some("lease-a".to_owned())
    };

    let key = match LockKey::new(resource) {
        Ok(key) => key,
        Err(_) => return "too_long",
    };
    FencedWriteRequest::new(
        tenant,
        key,
        FencingTokenText::parse("1").unwrap(),
        operation,
        "a".repeat(64),
        holder,
        lease_id,
    )
    .unwrap_err()
    .code()
}

#[test]
fn generated_utf8_field_adversaries_fail_with_recorded_codes() {
    let corpus = corpus();
    let Some(invalid_fields) = corpus["invalidFields"].as_array() else {
        return;
    };
    assert_eq!(
        corpus["generatedCaseCount"].as_u64().unwrap() as usize,
        corpus["cases"].as_array().unwrap().len()
    );
    assert!(corpus["cases"].as_array().unwrap().len() >= 128);

    for fixture in invalid_fields {
        let name = fixture["name"].as_str().unwrap();
        let field = fixture["field"].as_str().unwrap();
        let value = fixture["value"].as_str().unwrap();
        let expected = fixture["expectedError"].as_str().unwrap();
        assert_eq!(classify_field(field, value), expected, "{name}");
    }
}

#[test]
fn every_recorded_boundary_round_trips_without_narrowing() {
    let corpus = corpus();
    let fallback = serde_json::json!([
        "0",
        "9007199254740991",
        "9007199254740992",
        "9007199254740993",
        "9223372036854775807",
        "9223372036854775808",
        "18446744073709551615"
    ]);
    let boundaries = corpus["tokenBoundaries"]
        .as_array()
        .or_else(|| fallback.as_array())
        .unwrap();
    for value in boundaries {
        let value = value.as_str().unwrap();
        let token = FencingTokenText::parse(value).unwrap();
        assert_eq!(token.as_str(), value);
    }
}
