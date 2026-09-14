#![cfg(feature = "config")]

use ores_locks_and_leases::OresLockConfigV1;

const LOCAL_EXAMPLE: &str = include_str!(
    "../../../contracts/lock-config/examples/local-install.ores-lock.toml"
);
const SERVICE_EXAMPLE: &str = include_str!(
    "../../../contracts/lock-config/examples/service-composed.ores-lock.toml"
);
const ROOT_CONFIG: &str = include_str!("../../../.ores-lock.toml");
const ZPKG: &str = include_str!("../../../.zpkg.toml");

#[test]
fn canonical_examples_are_runtime_admissible() {
    let local = OresLockConfigV1::from_toml_str(LOCAL_EXAMPLE).expect("local example must admit");
    assert_eq!(
        local.select_profile(None).expect("local default").profile_id,
        "local-install"
    );

    let service =
        OresLockConfigV1::from_toml_str(SERVICE_EXAMPLE).expect("service example must admit");
    assert_eq!(
        service
            .select_profile(None)
            .expect("service default")
            .profile_id,
        "service-composed"
    );
}

#[test]
fn zpkg_does_not_absorb_operational_lock_policy() {
    for key in [
        "wait_timeout_ms",
        "retry_interval_ms",
        "ttl_ms",
        "renew_interval_ms",
        "FIDUCIA_BASE_URL",
        "FIDUCIA_AUTH_TOKEN",
        "DATABASE_URL",
        "ORES_LOCK_ROOT",
    ] {
        assert!(
            !ZPKG.contains(key),
            ".zpkg.toml must not own runtime lock setting {key}"
        );
    }
}

#[test]
fn checked_in_lock_configs_do_not_embed_connection_or_auth_secrets() {
    for (name, source) in [
        ("root", ROOT_CONFIG),
        ("local", LOCAL_EXAMPLE),
        ("service", SERVICE_EXAMPLE),
    ] {
        for forbidden in [
            "postgres://",
            "postgresql://",
            "Bearer ",
            "auth_token =",
            "database_url =",
        ] {
            assert!(
                !source.contains(forbidden),
                "{name} lock config must not contain secret literal shape {forbidden:?}"
            );
        }
    }
}
