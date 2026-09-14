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

model LocalFileLockFailure {
  kind: LocalFileLockErrorKind;
  path: LocalFileLockPath;

  @minLength(1)
  message: string;
}
