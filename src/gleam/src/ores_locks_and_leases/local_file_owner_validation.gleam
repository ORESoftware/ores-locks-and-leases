//// Shared owner-token admission for Gleam local filesystem locks.
////
//// Acquisition and explicit recovery must classify owner tokens through this
//// single implementation so their empty/scalar-bound semantics cannot drift.

import gleam/string

const owner_max_codepoints = 512

pub type OwnerAdmission {
  OwnerValid
  OwnerEmpty
  OwnerOversized
}

pub fn validate(owner: String) -> OwnerAdmission {
  case
    string.is_empty(owner),
    unicode_codepoint_count(owner) > owner_max_codepoints
  {
    True, _ -> OwnerEmpty
    _, True -> OwnerOversized
    False, False -> OwnerValid
  }
}

@external(erlang, "ores_locks_and_leases_local_file_ffi", "unicode_codepoint_count")
fn unicode_codepoint_count(value: String) -> Int
