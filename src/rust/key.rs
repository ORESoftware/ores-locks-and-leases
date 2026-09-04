//! Lock identities and the advisory-key derivation shared by every runtime.

use std::fmt;

/// A caller-chosen lock identity. Convention: `<org>/<domain>/<name>`, for
/// example `zed-pkg/registry/publish:zed-lib-core`. At most 512 bytes.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct LockKey(String);

/// The longest key the contract admits (`contracts/typespec/main.tsp`).
pub const MAX_LOCK_KEY_BYTES: usize = 512;

impl LockKey {
    /// Build a key, refusing one longer than [`MAX_LOCK_KEY_BYTES`].
    pub fn new(key: impl Into<String>) -> Result<Self, InvalidLockKey> {
        let key = key.into();
        if key.len() > MAX_LOCK_KEY_BYTES {
            return Err(InvalidLockKey::TooLong {
                bytes: key.len(),
                max: MAX_LOCK_KEY_BYTES,
            });
        }
        Ok(Self(key))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The Postgres `bigint` this key locks. See [`advisory_key`].
    pub fn advisory_key(&self) -> AdvisoryKey {
        advisory_key(&self.0)
    }
}

impl fmt::Display for LockKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl AsRef<str> for LockKey {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl TryFrom<&str> for LockKey {
    type Error = InvalidLockKey;
    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl TryFrom<String> for LockKey {
    type Error = InvalidLockKey;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

/// Why a string is not a [`LockKey`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvalidLockKey {
    TooLong { bytes: usize, max: usize },
}

impl fmt::Display for InvalidLockKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLong { bytes, max } => {
                write!(
                    f,
                    "lock key is {bytes} bytes; the contract allows at most {max}"
                )
            }
        }
    }
}

impl std::error::Error for InvalidLockKey {}

/// The integer a Postgres advisory-lock function receives for a key.
///
/// Signed because that is what `pg_advisory_xact_lock(bigint)` takes; the
/// bit pattern is the unsigned FNV-1a hash reinterpreted in two's complement.
pub type AdvisoryKey = i64;

const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// FNV-1a, 64-bit, over the UTF-8 bytes of `key`.
///
/// Chosen over a cryptographic hash because every runtime in the fleet can
/// implement it in a dozen lines with no dependency, and over `hashtext()`
/// because that is `int4` and Postgres-version-dependent. Collisions are
/// possible in principle; advisory locks are cooperative, so a collision costs
/// unnecessary serialization, never a correctness failure.
pub fn fnv1a64(key: &str) -> u64 {
    key.bytes().fold(FNV_OFFSET_BASIS, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(FNV_PRIME)
    })
}

/// The `bigint` every runtime locks for `key`. Vectors:
/// `conformance/cases/advisory-key.json`.
pub fn advisory_key(key: &str) -> AdvisoryKey {
    // `as` on an unsigned-to-signed cast of equal width is a bit reinterpretation.
    fnv1a64(key) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv_offset_basis_is_the_hash_of_the_empty_string() {
        assert_eq!(fnv1a64(""), FNV_OFFSET_BASIS);
        assert_eq!(advisory_key(""), -3_750_763_034_362_895_579);
    }

    #[test]
    fn known_vectors() {
        assert_eq!(fnv1a64("a"), 12_638_187_200_555_641_996);
        assert_eq!(advisory_key("a"), -5_808_556_873_153_909_620);
        assert_eq!(advisory_key("orders/checkout"), 1_827_953_472_736_452_509);
    }

    #[test]
    fn key_length_is_bounded() {
        assert!(LockKey::new("x".repeat(MAX_LOCK_KEY_BYTES)).is_ok());
        assert!(matches!(
            LockKey::new("x".repeat(MAX_LOCK_KEY_BYTES + 1)),
            Err(InvalidLockKey::TooLong { .. })
        ));
    }
}
