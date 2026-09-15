// Portable local filesystem lock contract — independent TypeSpec authority.
// Peer of ../json-schema/contract.schema.json. Neither file is generated from
// the other; TJSV emits a comparison-only JSON Schema witness from this source.

namespace Ores.LocksAndLeases.LocalFile;

@minLength(1)
@maxLength(4096)
scalar LocalFileLockPath extends string;

@minLength(1)
@maxLength(512)
scalar LocalFileLockOwner extends string;

enum LocalFileLockErrorKind {
  contention: "contention",
  timeout: "timeout",
  compromised: "compromised",
  io: "io",
  invalidInput: "invalid_input",
}

enum LocalFileLockInspectionState {
  absent: "absent",
  held: "held",
  incomplete: "incomplete",
  compromised: "compromised",
}

enum LocalFileLockInspectionReason {
  ownerMarkerMissing: "owner_marker_missing",
  pathNotDirectory: "path_not_directory",
  dirtyDirectory: "dirty_directory",
  ownerNotRegularFile: "owner_not_regular_file",
  ownerTooLarge: "owner_too_large",
  ownerInvalidUtf8: "owner_invalid_utf8",
  ownerIdentityChanged: "owner_identity_changed",
  permissionsWidened: "permissions_widened",
  ownerContractViolation: "owner_contract_violation",
}

enum ScopedLocalFileLockOutcomeKind {
  success: "success",
  lockError: "lock_error",
  workError: "work_error",
  workAndReleaseError: "work_and_release_error",
}

model LocalFileLockOptions {
  wait: boolean;

  @minValue(0)
  waitTimeoutMs: int64;

  @minValue(0)
  retryIntervalMs: int64;
}

model LocalFileLockIdentity {
  path: LocalFileLockPath;
  owner: LocalFileLockOwner;
}

model LocalFileLockSnapshot {
  path: LocalFileLockPath;
  owner: LocalFileLockOwner;
  released: boolean;
}

union LocalFileLockInspection {
  absent: {
    state: "absent";
  },
  held: {
    state: "held";
    owner: LocalFileLockOwner;
  },
  incomplete: {
    state: "incomplete";
    reason: "owner_marker_missing";

    @minLength(1)
    message: string;
  },
  compromised: {
    state: "compromised";
    reason: LocalFileLockInspectionReason;

    @minLength(1)
    message: string;
  },
}

model LocalFileLockRecoveryRequest {
  path: LocalFileLockPath;
  expectedOwner: LocalFileLockOwner;
  confirmedInactive: boolean;
}

model LocalFileLockRecoveryResult {
  recovered: boolean;
}

model ScopedLocalFileLockOutcome {
  kind: ScopedLocalFileLockOutcomeKind;
}

model LocalFileLockFailure {
  kind: LocalFileLockErrorKind;
  path: LocalFileLockPath;

  @minLength(1)
  message: string;
}
