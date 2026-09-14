#![cfg(feature = "config")]

use ores_locks_and_leases::OresLockConfigV1;

const CONFIG: &str = include_str!("../../../.ores-lock.toml");

fn parse(source: &str) -> OresLockConfigV1 {
    OresLockConfigV1::from_toml_str(source).expect("fixture must be admitted")
}

#[test]
fn selects_default_profile_without_resolved_override() {
    let config = parse(CONFIG);
    let profile = config.select_profile(None).expect("default profile must exist");
    assert_eq!(profile.profile_id, "local-install");
    assert!(profile.providers.local_file);
    assert!(!profile.providers.fiducia);
    assert!(!profile.providers.pg_advisory);
}

#[test]
fn selects_explicit_declared_profile() {
    let config = parse(CONFIG);
    let profile = config
        .select_profile(Some("service-composed"))
        .expect("explicit profile must exist");
    assert_eq!(profile.profile_id, "service-composed");
    assert!(!profile.providers.local_file);
    assert!(profile.providers.fiducia);
    assert!(profile.providers.pg_advisory);
}

#[test]
fn rejects_unknown_default_profile() {
    let source = CONFIG.replace(
        "default_profile = \"local-install\"",
        "default_profile = \"missing-profile\"",
    );
    let error = OresLockConfigV1::from_toml_str(&source).expect_err("unknown default must fail");
    assert_eq!(error.code, "default_profile");
}

#[test]
fn rejects_profile_with_no_enabled_provider() {
    let source = CONFIG.replacen(
        "local_file = true\nfiducia = false\npg_advisory = false",
        "local_file = false\nfiducia = false\npg_advisory = false",
        1,
    );
    let error = OresLockConfigV1::from_toml_str(&source).expect_err("providerless profile must fail");
    assert_eq!(error.code, "provider_selection");
}

#[test]
fn rejects_dormant_local_provider_table() {
    let source = CONFIG.replacen(
        "local_file = true\nfiducia = false\npg_advisory = false",
        "local_file = false\nfiducia = false\npg_advisory = true",
        1,
    );
    let error = OresLockConfigV1::from_toml_str(&source).expect_err("dormant local table must fail");
    assert_eq!(error.code, "local_file_dormant");
}

#[test]
fn rejects_secret_profile_selector_binding() {
    let source = CONFIG.replace(
        "selected_profile_env = \"ORES_LOCK_PROFILE\"",
        "selected_profile_env = \"FIDUCIA_AUTH_TOKEN\"",
    );
    let error = OresLockConfigV1::from_toml_str(&source).expect_err("secret selector must fail");
    assert_eq!(error.code, "env_reference_policy");
}

#[test]
fn rejects_renewal_interval_above_half_ttl() {
    let source = CONFIG.replace("renew_interval_ms = 10000", "renew_interval_ms = 20000");
    let error = OresLockConfigV1::from_toml_str(&source).expect_err("unsafe renewal cadence must fail");
    assert_eq!(error.code, "renew_interval");
}

#[test]
fn rejects_unknown_toml_fields() {
    let source = CONFIG.replace(
        "schema_version = \"ores.lock.config.v1\"",
        "schema_version = \"ores.lock.config.v1\"\nundeclared_setting = true",
    );
    let error = OresLockConfigV1::from_toml_str(&source).expect_err("unknown fields must fail closed");
    assert_eq!(error.code, "invalid_toml");
}
