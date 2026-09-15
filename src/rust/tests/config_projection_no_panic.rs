use ores_locks_and_leases::config::{FiduciaProviderConfig, LockProfileConfig, ProviderSelection};

#[test]
fn mutated_fiducia_profile_without_ttl_fails_closed_without_panicking() {
    let profile = LockProfileConfig {
        profile_id: "mutated-service".to_owned(),
        wait: true,
        wait_timeout_ms: 30_000,
        retry_interval_ms: 50,
        ttl_ms: None,
        renew_interval_ms: None,
        providers: ProviderSelection {
            local_file: false,
            fiducia: true,
            pg_advisory: false,
        },
        local_file: None,
        fiducia: Some(FiduciaProviderConfig {
            endpoint_env: "FIDUCIA_BASE_URL".to_owned(),
            auth_token_env: "FIDUCIA_AUTH_TOKEN".to_owned(),
        }),
        postgres: None,
    };

    let caught = std::panic::catch_unwind(|| profile.lease_acquire_options());
    assert!(
        caught.is_ok(),
        "projection must never panic on public-field mutation"
    );
    let error = caught
        .expect("no panic")
        .expect_err("missing Fiducia TTL must fail closed");
    assert_eq!(error.code, "ttl_missing");
    assert_eq!(error.path, "profiles.ttl_ms");
}
