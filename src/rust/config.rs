//! Typed runtime loader for `.ores-lock.toml`.
//!
//! TypeSpec and authored JSON Schema remain the cross-runtime peer authorities.
//! This module is the Rust runtime projection: it parses TOML, applies the
//! cross-field invariants that schemas cannot express portably, and converts a
//! selected profile into the existing lock-plan/options types without reading
//! secrets or process environment itself.

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt;
use std::time::Duration;

use serde::Deserialize;

use crate::{AcquireOptions, LocalFileLockOptions, LockLayers, PgScope};

pub const LOCK_CONFIG_SCHEMA_V1: &str = "ores.lock.config.v1";
pub const MAX_CONFIG_ENVS: usize = 128;
pub const MAX_CONFIG_PROFILES: usize = 64;
pub const MAX_WAIT_TIMEOUT_MS: u64 = 86_400_000;
pub const MAX_RETRY_INTERVAL_MS: u64 = 60_000;
pub const MAX_TTL_MS: u64 = 86_400_000;
pub const MAX_RENEW_INTERVAL_MS: u64 = 43_200_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvKind {
    String,
    Boolean,
    Integer,
    Double,
    Url,
    Path,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OuterLeaseAuthority {
    Fiducia,
    CloudflareDurableObject,
    #[serde(rename = "beamscale_critical_section")]
    BeamScaleCriticalSection,
    Redis,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnvBinding {
    pub key: String,
    pub kind: EnvKind,
    pub required: bool,
    pub secret: bool,
    pub purpose: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderSelection {
    pub local_file: bool,
    /// Historical v1 name for the managed outer lease layer. The concrete
    /// backend is selected by `LockProfileConfig::outer_authority`.
    pub fiducia: bool,
    pub pg_advisory: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalFileProviderConfig {
    pub root_env: String,
    pub require_existing_root: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FiduciaProviderConfig {
    pub endpoint_env: String,
    pub auth_token_env: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CloudflareDurableObjectProviderConfig {
    pub endpoint_env: String,
    pub api_token_env: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BeamScaleCriticalSectionProviderConfig {
    pub endpoint_env: String,
    pub api_token_env: String,
    pub deployment_id_env: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RedisProviderConfig {
    pub endpoint_env: String,
    pub auth_token_env: String,
    pub namespace: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PostgresLockScope {
    Transaction,
    Session,
}

impl From<PostgresLockScope> for PgScope {
    fn from(value: PostgresLockScope) -> Self {
        match value {
            PostgresLockScope::Transaction => Self::Transaction,
            PostgresLockScope::Session => Self::Session,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PostgresProviderConfig {
    pub database_url_env: String,
    pub scope: PostgresLockScope,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LockProfileConfig {
    pub profile_id: String,
    pub wait: bool,
    pub wait_timeout_ms: u64,
    pub retry_interval_ms: u64,
    pub ttl_ms: Option<u64>,
    pub renew_interval_ms: Option<u64>,
    pub providers: ProviderSelection,
    pub outer_authority: Option<OuterLeaseAuthority>,
    pub local_file: Option<LocalFileProviderConfig>,
    pub fiducia: Option<FiduciaProviderConfig>,
    pub cloudflare_durable_object: Option<CloudflareDurableObjectProviderConfig>,
    pub beamscale_critical_section: Option<BeamScaleCriticalSectionProviderConfig>,
    pub redis: Option<RedisProviderConfig>,
    pub postgres: Option<PostgresProviderConfig>,
}

impl LockProfileConfig {
    #[must_use]
    pub const fn layers(&self) -> LockLayers {
        LockLayers {
            // v1 wire/config compatibility: `fiducia=true` means the managed
            // outer lease layer is enabled, even when its concrete backend is
            // Cloudflare Durable Objects, BeamScale critical sections, or Redis.
            fiducia: self.providers.fiducia,
            pg_advisory: self.providers.pg_advisory,
        }
    }

    #[must_use]
    pub fn outer_authority(&self) -> Option<OuterLeaseAuthority> {
        self.providers
            .fiducia
            .then_some(self.outer_authority.unwrap_or(OuterLeaseAuthority::Fiducia))
    }

    #[must_use]
    pub fn pg_scope(&self) -> Option<PgScope> {
        self.postgres.as_ref().map(|config| config.scope.into())
    }

    #[must_use]
    pub fn local_file_options(&self) -> Option<LocalFileLockOptions> {
        self.providers.local_file.then(|| LocalFileLockOptions {
            wait: self.wait,
            wait_timeout: Duration::from_millis(self.wait_timeout_ms),
            retry_interval: Duration::from_millis(self.retry_interval_ms),
        })
    }

    pub fn lease_acquire_options(&self) -> Result<Option<(AcquireOptions, bool)>, LockConfigError> {
        if !self.providers.fiducia {
            return Ok(None);
        }
        let ttl_ms = self.ttl_ms.ok_or_else(|| {
            LockConfigError::new(
                "ttl_missing",
                "profiles.ttl_ms",
                "enabled managed outer lease requires ttl_ms",
            )
        })?;
        Ok(Some((
            AcquireOptions {
                ttl: Duration::from_millis(ttl_ms),
                wait_timeout: Duration::from_millis(self.wait_timeout_ms),
                retry_interval: Duration::from_millis(self.retry_interval_ms),
                holder: None,
            },
            self.wait,
        )))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OresLockConfigV1 {
    pub schema_version: String,
    pub default_profile: String,
    pub selected_profile_env: Option<String>,
    pub env: Vec<EnvBinding>,
    pub profiles: Vec<LockProfileConfig>,
}

impl OresLockConfigV1 {
    /// Parse one `.ores-lock.toml` document and apply runtime cross-field
    /// invariants. Error messages contain field names, never resolved values.
    pub fn from_toml_str(source: &str) -> Result<Self, LockConfigError> {
        let config: Self = toml::from_str(source).map_err(|_| {
            LockConfigError::new(
                "invalid_toml",
                ".ores-lock.toml",
                "lock config must be valid TOML matching the v1 shape",
            )
        })?;
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), LockConfigError> {
        if self.schema_version != LOCK_CONFIG_SCHEMA_V1 {
            return Err(LockConfigError::new(
                "schema_version",
                "schema_version",
                "unsupported lock config schema version",
            ));
        }
        if self.env.is_empty() || self.env.len() > MAX_CONFIG_ENVS {
            return Err(LockConfigError::new(
                "env_count",
                "env",
                "env must contain between 1 and 128 declarations",
            ));
        }
        if self.profiles.is_empty() || self.profiles.len() > MAX_CONFIG_PROFILES {
            return Err(LockConfigError::new(
                "profile_count",
                "profiles",
                "profiles must contain between 1 and 64 declarations",
            ));
        }

        let mut env = BTreeMap::new();
        for binding in &self.env {
            validate_env_binding(binding)?;
            if env.insert(binding.key.as_str(), binding).is_some() {
                return Err(LockConfigError::new(
                    "duplicate_env",
                    "env",
                    "environment binding keys must be unique",
                ));
            }
        }

        if let Some(selector) = &self.selected_profile_env {
            let binding = env.get(selector.as_str()).ok_or_else(|| {
                LockConfigError::new(
                    "selected_profile_env_missing",
                    "selected_profile_env",
                    "selected_profile_env must name a declared environment binding",
                )
            })?;
            require_binding(
                binding,
                EnvKind::String,
                false,
                "selected_profile_env",
                "profile selector must be a non-secret string environment binding",
            )?;
        }

        let mut profile_ids = BTreeSet::new();
        for profile in &self.profiles {
            if !valid_id(&profile.profile_id) {
                return Err(LockConfigError::new(
                    "profile_id",
                    "profiles.profile_id",
                    "profile_id must be a lowercase portable identifier",
                ));
            }
            if !profile_ids.insert(profile.profile_id.as_str()) {
                return Err(LockConfigError::new(
                    "duplicate_profile",
                    "profiles.profile_id",
                    "profile_id values must be unique",
                ));
            }
            validate_profile(profile, &env)?;
        }

        if !valid_id(&self.default_profile) || !profile_ids.contains(self.default_profile.as_str())
        {
            return Err(LockConfigError::new(
                "default_profile",
                "default_profile",
                "default_profile must name one declared profile",
            ));
        }
        Ok(())
    }

    #[must_use]
    pub fn profile(&self, profile_id: &str) -> Option<&LockProfileConfig> {
        self.profiles
            .iter()
            .find(|profile| profile.profile_id == profile_id)
    }

    /// Select a profile after the caller/flags-2-env layer resolves the optional
    /// selector environment variable. Passing `None` or an empty value chooses
    /// `default_profile`; this function never reads the process environment.
    pub fn select_profile(
        &self,
        resolved_selector: Option<&str>,
    ) -> Result<&LockProfileConfig, LockConfigError> {
        let selected = resolved_selector
            .filter(|value| !value.is_empty())
            .unwrap_or(&self.default_profile);
        self.profile(selected).ok_or_else(|| {
            LockConfigError::new(
                "selected_profile",
                "selected_profile_env",
                "selected lock profile is not declared",
            )
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockConfigError {
    pub code: &'static str,
    pub path: &'static str,
    pub message: &'static str,
}

impl LockConfigError {
    const fn new(code: &'static str, path: &'static str, message: &'static str) -> Self {
        Self {
            code,
            path,
            message,
        }
    }
}

impl fmt::Display for LockConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} at {}: {}", self.code, self.path, self.message)
    }
}

impl Error for LockConfigError {}

fn validate_env_binding(binding: &EnvBinding) -> Result<(), LockConfigError> {
    if !valid_env_key(&binding.key) {
        return Err(LockConfigError::new(
            "env_key",
            "env.key",
            "environment keys must use portable UPPER_SNAKE_CASE",
        ));
    }
    if binding.purpose.is_empty() || binding.purpose.len() > 255 {
        return Err(LockConfigError::new(
            "env_purpose",
            "env.purpose",
            "environment binding purpose must contain 1..=255 bytes",
        ));
    }
    Ok(())
}

fn validate_profile(
    profile: &LockProfileConfig,
    env: &BTreeMap<&str, &EnvBinding>,
) -> Result<(), LockConfigError> {
    if profile.wait_timeout_ms > MAX_WAIT_TIMEOUT_MS {
        return Err(LockConfigError::new(
            "wait_timeout",
            "profiles.wait_timeout_ms",
            "wait_timeout_ms exceeds the portable maximum",
        ));
    }
    if profile.retry_interval_ms > MAX_RETRY_INTERVAL_MS {
        return Err(LockConfigError::new(
            "retry_interval",
            "profiles.retry_interval_ms",
            "retry_interval_ms exceeds the portable maximum",
        ));
    }
    if profile.wait && profile.retry_interval_ms == 0 {
        return Err(LockConfigError::new(
            "retry_interval",
            "profiles.retry_interval_ms",
            "retry_interval_ms must be positive when wait=true",
        ));
    }
    if !profile.wait && profile.wait_timeout_ms != 0 {
        return Err(LockConfigError::new(
            "wait_timeout",
            "profiles.wait_timeout_ms",
            "wait_timeout_ms must be zero when wait=false",
        ));
    }
    if !profile.providers.local_file && !profile.providers.fiducia && !profile.providers.pg_advisory
    {
        return Err(LockConfigError::new(
            "provider_selection",
            "profiles.providers",
            "at least one lock provider must be enabled",
        ));
    }

    match (profile.providers.local_file, profile.local_file.as_ref()) {
        (true, Some(local)) => {
            let binding = lookup_binding(env, &local.root_env, "profiles.local_file.root_env")?;
            require_binding(
                binding,
                EnvKind::Path,
                false,
                "profiles.local_file.root_env",
                "local lock root must be a non-secret path environment binding",
            )?;
        }
        (true, None) => {
            return Err(LockConfigError::new(
                "local_file_missing",
                "profiles.local_file",
                "enabled local_file provider requires its config table",
            ));
        }
        (false, Some(_)) => {
            return Err(LockConfigError::new(
                "local_file_dormant",
                "profiles.local_file",
                "disabled local_file provider must not carry dormant config",
            ));
        }
        (false, None) => {}
    }

    validate_outer_authority(profile, env)?;

    match (profile.providers.pg_advisory, profile.postgres.as_ref()) {
        (true, Some(postgres)) => {
            let database = lookup_binding(
                env,
                &postgres.database_url_env,
                "profiles.postgres.database_url_env",
            )?;
            require_binding(
                database,
                EnvKind::String,
                true,
                "profiles.postgres.database_url_env",
                "database URL must be a secret string environment binding",
            )?;
        }
        (true, None) => {
            return Err(LockConfigError::new(
                "postgres_missing",
                "profiles.postgres",
                "enabled pg_advisory provider requires its postgres config table",
            ));
        }
        (false, Some(_)) => {
            return Err(LockConfigError::new(
                "postgres_dormant",
                "profiles.postgres",
                "disabled pg_advisory provider must not carry dormant postgres config",
            ));
        }
        (false, None) => {}
    }

    Ok(())
}

fn validate_outer_authority(
    profile: &LockProfileConfig,
    env: &BTreeMap<&str, &EnvBinding>,
) -> Result<(), LockConfigError> {
    if !profile.providers.fiducia {
        if profile.outer_authority.is_some() {
            return Err(LockConfigError::new(
                "outer_authority_dormant",
                "profiles.outer_authority",
                "outer_authority must be absent when the managed outer lease layer is disabled",
            ));
        }
        if profile.fiducia.is_some()
            || profile.cloudflare_durable_object.is_some()
            || profile.beamscale_critical_section.is_some()
            || profile.redis.is_some()
        {
            return Err(LockConfigError::new(
                "outer_authority_config_dormant",
                "profiles",
                "disabled managed outer lease must not carry authority config",
            ));
        }
        if profile.ttl_ms.is_some() || profile.renew_interval_ms.is_some() {
            return Err(LockConfigError::new(
                "outer_tuning_dormant",
                "profiles.ttl_ms",
                "managed-lease timing must be absent when the outer lease layer is disabled",
            ));
        }
        return Ok(());
    }

    let ttl = profile.ttl_ms.ok_or_else(|| {
        LockConfigError::new(
            "ttl_missing",
            "profiles.ttl_ms",
            "enabled managed outer lease requires ttl_ms",
        )
    })?;
    if ttl == 0 || ttl > MAX_TTL_MS {
        return Err(LockConfigError::new(
            "ttl",
            "profiles.ttl_ms",
            "ttl_ms is outside the portable range",
        ));
    }
    if let Some(renew) = profile.renew_interval_ms {
        if renew == 0 || renew > MAX_RENEW_INTERVAL_MS || renew > ttl / 2 {
            return Err(LockConfigError::new(
                "renew_interval",
                "profiles.renew_interval_ms",
                "renew_interval_ms must be positive, bounded, and no greater than ttl_ms / 2",
            ));
        }
    }

    match profile
        .outer_authority
        .unwrap_or(OuterLeaseAuthority::Fiducia)
    {
        OuterLeaseAuthority::Fiducia => {
            if profile.cloudflare_durable_object.is_some()
                || profile.beamscale_critical_section.is_some()
                || profile.redis.is_some()
            {
                return Err(LockConfigError::new(
                    "outer_authority_conflict",
                    "profiles.outer_authority",
                    "Fiducia authority must not carry Cloudflare, BeamScale, or Redis config",
                ));
            }
            let fiducia = profile.fiducia.as_ref().ok_or_else(|| {
                LockConfigError::new(
                    "fiducia_missing",
                    "profiles.fiducia",
                    "Fiducia authority requires its config table",
                )
            })?;
            validate_endpoint_and_secret(
                env,
                &fiducia.endpoint_env,
                &fiducia.auth_token_env,
                "profiles.fiducia.endpoint_env",
                "profiles.fiducia.auth_token_env",
                "Fiducia",
            )?;
        }
        OuterLeaseAuthority::CloudflareDurableObject => {
            if profile.fiducia.is_some()
                || profile.beamscale_critical_section.is_some()
                || profile.redis.is_some()
            {
                return Err(LockConfigError::new(
                    "outer_authority_conflict",
                    "profiles.outer_authority",
                    "Cloudflare authority must not carry Fiducia, BeamScale, or Redis config",
                ));
            }
            let cloudflare = profile.cloudflare_durable_object.as_ref().ok_or_else(|| {
                LockConfigError::new(
                    "cloudflare_missing",
                    "profiles.cloudflare_durable_object",
                    "Cloudflare Durable Object authority requires its config table",
                )
            })?;
            validate_endpoint_and_secret(
                env,
                &cloudflare.endpoint_env,
                &cloudflare.api_token_env,
                "profiles.cloudflare_durable_object.endpoint_env",
                "profiles.cloudflare_durable_object.api_token_env",
                "Cloudflare Durable Object",
            )?;
        }
        OuterLeaseAuthority::BeamScaleCriticalSection => {
            if profile.fiducia.is_some()
                || profile.cloudflare_durable_object.is_some()
                || profile.redis.is_some()
            {
                return Err(LockConfigError::new(
                    "outer_authority_conflict",
                    "profiles.outer_authority",
                    "BeamScale authority must not carry Fiducia, Cloudflare, or Redis config",
                ));
            }
            let beamscale = profile.beamscale_critical_section.as_ref().ok_or_else(|| {
                LockConfigError::new(
                    "beamscale_missing",
                    "profiles.beamscale_critical_section",
                    "BeamScale critical-section authority requires its config table",
                )
            })?;
            validate_endpoint_and_secret(
                env,
                &beamscale.endpoint_env,
                &beamscale.api_token_env,
                "profiles.beamscale_critical_section.endpoint_env",
                "profiles.beamscale_critical_section.api_token_env",
                "BeamScale critical section",
            )?;
            let deployment = lookup_binding(
                env,
                &beamscale.deployment_id_env,
                "profiles.beamscale_critical_section.deployment_id_env",
            )?;
            require_binding(
                deployment,
                EnvKind::String,
                false,
                "profiles.beamscale_critical_section.deployment_id_env",
                "BeamScale deployment id must be a non-secret string environment binding",
            )?;
        }
        OuterLeaseAuthority::Redis => {
            if profile.fiducia.is_some()
                || profile.cloudflare_durable_object.is_some()
                || profile.beamscale_critical_section.is_some()
            {
                return Err(LockConfigError::new(
                    "outer_authority_conflict",
                    "profiles.outer_authority",
                    "Redis authority must not carry Fiducia, Cloudflare, or BeamScale config",
                ));
            }
            let redis = profile.redis.as_ref().ok_or_else(|| {
                LockConfigError::new(
                    "redis_missing",
                    "profiles.redis",
                    "Redis authority requires its config table",
                )
            })?;
            validate_endpoint_and_secret(
                env,
                &redis.endpoint_env,
                &redis.auth_token_env,
                "profiles.redis.endpoint_env",
                "profiles.redis.auth_token_env",
                "Redis",
            )?;
            if redis.namespace.as_deref().is_some_and(str::is_empty) {
                return Err(LockConfigError::new(
                    "redis_namespace",
                    "profiles.redis.namespace",
                    "Redis namespace must be absent or non-empty",
                ));
            }
        }
    }

    Ok(())
}

fn validate_endpoint_and_secret(
    env: &BTreeMap<&str, &EnvBinding>,
    endpoint_env: &str,
    secret_env: &str,
    endpoint_path: &'static str,
    secret_path: &'static str,
    authority_name: &'static str,
) -> Result<(), LockConfigError> {
    let endpoint = lookup_binding(env, endpoint_env, endpoint_path)?;
    require_binding(
        endpoint,
        EnvKind::Url,
        false,
        endpoint_path,
        match authority_name {
            "Fiducia" => "Fiducia endpoint must be a non-secret URL environment binding",
            "Cloudflare Durable Object" => {
                "Cloudflare Durable Object endpoint must be a non-secret URL environment binding"
            }
            "BeamScale critical section" => {
                "BeamScale critical-section endpoint must be a non-secret URL environment binding"
            }
            "Redis" => "Redis endpoint must be a non-secret URL environment binding",
            _ => "authority endpoint must be a non-secret URL environment binding",
        },
    )?;
    let secret = lookup_binding(env, secret_env, secret_path)?;
    require_binding(
        secret,
        EnvKind::String,
        true,
        secret_path,
        match authority_name {
            "Fiducia" => "Fiducia auth token must be a secret string environment binding",
            "Cloudflare Durable Object" => {
                "Cloudflare Durable Object API token must be a secret string environment binding"
            }
            "BeamScale critical section" => {
                "BeamScale API token must be a secret string environment binding"
            }
            "Redis" => "Redis auth token must be a secret string environment binding",
            _ => "authority credential must be a secret string environment binding",
        },
    )?;
    Ok(())
}

fn lookup_binding<'a>(
    env: &'a BTreeMap<&str, &'a EnvBinding>,
    key: &str,
    path: &'static str,
) -> Result<&'a EnvBinding, LockConfigError> {
    env.get(key).copied().ok_or_else(|| {
        LockConfigError::new(
            "env_reference_missing",
            path,
            "provider environment reference must name a declared binding",
        )
    })
}

fn require_binding(
    binding: &EnvBinding,
    kind: EnvKind,
    secret: bool,
    path: &'static str,
    message: &'static str,
) -> Result<(), LockConfigError> {
    if binding.kind != kind || binding.secret != secret {
        return Err(LockConfigError::new("env_reference_policy", path, message));
    }
    Ok(())
}

fn valid_env_key(value: &str) -> bool {
    if value.is_empty() || value.len() > 128 {
        return false;
    }
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    (first.is_ascii_uppercase() || first == b'_')
        && bytes.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

fn valid_id(value: &str) -> bool {
    if value.is_empty() || value.len() > 128 {
        return false;
    }
    let bytes = value.as_bytes();
    let edge = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    edge(bytes[0])
        && edge(bytes[bytes.len() - 1])
        && bytes
            .iter()
            .all(|byte| edge(*byte) || matches!(*byte, b'-' | b'_'))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT_CONFIG: &str = include_str!("../../.ores-lock.toml");

    #[test]
    fn root_config_parses_and_projects_profiles() {
        let config = OresLockConfigV1::from_toml_str(ROOT_CONFIG).expect("root lock config");

        let local = config.profile("local-install").expect("local profile");
        assert_eq!(local.layers(), LockLayers::NONE);
        assert_eq!(local.outer_authority(), None);
        assert!(local.local_file_options().is_some());
        assert!(
            local
                .lease_acquire_options()
                .expect("local projection")
                .is_none()
        );
        assert_eq!(local.pg_scope(), None);

        let fiducia = config
            .profile("service-composed")
            .expect("legacy service profile");
        assert_eq!(fiducia.layers(), LockLayers::BOTH);
        assert_eq!(
            fiducia.outer_authority(),
            Some(OuterLeaseAuthority::Fiducia)
        );
        assert!(fiducia.local_file_options().is_none());
        assert_eq!(fiducia.pg_scope(), Some(PgScope::Transaction));

        let cloudflare = config
            .profile("service-cloudflare-pg")
            .expect("cloudflare service profile");
        assert_eq!(cloudflare.layers(), LockLayers::BOTH);
        assert_eq!(
            cloudflare.outer_authority(),
            Some(OuterLeaseAuthority::CloudflareDurableObject)
        );
        assert_eq!(cloudflare.pg_scope(), Some(PgScope::Transaction));
        let (options, wait) = cloudflare
            .lease_acquire_options()
            .expect("cloudflare projection")
            .expect("lease options");
        assert!(wait);
        assert_eq!(options.ttl, Duration::from_millis(60_000));
        assert_eq!(options.wait_timeout, Duration::from_millis(30_000));
        assert_eq!(options.retry_interval, Duration::from_millis(250));

        let beamscale = config
            .profile("service-beamscale-pg")
            .expect("BeamScale service profile");
        assert_eq!(beamscale.layers(), LockLayers::BOTH);
        assert_eq!(
            beamscale.outer_authority(),
            Some(OuterLeaseAuthority::BeamScaleCriticalSection)
        );
        assert_eq!(beamscale.pg_scope(), Some(PgScope::Transaction));
        let (options, wait) = beamscale
            .lease_acquire_options()
            .expect("BeamScale projection")
            .expect("lease options");
        assert!(wait);
        assert_eq!(options.ttl, Duration::from_millis(60_000));
        assert_eq!(options.wait_timeout, Duration::from_millis(30_000));
        assert_eq!(options.retry_interval, Duration::from_millis(250));
    }

    #[test]
    fn profile_selection_is_pure_and_fail_closed() {
        let config = OresLockConfigV1::from_toml_str(ROOT_CONFIG).expect("root lock config");
        assert_eq!(
            config.select_profile(None).expect("default").profile_id,
            "local-install"
        );
        assert_eq!(
            config
                .select_profile(Some("service-cloudflare-pg"))
                .expect("selected")
                .profile_id,
            "service-cloudflare-pg"
        );
        assert_eq!(
            config.select_profile(Some("unknown")).unwrap_err().code,
            "selected_profile"
        );
    }

    #[test]
    fn rejects_secret_policy_and_renewal_drift() {
        let public_secret = ROOT_CONFIG.replace(
            "key = \"ORES_LOCKS_CF_TOKEN\"\nkind = \"string\"\nrequired = false\nsecret = true",
            "key = \"ORES_LOCKS_CF_TOKEN\"\nkind = \"string\"\nrequired = false\nsecret = false",
        );
        assert_eq!(
            OresLockConfigV1::from_toml_str(&public_secret)
                .unwrap_err()
                .code,
            "env_reference_policy"
        );

        let bad_renewal = ROOT_CONFIG.replace(
            "ttl_ms = 60000\nrenew_interval_ms = 20000\nouter_authority = \"cloudflare_durable_object\"",
            "ttl_ms = 60000\nrenew_interval_ms = 40000\nouter_authority = \"cloudflare_durable_object\"",
        );
        assert_eq!(
            OresLockConfigV1::from_toml_str(&bad_renewal)
                .unwrap_err()
                .code,
            "renew_interval"
        );
    }

    #[test]
    fn rejects_beamscale_deployment_id_as_secret() {
        let invalid = ROOT_CONFIG.replace(
            "key = \"BMSCL_CRITICAL_SECTION_DEPLOYMENT_ID\"\nkind = \"string\"\nrequired = false\nsecret = false",
            "key = \"BMSCL_CRITICAL_SECTION_DEPLOYMENT_ID\"\nkind = \"string\"\nrequired = false\nsecret = true",
        );
        let error = OresLockConfigV1::from_toml_str(&invalid)
            .expect_err("deployment id must remain non-secret");
        assert_eq!(error.code, "env_reference_policy");
        assert_eq!(
            error.path,
            "profiles.beamscale_critical_section.deployment_id_env"
        );
    }

    #[test]
    fn rejects_unknown_fields_and_dormant_provider_tables() {
        let unknown = format!("{ROOT_CONFIG}\nunknown_runtime_knob = true\n");
        assert_eq!(
            OresLockConfigV1::from_toml_str(&unknown).unwrap_err().code,
            "invalid_toml"
        );

        let dormant = ROOT_CONFIG.replace(
            "local_file = true\nfiducia = false\npg_advisory = false",
            "local_file = false\nfiducia = false\npg_advisory = true",
        );
        assert_eq!(
            OresLockConfigV1::from_toml_str(&dormant).unwrap_err().code,
            "local_file_dormant"
        );
    }

    #[test]
    fn legacy_v1_outer_layer_defaults_to_fiducia() {
        let legacy = ROOT_CONFIG.replace("outer_authority = \"fiducia\"\n", "");
        let config = OresLockConfigV1::from_toml_str(&legacy).expect("legacy config");
        assert_eq!(
            config
                .profile("service-composed")
                .expect("legacy service")
                .outer_authority(),
            Some(OuterLeaseAuthority::Fiducia)
        );
    }
}
