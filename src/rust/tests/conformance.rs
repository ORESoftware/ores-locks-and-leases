//! The Rust slice against the shared corpus every language is held to.

use ores_locks_and_leases::{LockLayers, LockStep, PgScope, advisory_key, fnv1a64, plan};
use serde_json::Value;

const ADVISORY_KEY: &str = include_str!("../../../conformance/cases/advisory-key.json");
const LOCK_PLAN: &str = include_str!("../../../conformance/cases/lock-plan.json");

#[test]
fn advisory_key_vectors() {
    let doc: Value = serde_json::from_str(ADVISORY_KEY).unwrap();
    let cases = doc["cases"].as_array().unwrap();
    assert!(cases.len() >= 8);
    for case in cases {
        let key = case["key"].as_str().unwrap();
        let unsigned: u64 = case["fnv1a64_unsigned"].as_str().unwrap().parse().unwrap();
        let signed: i64 = case["advisory_key"].as_str().unwrap().parse().unwrap();
        assert_eq!(fnv1a64(key), unsigned, "fnv1a64({key:?})");
        assert_eq!(advisory_key(key), signed, "advisory_key({key:?})");
    }
}

#[test]
fn lock_plan_matrix() {
    let doc: Value = serde_json::from_str(LOCK_PLAN).unwrap();
    let cases = doc["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 11);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let layers = LockLayers {
            fiducia: case["layers"]["fiducia"].as_bool().unwrap(),
            pg_advisory: case["layers"]["pgAdvisory"].as_bool().unwrap(),
        };
        let scope = PgScope::parse(case["pgScope"].as_str().unwrap()).unwrap();
        let wait = case["wait"].as_bool().unwrap();
        let expected: Vec<LockStep> = case["expect"]["steps"]
            .as_array()
            .unwrap()
            .iter()
            .map(|step| LockStep::parse(step.as_str().unwrap()).unwrap())
            .collect();
        assert_eq!(plan(layers, scope, wait).steps, expected, "case {name}");
    }
}
