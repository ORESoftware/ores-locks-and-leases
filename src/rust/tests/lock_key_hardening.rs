use ores_locks_and_leases::{InvalidLockKey, LockKey, lock_key_from_components};
use serde_json::Value;

fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../conformance/cases/lock-key-hardening-adversarial-v1.json"
    ))
    .expect("lock-key hardening corpus")
}

fn materialized_key(case: &Value) -> Option<String> {
    if let Some(key) = case["key"].as_str() {
        return Some(key.to_owned());
    }
    let repeat = case.get("key_repeat")?;
    let value = repeat["value"].as_str()?;
    let count = repeat["count"].as_u64()?;
    Some(value.repeat(count as usize))
}

#[test]
fn lock_key_validation_matches_adversarial_corpus() {
    for case in corpus()["cases"].as_array().expect("cases") {
        let id = case["id"].as_str().expect("id");
        if id == "lifecycle-component-separator-alias" {
            continue;
        }
        let key = materialized_key(case).expect("materialized key");
        let result = LockKey::new(key);
        match case["expected"].as_str().expect("expected") {
            "accept" => assert!(result.is_ok(), "{id}: {result:?}"),
            "reject_empty" => {
                assert!(matches!(result, Err(InvalidLockKey::Empty)), "{id}: {result:?}")
            }
            "reject_whitespace_only" | "reject_ambiguous_whitespace" => assert!(
                matches!(result, Err(InvalidLockKey::SurroundingWhitespace)),
                "{id}: {result:?}"
            ),
            "reject_control_character" => assert!(
                matches!(result, Err(InvalidLockKey::AsciiControl)),
                "{id}: {result:?}"
            ),
            "reject_too_long" => assert!(
                matches!(result, Err(InvalidLockKey::TooLong { .. })),
                "{id}: {result:?}"
            ),
            other => panic!("{id}: unknown expected result {other}"),
        }
    }
}

#[test]
fn lifecycle_component_encoding_matches_corpus() {
    let corpus = corpus();
    let case = corpus["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .find(|case| case["id"] == "lifecycle-component-separator-alias")
        .expect("structured case");
    let components = case["components"]
        .as_array()
        .expect("components")
        .iter()
        .map(|value| value.as_str().expect("component"));
    let key = lock_key_from_components(components).expect("composed key");
    assert_eq!(key.as_str(), case["expected_key"].as_str().expect("expected key"));
}
