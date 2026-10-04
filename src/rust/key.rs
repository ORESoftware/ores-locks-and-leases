//! Lock identities and the advisory-key derivation shared by every runtime.

use std::fmt;

/// A caller-chosen lock identity. Convention: `<org>/<domain>/<name>`, for
/// example `zed-pkg/registry/publish:zed-lib-core`. At most 512 bytes.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct LockKey(String);

/// The longest key the contract admits (`contracts/typespec/main.tsp`).
pub const MAX_LOCK_KEY_BYTES: usize = 512;

impl LockKey {
    /// Build a non-empty key no longer than [`MAX_LOCK_KEY_BYTES`].
    pub fn new(key: impl Into<String>) -> Result<Self, InvalidLockKey> {
        let key = key.into();
        if key.is_empty() {
            return Err(InvalidLockKey::Empty);
        }
        if key.trim() != key {
            return Err(InvalidLockKey::SurroundingWhitespace);
        }
        if key.bytes().any(|byte| byte.is_ascii_control()) {
            return Err(InvalidLockKey::AsciiControl);
        }
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

/// Compose structured identity components without separator aliasing.
///
/// Each component is encoded as `<utf8-byte-length>:<raw-component>` and the
/// records are concatenated. The length prefix makes the mapping injective even
/// when components themselves contain `/`, `:`, or decimal text. The final
/// value is still validated by [`LockKey::new`], so control bytes, ambiguous
/// surrounding whitespace, and the 512-byte ceiling remain enforced.
pub fn lock_key_from_components<I, S>(components: I) -> Result<LockKey, InvalidLockKey>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut encoded = String::new();
    for component in components {
        let component = component.as_ref();
        encoded.push_str(&component.len().to_string());
        encoded.push(':');
        encoded.push_str(component);
    }
    LockKey::new(encoded)
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
    Empty,
    SurroundingWhitespace,
    AsciiControl,
    TooLong { bytes: usize, max: usize },
}

impl fmt::Display for InvalidLockKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => f.write_str("lock key must not be empty"),
            Self::SurroundingWhitespace => {
                f.write_str("lock key must not have leading or trailing whitespace")
            }
            Self::AsciiControl => f.write_str("lock key must not contain ASCII control bytes"),
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
    fn component_composition_is_injective_and_policy_checked() {
        let key = lock_key_from_components(["tenant/a", "job:b"]).unwrap();
        assert_eq!(key.as_str(), "8:tenant/a5:job:b");
        assert_ne!(
            key,
            lock_key_from_components(["tenant", "a", "job:b"]).unwrap()
        );
        assert!(matches!(
            lock_key_from_components(std::iter::empty::<&str>()),
            Err(InvalidLockKey::Empty)
        ));
        assert!(matches!(
            lock_key_from_components(["bad\ncomponent"]),
            Err(InvalidLockKey::AsciiControl)
        ));
    }
    #[test]
    fn key_is_non_empty_and_length_bounded() {
        assert!(matches!(LockKey::new(""), Err(InvalidLockKey::Empty)));
        assert!(matches!(
            LockKey::new("   "),
            Err(InvalidLockKey::SurroundingWhitespace)
        ));
        assert!(matches!(
            LockKey::new(" key"),
            Err(InvalidLockKey::SurroundingWhitespace)
        ));
        assert!(matches!(
            LockKey::new("key\nother"),
            Err(InvalidLockKey::AsciiControl)
        ));
        assert!(LockKey::new("unicode-π").is_ok());
        assert!(LockKey::new("x".repeat(MAX_LOCK_KEY_BYTES)).is_ok());
        assert!(matches!(
            LockKey::new("x".repeat(MAX_LOCK_KEY_BYTES + 1)),
            Err(InvalidLockKey::TooLong { .. })
        ));
        assert!(matches!(
            LockKey::new("é".repeat(257)),
            Err(InvalidLockKey::TooLong { .. })
        ));
    }
}
