//! Application-side fencing decisions.
//!
//! A lease grant is not safe by itself: a holder can pause beyond its TTL and
//! resume after a newer holder has acquired the same key. Every protected
//! datastore must therefore compare and advance a monotonically increasing
//! fencing watermark atomically with the business mutation.
//!
//! `FencingTokenText` is the lossless wire/storage form. It is a canonical
//! unsigned-64 decimal string because JSON numbers, JavaScript `number`, Redis
//! Lua numbers, and PostgreSQL signed `bigint` cannot all represent the full
//! `u64` range exactly.

use std::fmt;

use crate::key::LockKey;

/// Largest value accepted by [`FencingTokenText`].
pub const MAX_FENCING_TOKEN_TEXT: &str = "18446744073709551615";
/// Maximum UTF-8 bytes in a tenant/partition scope.
pub const MAX_TENANT_SCOPE_BYTES: usize = 256;
/// Maximum UTF-8 bytes in an idempotency operation id.
pub const MAX_OPERATION_ID_BYTES: usize = 128;
/// Maximum UTF-8 bytes in optional holder and lease identifiers.
pub const MAX_FENCE_METADATA_BYTES: usize = 256;

/// Canonical, lossless decimal representation of a Fiducia `uint64` token.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct FencingTokenText {
    text: String,
    value: u64,
}

impl FencingTokenText {
    /// Parse a canonical unsigned-64 decimal string.
    ///
    /// Leading zeroes, signs, whitespace, decimal points, and values above
    /// `u64::MAX` are rejected so every runtime has one byte representation.
    pub fn parse(text: impl Into<String>) -> Result<Self, FenceValidationError> {
        let text = text.into();
        let value = text
            .parse::<u64>()
            .map_err(|_| FenceValidationError::InvalidFencingToken(text.clone()))?;
        if value.to_string() != text {
            return Err(FenceValidationError::InvalidFencingToken(text));
        }
        Ok(Self { text, value })
    }

    /// Build the canonical text form from a native token.
    pub fn from_u64(value: u64) -> Self {
        Self {
            text: value.to_string(),
            value,
        }
    }

    pub fn as_str(&self) -> &str {
        &self.text
    }

    pub fn value(&self) -> u64 {
        self.value
    }
}

impl fmt::Display for FencingTokenText {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.text)
    }
}

impl PartialOrd for FencingTokenText {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for FencingTokenText {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.value.cmp(&other.value)
    }
}

impl TryFrom<&str> for FencingTokenText {
    type Error = FenceValidationError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Self::parse(value)
    }
}

impl From<u64> for FencingTokenText {
    fn from(value: u64) -> Self {
        Self::from_u64(value)
    }
}

/// Result of comparing an incoming grant with the stored watermark.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FenceDecisionKind {
    /// The token is newer (or no watermark exists); apply the mutation once.
    Advanced,
    /// Same token, operation id, and payload digest; do not reapply.
    Replay,
    /// The incoming token is older than the stored watermark.
    Stale,
    /// Same token but a different operation id or payload digest.
    TokenReuse,
}

impl FenceDecisionKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Advanced => "advanced",
            Self::Replay => "replay",
            Self::Stale => "stale",
            Self::TokenReuse => "token_reuse",
        }
    }
}

/// A write attempt guarded by a Fiducia fencing token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FencedWriteRequest {
    pub tenant_scope: String,
    pub resource_key: LockKey,
    pub fencing_token: FencingTokenText,
    pub operation_id: String,
    pub payload_sha256: String,
    pub holder: Option<String>,
    pub lease_id: Option<String>,
}

impl FencedWriteRequest {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        tenant_scope: impl Into<String>,
        resource_key: LockKey,
        fencing_token: FencingTokenText,
        operation_id: impl Into<String>,
        payload_sha256: impl Into<String>,
        holder: Option<String>,
        lease_id: Option<String>,
    ) -> Result<Self, FenceValidationError> {
        let request = Self {
            tenant_scope: tenant_scope.into(),
            resource_key,
            fencing_token,
            operation_id: operation_id.into(),
            payload_sha256: payload_sha256.into(),
            holder,
            lease_id,
        };
        request.validate()?;
        Ok(request)
    }

    pub fn validate(&self) -> Result<(), FenceValidationError> {
        validate_non_empty("tenantScope", &self.tenant_scope, MAX_TENANT_SCOPE_BYTES)?;
        validate_non_empty("resourceKey", self.resource_key.as_str(), 512)?;
        validate_non_empty("operationId", &self.operation_id, MAX_OPERATION_ID_BYTES)?;
        validate_sha256(&self.payload_sha256)?;
        validate_optional("holder", self.holder.as_deref(), MAX_FENCE_METADATA_BYTES)?;
        validate_optional(
            "leaseId",
            self.lease_id.as_deref(),
            MAX_FENCE_METADATA_BYTES,
        )?;
        Ok(())
    }
}

/// Last accepted write for one `(tenant_scope, resource_key)` pair.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FenceWatermark {
    pub tenant_scope: String,
    pub resource_key: LockKey,
    pub fencing_token: FencingTokenText,
    pub operation_id: String,
    pub payload_sha256: String,
    pub holder: Option<String>,
    pub lease_id: Option<String>,
}

impl FenceWatermark {
    pub fn from_request(request: &FencedWriteRequest) -> Self {
        Self {
            tenant_scope: request.tenant_scope.clone(),
            resource_key: request.resource_key.clone(),
            fencing_token: request.fencing_token.clone(),
            operation_id: request.operation_id.clone(),
            payload_sha256: request.payload_sha256.clone(),
            holder: request.holder.clone(),
            lease_id: request.lease_id.clone(),
        }
    }

    pub fn validate(&self) -> Result<(), FenceValidationError> {
        let request = FencedWriteRequest {
            tenant_scope: self.tenant_scope.clone(),
            resource_key: self.resource_key.clone(),
            fencing_token: self.fencing_token.clone(),
            operation_id: self.operation_id.clone(),
            payload_sha256: self.payload_sha256.clone(),
            holder: self.holder.clone(),
            lease_id: self.lease_id.clone(),
        };
        request.validate()
    }
}

/// Pure decision result. Only `advanced` has `should_apply = true`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FenceDecision {
    pub kind: FenceDecisionKind,
    pub should_apply: bool,
    pub incoming_token: FencingTokenText,
    pub current_token: FencingTokenText,
    pub previous_token: Option<FencingTokenText>,
}

/// Compare an incoming request with an optional current watermark.
///
/// The datastore adapter must perform this decision, persist an `advanced`
/// watermark, and perform the protected mutation in one transaction/script.
/// This pure helper exists so SQL, Redis, and every runtime share semantics.
pub fn evaluate_fence(
    current: Option<&FenceWatermark>,
    incoming: &FencedWriteRequest,
) -> Result<FenceDecision, FenceValidationError> {
    incoming.validate()?;

    let Some(current) = current else {
        return Ok(FenceDecision {
            kind: FenceDecisionKind::Advanced,
            should_apply: true,
            incoming_token: incoming.fencing_token.clone(),
            current_token: incoming.fencing_token.clone(),
            previous_token: None,
        });
    };

    current.validate()?;
    if current.tenant_scope != incoming.tenant_scope
        || current.resource_key != incoming.resource_key
    {
        return Err(FenceValidationError::IdentityMismatch);
    }

    let previous = Some(current.fencing_token.clone());
    let incoming_value = incoming.fencing_token.value();
    let current_value = current.fencing_token.value();

    if incoming_value > current_value {
        return Ok(FenceDecision {
            kind: FenceDecisionKind::Advanced,
            should_apply: true,
            incoming_token: incoming.fencing_token.clone(),
            current_token: incoming.fencing_token.clone(),
            previous_token: previous,
        });
    }

    if incoming_value < current_value {
        return Ok(FenceDecision {
            kind: FenceDecisionKind::Stale,
            should_apply: false,
            incoming_token: incoming.fencing_token.clone(),
            current_token: current.fencing_token.clone(),
            previous_token: previous,
        });
    }

    let kind = if current.operation_id == incoming.operation_id
        && current.payload_sha256 == incoming.payload_sha256
    {
        FenceDecisionKind::Replay
    } else {
        FenceDecisionKind::TokenReuse
    };

    Ok(FenceDecision {
        kind,
        should_apply: false,
        incoming_token: incoming.fencing_token.clone(),
        current_token: current.fencing_token.clone(),
        previous_token: previous,
    })
}

/// Why a fencing request cannot be evaluated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FenceValidationError {
    EmptyField(&'static str),
    TooLong {
        field: &'static str,
        bytes: usize,
        max: usize,
    },
    InvalidFencingToken(String),
    InvalidPayloadSha256,
    IdentityMismatch,
}

impl FenceValidationError {
    /// Stable machine-facing classification used by conformance tests.
    pub const fn code(&self) -> &'static str {
        match self {
            Self::EmptyField(_) => "empty_field",
            Self::TooLong { .. } => "too_long",
            Self::InvalidFencingToken(_) => "invalid_fencing_token",
            Self::InvalidPayloadSha256 => "invalid_payload_sha256",
            Self::IdentityMismatch => "identity_mismatch",
        }
    }
}

impl fmt::Display for FenceValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyField(field) => write!(f, "{field} must not be empty"),
            Self::TooLong { field, bytes, max } => {
                write!(f, "{field} is {bytes} bytes; maximum is {max}")
            }
            Self::InvalidFencingToken(value) => write!(
                f,
                "fencing token {value:?} is not a canonical unsigned-64 decimal string"
            ),
            Self::InvalidPayloadSha256 => {
                f.write_str("payloadSha256 must be exactly 64 lowercase hexadecimal characters")
            }
            Self::IdentityMismatch => {
                f.write_str("current watermark and incoming request identify different resources")
            }
        }
    }
}

impl std::error::Error for FenceValidationError {}

fn validate_non_empty(
    field: &'static str,
    value: &str,
    max: usize,
) -> Result<(), FenceValidationError> {
    if value.is_empty() {
        return Err(FenceValidationError::EmptyField(field));
    }
    if value.len() > max {
        return Err(FenceValidationError::TooLong {
            field,
            bytes: value.len(),
            max,
        });
    }
    Ok(())
}

fn validate_optional(
    field: &'static str,
    value: Option<&str>,
    max: usize,
) -> Result<(), FenceValidationError> {
    if let Some(value) = value {
        validate_non_empty(field, value, max)?;
    }
    Ok(())
}

fn validate_sha256(value: &str) -> Result<(), FenceValidationError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(FenceValidationError::InvalidPayloadSha256);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(token: &str, operation: &str, digest: &str) -> FencedWriteRequest {
        FencedWriteRequest::new(
            "tenant/acme",
            LockKey::new("example/jobs/rebuild").unwrap(),
            FencingTokenText::parse(token).unwrap(),
            operation,
            digest,
            None,
            None,
        )
        .unwrap()
    }

    #[test]
    fn canonical_token_round_trips_full_u64() {
        let token = FencingTokenText::parse(MAX_FENCING_TOKEN_TEXT).unwrap();
        assert_eq!(token.value(), u64::MAX);
        assert_eq!(token.as_str(), MAX_FENCING_TOKEN_TEXT);
        for invalid in ["", "01", "+1", "-1", "18446744073709551616"] {
            assert!(FencingTokenText::parse(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn equal_token_requires_same_operation_and_payload() {
        let digest_a = "a".repeat(64);
        let digest_b = "b".repeat(64);
        let current = FenceWatermark::from_request(&request("7", "op-7", &digest_a));

        let replay = evaluate_fence(Some(&current), &request("7", "op-7", &digest_a)).unwrap();
        assert_eq!(replay.kind, FenceDecisionKind::Replay);
        assert!(!replay.should_apply);

        let reused = evaluate_fence(Some(&current), &request("7", "op-7", &digest_b)).unwrap();
        assert_eq!(reused.kind, FenceDecisionKind::TokenReuse);
        assert!(!reused.should_apply);
    }
}
