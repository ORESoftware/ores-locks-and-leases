#![cfg(feature = "config")]

use ores_locks_and_leases::{
    EnvBinding, EnvKind, LOCK_CONFIG_SCHEMA_V1, LocalFileProviderConfig, LockProfileConfig,
    MAX_RETRY_INTERVAL_MS, MAX_WAIT_TIMEOUT_MS, OresLockConfigV1, ProviderSelection,
};

fn local_config() -> OresLockConfigV1 {
    OresLockConfigV1 {
        schema_version: LOCK_CONFIG_SCHEMA_V1.to_owned(),
        default_profile: "local".to_owned(),
        selected_profile_env: None,
        env: vec![EnvBinding {
            key: "ORES_LOCK_ROOT".to_owned(),
            kind: EnvKind::Path,
            required: false,
            secret: false,
            purpose: "Local lock rendezvous root.".to_owned(),
        }],
        profiles: vec![LockProfileConfig {
            profile_id: "local".to_owned(),
            wait: true,
            wait_timeout_ms: 30_000,
            retry_interval_ms: 50,
            ttl_ms: None,
            renew_interval_ms: None,
            providers: ProviderSelection {
                local_file: true,
                fiducia: false,
                pg_advisory: false,
            },
            outer_authority: None,
            local_file: Some(LocalFileProviderConfig {
                root_env: "ORES_LOCK_ROOT".to_owned(),
                require_existing_root: false,
            }),
            fiducia: None,
            cloudflare_durable_object: None,
            redis: None,
            postgres: None,
        }],
    }
}

fn set_env_key(config: &mut OresLockConfigV1, key: String) {
    config.env[0].key = key.clone();
    config.profiles[0]
        .local_file
        .as_mut()
        .expect("local provider")
        .root_env = key;
}

fn set_profile_id(config: &mut OresLockConfigV1, profile_id: String) {
    config.default_profile = profile_id.clone();
    config.profiles[0].profile_id = profile_id;
}

#[test]
fn accepts_env_key_at_128_byte_boundary() {
    let mut config = local_config();
    set_env_key(&mut config, format!("A{}", "B".repeat(127)));
    config
        .validate()
        .expect("128-byte env key must be admitted");
}

#[test]
fn rejects_env_key_above_128_byte_boundary() {
    let mut config = local_config();
    set_env_key(&mut config, format!("A{}", "B".repeat(128)));
    assert_eq!(config.validate().unwrap_err().code, "env_key");
}

#[test]
fn rejects_lowercase_env_key_drift() {
    let mut config = local_config();
    set_env_key(&mut config, "ores_lock_root".to_owned());
    assert_eq!(config.validate().unwrap_err().code, "env_key");
}

#[test]
fn rejects_empty_env_purpose() {
    let mut config = local_config();
    config.env[0].purpose.clear();
    assert_eq!(config.validate().unwrap_err().code, "env_purpose");
}

#[test]
fn accepts_env_purpose_at_255_byte_boundary() {
    let mut config = local_config();
    config.env[0].purpose = "p".repeat(255);
    config
        .validate()
        .expect("255-byte env purpose must be admitted");
}

#[test]
fn rejects_env_purpose_above_255_byte_boundary() {
    let mut config = local_config();
    config.env[0].purpose = "p".repeat(256);
    assert_eq!(config.validate().unwrap_err().code, "env_purpose");
}

#[test]
fn accepts_profile_id_at_128_byte_boundary() {
    let mut config = local_config();
    set_profile_id(&mut config, "a".repeat(128));
    config
        .validate()
        .expect("128-byte profile id must be admitted");
}

#[test]
fn rejects_profile_id_above_128_byte_boundary() {
    let mut config = local_config();
    set_profile_id(&mut config, "a".repeat(129));
    assert_eq!(config.validate().unwrap_err().code, "profile_id");
}

#[test]
fn rejects_profile_id_with_leading_separator() {
    let mut config = local_config();
    set_profile_id(&mut config, "-local".to_owned());
    assert_eq!(config.validate().unwrap_err().code, "profile_id");
}

#[test]
fn rejects_profile_id_with_trailing_separator() {
    let mut config = local_config();
    set_profile_id(&mut config, "local_".to_owned());
    assert_eq!(config.validate().unwrap_err().code, "profile_id");
}

#[test]
fn accepts_wait_timeout_at_portable_maximum() {
    let mut config = local_config();
    config.profiles[0].wait_timeout_ms = MAX_WAIT_TIMEOUT_MS;
    config
        .validate()
        .expect("portable maximum wait timeout must be admitted");
}

#[test]
fn rejects_wait_timeout_above_portable_maximum() {
    let mut config = local_config();
    config.profiles[0].wait_timeout_ms = MAX_WAIT_TIMEOUT_MS + 1;
    assert_eq!(config.validate().unwrap_err().code, "wait_timeout");
}

#[test]
fn accepts_retry_interval_at_portable_maximum() {
    let mut config = local_config();
    config.profiles[0].wait_timeout_ms = MAX_WAIT_TIMEOUT_MS;
    config.profiles[0].retry_interval_ms = MAX_RETRY_INTERVAL_MS;
    config
        .validate()
        .expect("portable maximum retry interval must be admitted");
}

#[test]
fn rejects_retry_interval_above_portable_maximum() {
    let mut config = local_config();
    config.profiles[0].retry_interval_ms = MAX_RETRY_INTERVAL_MS + 1;
    assert_eq!(config.validate().unwrap_err().code, "retry_interval");
}

#[test]
fn whitespace_only_profile_selector_fails_closed() {
    let config = local_config();
    let error = config
        .select_profile(Some(" \t "))
        .expect_err("whitespace is data, not an implicit request for the default profile");
    assert_eq!(error.code, "selected_profile");
    assert_eq!(error.path, "selected_profile_env");
}
