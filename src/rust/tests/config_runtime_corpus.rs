#![cfg(feature = "config")]

use ores_locks_and_leases::OresLockConfigV1;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Corpus {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Case {
    id: String,
    accept: bool,
    #[serde(default)]
    selected_profile: Option<String>,
    #[serde(default)]
    expected_profile: Option<String>,
    #[serde(default)]
    expected_error: Option<String>,
    toml: String,
}

#[test]
fn runtime_admission_matches_portable_lock_config_corpus() {
    let corpus: Corpus = serde_json::from_str(include_str!(
        "../../../contracts/lock-config/runtime-cases.json"
    ))
    .expect("runtime corpus must be valid JSON");

    assert_eq!(
        corpus.cases.len(),
        20,
        "keep the full admission corpus intact"
    );

    for case in corpus.cases {
        match OresLockConfigV1::from_toml_str(&case.toml) {
            Ok(config) => {
                assert!(case.accept, "{} unexpectedly admitted", case.id);
                let profile = config
                    .select_profile(case.selected_profile.as_deref())
                    .unwrap_or_else(|error| panic!("{} selection failed: {error}", case.id));
                assert_eq!(
                    Some(profile.profile_id.as_str()),
                    case.expected_profile.as_deref(),
                    "{} selected the wrong profile",
                    case.id
                );
            }
            Err(error) => {
                assert!(!case.accept, "{} unexpectedly rejected: {error}", case.id);
                assert_eq!(
                    Some(error.code),
                    case.expected_error.as_deref(),
                    "{} rejected with the wrong policy code",
                    case.id
                );
            }
        }
    }
}
