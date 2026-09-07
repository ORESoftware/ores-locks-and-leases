//! Pure fencing-token watermark decisions shared by every runtime.

use std::fmt;

use crate::lease::FencingToken;

pub const MAX_FENCING_TOKEN_DECIMAL: &str = "18446744073709551615";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FenceValidationError {
    pub field: &'static str,
    pub message: String,
}

impl FenceValidationError {
    fn new(field: &'static str, message: impl Into<String>) -> Self {
        Self {
            field,
            message: message.into(),
        }
    }
}

impl fmt::Display for FenceValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid {}: {}", self.field, self.message)
    }
}

impl std::error::Error for FenceValidationError {}

pub fn parse_fencing_token_decimal(value: &str) -> Result<FencingToken, FenceValidationError> {
    if value.is_empty() {
        return Err(FenceValidationError::new(
            "fencingToken",
            "must be a canonical unsigned decimal string",
        ));
    }
    if value.len() > 1 && value.starts_with('0') {
        return Err(FenceValidationError::new(
            "fencingToken",
            "must not contain leading zeroes",
        ));
    }
    if !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(FenceValidationError::new(
            "fencingToken",
            "must contain only ASCII decimal digits",
        ));
    }
    if value.len() > MAX_FENCING_TOKEN_DECIMAL.len()
        || (value.len() == MAX_FENCING_TOKEN_DECIMAL.len()
            && value > MAX_FENCING_TOKEN_DECIMAL)
    {
        return Err(FenceValidationError::new(
            "fencingToken",
            "exceeds the unsigned 64-bit maximum",
        ));
    }
    value.parse::<u64>().map_err(|_| {
        FenceValidationError::new("fencingToken", "exceeds the unsigned 64-bit maximum")
    })
}

pub fn format_fencing_token_decimal(value: FencingToken) -> String {
    value.to_string()
}

fn validate_operation_id(value: &str) -> Result<(), FenceValidationError> {
    let bytes = value.as_bytes();
    let first_ok = bytes.first().is_some_and(u8::is_ascii_alphanumeric);
    let rest_ok = bytes.iter().skip(1).all(|byte| {
        byte.is_ascii_alphanumeric() || matches!(*byte, b'.' | b'_' | b':' | b'/' | b'-')
    });
    if !first_ok || !rest_ok || bytes.len() > 256 {
        return Err(FenceValidationError::new(
            "operationId",
            "must match [A-Za-z0-9][A-Za-z0-9._:/-]{0,255}",
        ));
    }
    Ok(())
}

fn validate_payload_sha256(value: &str) -> Result<(), FenceValidationError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(FenceValidationError::new(
            "payloadSha256",
            "must be exactly 64 lowercase hexadecimal characters",
        ));
    }
    Ok(())
}

fn validate_stamp(operation_id: &str, payload_sha256: &str) -> Result<(), FenceValidationError> {
    validate_operation_id(operation_id)?;
    validate_payload_sha256(payload_sha256)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FenceWatermark {
    pub fencing_token: FencingToken,
    pub operation_id: String,
    pub payload_sha256: String,
}

impl FenceWatermark {
    pub fn new(
        fencing_token: FencingToken,
        operation_id: impl Into<String>,
        payload_sha256: impl Into<String>,
    ) -> Result<Self, FenceValidationError> {
        let value = Self {
            fencing_token,
            operation_id: operation_id.into(),
            payload_sha256: payload_sha256.into(),
        };
        value.validate()?;
        Ok(value)
    }

    pub fn from_decimal(
        fencing_token: &str,
        operation_id: impl Into<String>,
        payload_sha256: impl Into<String>,
    ) -> Result<Self, FenceValidationError> {
        Self::new(
            parse_fencing_token_decimal(fencing_token)?,
            operation_id,
            payload_sha256,
        )
    }

    pub fn fencing_token_decimal(&self) -> String {
        format_fencing_token_decimal(self.fencing_token)
    }

    fn validate(&self) -> Result<(), FenceValidationError> {
        validate_stamp(&self.operation_id, &self.payload_sha256)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FenceAttempt {
    pub fencing_token: FencingToken,
    pub operation_id: String,
    pub payload_sha256: String,
}

impl FenceAttempt {
    pub fn new(
        fencing_token: FencingToken,
        operation_id: impl Into<String>,
        payload_sha256: impl Into<String>,
    ) -> Result<Self, FenceValidationError> {
        let value = Self {
            fencing_token,
            operation_id: operation_id.into(),
            payload_sha256: payload_sha256.into(),
        };
        value.validate()?;
        Ok(value)
    }

    pub fn from_decimal(
        fencing_token: &str,
        operation_id: impl Into<String>,
        payload_sha256: impl Into<String>,
    ) -> Result<Self, FenceValidationError> {
        Self::new(
            parse_fencing_token_decimal(fencing_token)?,
            operation_id,
            payload_sha256,
        )
    }

    fn validate(&self) -> Result<(), FenceValidationError> {
        validate_stamp(&self.operation_id, &self.payload_sha256)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FenceDecisionKind {
    Advanced,
    Replay,
    TokenReuse,
    Stale,
}

impl FenceDecisionKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Advanced => "advanced",
            Self::Replay => "replay",
            Self::TokenReuse => "token_reuse",
            Self::Stale => "stale",
        }
    }

    pub fn parse(value: &str) -> Result<Self, FenceValidationError> {
        match value {
            "advanced" => Ok(Self::Advanced),
            "replay" => Ok(Self::Replay),
            "token_reuse" => Ok(Self::TokenReuse),
            "stale" => Ok(Self::Stale),
            _ => Err(FenceValidationError::new(
                "kind",
                format!("unknown fence decision `{value}`"),
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FenceDecision {
    pub kind: FenceDecisionKind,
    pub apply: bool,
    pub watermark: FenceWatermark,
}

pub fn decide_fence(
    current: Option<&FenceWatermark>,
    incoming: &FenceAttempt,
) -> Result<FenceDecision, FenceValidationError> {
    incoming.validate()?;
    if let Some(current) = current {
        current.validate()?;
    }

    let incoming_watermark = || FenceWatermark {
        fencing_token: incoming.fencing_token,
        operation_id: incoming.operation_id.clone(),
        payload_sha256: incoming.payload_sha256.clone(),
    };

    let Some(current) = current else {
        return Ok(FenceDecision {
            kind: FenceDecisionKind::Advanced,
            apply: true,
            watermark: incoming_watermark(),
        });
    };

    let (kind, apply, watermark) = if incoming.fencing_token > current.fencing_token {
        (FenceDecisionKind::Advanced, true, incoming_watermark())
    } else if incoming.fencing_token < current.fencing_token {
        (FenceDecisionKind::Stale, false, current.clone())
    } else if incoming.operation_id == current.operation_id
        && incoming.payload_sha256 == current.payload_sha256
    {
        (FenceDecisionKind::Replay, false, current.clone())
    } else {
        (FenceDecisionKind::TokenReuse, false, current.clone())
    };

    Ok(FenceDecision {
        kind,
        apply,
        watermark,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIGEST_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const DIGEST_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[test]
    fn token_boundary_is_canonical_and_exact() {
        assert_eq!(parse_fencing_token_decimal("0"), Ok(0));
        assert_eq!(
            parse_fencing_token_decimal(MAX_FENCING_TOKEN_DECIMAL),
            Ok(u64::MAX)
        );
        for invalid in ["", "01", "+1", "-1", "1.0", " 1", "18446744073709551616"] {
            assert!(parse_fencing_token_decimal(invalid).is_err(), "{invalid:?}");
        }
    }

    #[test]
    fn decision_has_four_fail_closed_outcomes() {
        let current = FenceWatermark::new(7, "op:seven", DIGEST_A).unwrap();
        for (incoming, expected) in [
            (
                FenceAttempt::new(8, "op:eight", DIGEST_B).unwrap(),
                FenceDecisionKind::Advanced,
            ),
            (
                FenceAttempt::new(7, "op:seven", DIGEST_A).unwrap(),
                FenceDecisionKind::Replay,
            ),
            (
                FenceAttempt::new(7, "op:other", DIGEST_A).unwrap(),
                FenceDecisionKind::TokenReuse,
            ),
            (
                FenceAttempt::new(6, "op:six", DIGEST_A).unwrap(),
                FenceDecisionKind::Stale,
            ),
        ] {
            assert_eq!(
                decide_fence(Some(&current), &incoming).unwrap().kind,
                expected
            );
        }
    }
}
