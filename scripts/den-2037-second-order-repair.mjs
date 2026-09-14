import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

function replaceOnce(path, before, after) {
  const input = readFileSync(path, "utf8");
  const first = input.indexOf(before);
  if (first < 0) throw new Error(`missing replacement anchor in ${path}: ${before.slice(0, 80)}`);
  if (input.indexOf(before, first + before.length) >= 0) {
    throw new Error(`replacement anchor is not unique in ${path}: ${before.slice(0, 80)}`);
  }
  writeFileSync(path, input.slice(0, first) + after + input.slice(first + before.length));
}

function appendUnique(path, marker, content) {
  const input = readFileSync(path, "utf8");
  if (input.includes(marker)) return;
  appendFileSync(path, content);
}

// 1) Make the persisted-owner storage/read ceiling part of the machine-readable contract.
replaceOnce(
  "conformance/cases/local-file-lock.json",
  '    "owner_max_codepoints": 512,\n',
  '    "owner_max_codepoints": 512,\n    "owner_max_utf8_bytes": 2048,\n    "persisted_owner_requires_valid_utf8": true,\n    "inspection_entry_probe_limit": 2,\n',
);
replaceOnce(
  "scripts/check-local-file-corpus.mjs",
  '  owner_max_codepoints: 512,\n',
  '  owner_max_codepoints: 512,\n  owner_max_utf8_bytes: 2048,\n  persisted_owner_requires_valid_utf8: true,\n  inspection_entry_probe_limit: 2,\n',
);

// 2) Rust: bound release reads and revalidate the already-open file handle.
replaceOnce(
  "src/rust/local_file.rs",
  "use std::fs::{self, OpenOptions};\nuse std::io::{self, Write};\n",
  "use std::fs::{self, File, OpenOptions};\nuse std::io::{self, Read, Write};\n",
);
replaceOnce(
  "src/rust/local_file.rs",
  'const OWNER_MAX_CODEPOINTS: usize = 512;\n',
  'const OWNER_MAX_CODEPOINTS: usize = 512;\nconst OWNER_MAX_UTF8_BYTES: usize = 2048;\n',
);
replaceOnce(
  "src/rust/local_file.rs",
  `        let observed = match fs::read(&owner_path) {\n            Ok(observed) => observed,\n            Err(error) if error.kind() == io::ErrorKind::NotFound => {\n                return Err(LocalFileLockError::new(\n                    LocalFileLockErrorKind::Compromised,\n                    &self.path,\n                    "owner token is missing; refusing to treat externally altered lock state as a successful release",\n                ));\n            }\n            Err(error) => {\n                return Err(LocalFileLockError::io(\n                    &self.path,\n                    "read local lock owner token",\n                    error,\n                ));\n            }\n        };\n`,
  `        let observed = read_bounded_owner(&self.path, &owner_path)?;\n`,
);
replaceOnce(
  "src/rust/local_file.rs",
  `fn validate_owner(path: &Path, owner: &str) -> Result<(), LocalFileLockError> {\n`,
  `fn read_bounded_owner(\n    lock_path: &Path,\n    owner_path: &Path,\n) -> Result<Vec<u8>, LocalFileLockError> {\n    let mut owner_file = match File::open(owner_path) {\n        Ok(file) => file,\n        Err(error) if error.kind() == io::ErrorKind::NotFound => {\n            return Err(LocalFileLockError::new(\n                LocalFileLockErrorKind::Compromised,\n                lock_path,\n                "owner token is missing; refusing to treat externally altered lock state as a successful release",\n            ));\n        }\n        Err(error) => {\n            return Err(LocalFileLockError::io(\n                lock_path,\n                "open local lock owner token",\n                error,\n            ));\n        }\n    };\n    let opened_metadata = owner_file\n        .metadata()\n        .map_err(|error| LocalFileLockError::io(lock_path, "inspect opened owner token", error))?;\n    if !opened_metadata.is_file() || metadata_is_alias(&opened_metadata) {\n        return Err(LocalFileLockError::new(\n            LocalFileLockErrorKind::Compromised,\n            lock_path,\n            "opened owner token is not an unaliased regular file",\n        ));\n    }\n    if opened_metadata.len() > OWNER_MAX_UTF8_BYTES as u64 {\n        return Err(LocalFileLockError::new(\n            LocalFileLockErrorKind::Compromised,\n            lock_path,\n            "owner token exceeds the portable 2048-byte UTF-8 storage bound",\n        ));\n    }\n    let mut observed = Vec::with_capacity(OWNER_MAX_UTF8_BYTES + 1);\n    owner_file\n        .by_ref()\n        .take((OWNER_MAX_UTF8_BYTES + 1) as u64)\n        .read_to_end(&mut observed)\n        .map_err(|error| LocalFileLockError::io(lock_path, "read local lock owner token", error))?;\n    if observed.len() > OWNER_MAX_UTF8_BYTES {\n        return Err(LocalFileLockError::new(\n            LocalFileLockErrorKind::Compromised,\n            lock_path,\n            "owner token exceeds the portable 2048-byte UTF-8 storage bound",\n        ));\n    }\n    if std::str::from_utf8(&observed).is_err() {\n        return Err(LocalFileLockError::new(\n            LocalFileLockErrorKind::Compromised,\n            lock_path,\n            "owner token is not valid UTF-8",\n        ));\n    }\n    Ok(observed)\n}\n\nfn validate_owner(path: &Path, owner: &str) -> Result<(), LocalFileLockError> {\n`,
);
replaceOnce(
  "src/rust/local_file.rs",
  `    #[test]\n    fn unicode_nested_path_round_trips() {\n        let path = test_path("unicode").join("锁").join("paquete-ñ.lock");\n        let mut lock = LocalFileLock::try_acquire(&path, "owner-λ")\n            .expect("unicode acquire")\n            .expect("unicode holder");\n        assert_eq!(lock.owner(), "owner-λ");\n        lock.release().expect("unicode release");\n        assert!(!local_file_lock_exists(&path).expect("lock existence"));\n    }\n`,
  `    #[test]\n    fn release_bounds_persisted_owner_reads() {\n        let path = test_path("release-owner-bound");\n        let mut lock = LocalFileLock::try_acquire(&path, "owner-a")\n            .expect("acquire")\n            .expect("holder");\n        fs::write(path.join(OWNER_FILE), vec![b'a'; OWNER_MAX_UTF8_BYTES + 1])\n            .expect("write oversized owner");\n        let error = lock.release().expect_err("oversized owner must fail closed");\n        assert_eq!(error.kind, LocalFileLockErrorKind::Compromised);\n        fs::remove_file(path.join(OWNER_FILE)).expect("cleanup owner");\n        fs::remove_dir(&path).expect("cleanup lock");\n        lock.released = true;\n    }\n\n    #[test]\n    fn release_rejects_invalid_persisted_utf8() {\n        let path = test_path("release-owner-utf8");\n        let mut lock = LocalFileLock::try_acquire(&path, "owner-a")\n            .expect("acquire")\n            .expect("holder");\n        fs::write(path.join(OWNER_FILE), [0xff]).expect("write invalid UTF-8 owner");\n        let error = lock.release().expect_err("invalid UTF-8 owner must fail closed");\n        assert_eq!(error.kind, LocalFileLockErrorKind::Compromised);\n        fs::remove_file(path.join(OWNER_FILE)).expect("cleanup owner");\n        fs::remove_dir(&path).expect("cleanup lock");\n        lock.released = true;\n    }\n\n    #[test]\n    fn unicode_nested_path_round_trips() {\n        let path = test_path("unicode").join("锁").join("paquete-ñ.lock");\n        let mut lock = LocalFileLock::try_acquire(&path, "owner-λ")\n            .expect("unicode acquire")\n            .expect("unicode holder");\n        assert_eq!(lock.owner(), "owner-λ");\n        lock.release().expect("unicode release");\n        assert!(!local_file_lock_exists(&path).expect("lock existence"));\n    }\n`,
);

// 3) Rust inspection: stop after enough directory entries to prove dirty shape, and fstat the open owner.
replaceOnce(
  "src/rust/local_file_recovery.rs",
  `    let entries = fs::read_dir(path)\n        .map_err(|error| io_error(path, "list local lock directory", error))?\n        .collect::<Result<Vec<_>, _>>()\n        .map_err(|error| io_error(path, "read local lock directory entry", error))?;\n    if entries.len() != 1 || entries[0].file_name() != OWNER_FILE {\n        return Ok(compromised(\n            "lock directory must contain exactly one owner marker",\n        ));\n    }\n`,
  `    let mut entries = fs::read_dir(path)\n        .map_err(|error| io_error(path, "list local lock directory", error))?;\n    let first = entries\n        .next()\n        .transpose()\n        .map_err(|error| io_error(path, "read local lock directory entry", error))?;\n    let second = entries\n        .next()\n        .transpose()\n        .map_err(|error| io_error(path, "read second local lock directory entry", error))?;\n    let only_owner = first\n        .as_ref()\n        .map(|entry| entry.file_name().to_string_lossy() == OWNER_FILE)\n        .unwrap_or(false)\n        && second.is_none();\n    if !only_owner {\n        return Ok(compromised(\n            "lock directory must contain exactly one owner marker",\n        ));\n    }\n`,
);
replaceOnce(
  "src/rust/local_file_recovery.rs",
  `    let mut owner_file = File::open(&owner_path)\n        .map_err(|error| io_error(path, "open local lock owner token", error))?;\n    let mut owner_bytes = Vec::with_capacity(OWNER_MAX_UTF8_BYTES + 1);\n`,
  `    let mut owner_file = File::open(&owner_path)\n        .map_err(|error| io_error(path, "open local lock owner token", error))?;\n    let opened_metadata = owner_file\n        .metadata()\n        .map_err(|error| io_error(path, "inspect opened local lock owner token", error))?;\n    if !opened_metadata.is_file() || metadata_is_alias(&opened_metadata) {\n        return Ok(compromised(\n            "opened owner token is not an unaliased regular file",\n        ));\n    }\n    let mut owner_bytes = Vec::with_capacity(OWNER_MAX_UTF8_BYTES + 1);\n`,
);

// 4) Go release: bounded read + fstat/UTF-8 checks.
replaceOnce(
  "src/go/local_file.go",
  'import (\n\t"errors"\n\t"fmt"\n',
  'import (\n\t"errors"\n\t"fmt"\n\t"io"\n',
);
replaceOnce(
  "src/go/local_file.go",
  'const localFileOwnerName = "owner"\nconst localFileOwnerMaxCodepoints = 512\n',
  'const localFileOwnerName = "owner"\nconst localFileOwnerMaxCodepoints = 512\nconst localFileOwnerMaxUTF8Bytes = 2048\n',
);
replaceOnce(
  "src/go/local_file.go",
  `\tobserved, err := os.ReadFile(ownerPath)\n\tif err != nil {\n\t\tif errors.Is(err, os.ErrNotExist) {\n\t\t\treturn localFileError(LocalFileCompromised, l.path, "owner token is missing; refusing to treat externally altered lock state as a successful release", err)\n\t\t}\n\t\treturn localFileError(LocalFileIO, l.path, "read local lock owner token failed", err)\n\t}\n`,
  `\tobserved, err := readLocalFileOwnerBounded(l.path, ownerPath)\n\tif err != nil {\n\t\treturn err\n\t}\n`,
);
replaceOnce(
  "src/go/local_file.go",
  `func validateLocalOwner(path, owner string) error {\n`,
  `func readLocalFileOwnerBounded(lockPath, ownerPath string) ([]byte, error) {\n\townerFile, err := os.Open(ownerPath)\n\tif err != nil {\n\t\tif errors.Is(err, os.ErrNotExist) {\n\t\t\treturn nil, localFileError(LocalFileCompromised, lockPath, "owner token is missing; refusing to treat externally altered lock state as a successful release", err)\n\t\t}\n\t\treturn nil, localFileError(LocalFileIO, lockPath, "open local lock owner token failed", err)\n\t}\n\tinfo, err := ownerFile.Stat()\n\tif err != nil {\n\t\t_ = ownerFile.Close()\n\t\treturn nil, localFileError(LocalFileIO, lockPath, "inspect opened local lock owner token failed", err)\n\t}\n\tif !info.Mode().IsRegular() {\n\t\t_ = ownerFile.Close()\n\t\treturn nil, localFileError(LocalFileCompromised, lockPath, "opened owner token is not a regular file", nil)\n\t}\n\tif info.Size() > localFileOwnerMaxUTF8Bytes {\n\t\t_ = ownerFile.Close()\n\t\treturn nil, localFileError(LocalFileCompromised, lockPath, "owner token exceeds the portable 2048-byte UTF-8 storage bound", nil)\n\t}\n\tobserved, err := io.ReadAll(io.LimitReader(ownerFile, localFileOwnerMaxUTF8Bytes+1))\n\tif err != nil {\n\t\t_ = ownerFile.Close()\n\t\treturn nil, localFileError(LocalFileIO, lockPath, "read local lock owner token failed", err)\n\t}\n\tif err := ownerFile.Close(); err != nil {\n\t\treturn nil, localFileError(LocalFileIO, lockPath, "close local lock owner token failed", err)\n\t}\n\tif len(observed) > localFileOwnerMaxUTF8Bytes {\n\t\treturn nil, localFileError(LocalFileCompromised, lockPath, "owner token exceeds the portable 2048-byte UTF-8 storage bound", nil)\n\t}\n\tif !utf8.Valid(observed) {\n\t\treturn nil, localFileError(LocalFileCompromised, lockPath, "owner token is not valid UTF-8", nil)\n\t}\n\treturn observed, nil\n}\n\nfunc validateLocalOwner(path, owner string) error {\n`,
);

// 5) Go inspection: bounded two-entry probe and post-open fstat.
replaceOnce(
  "src/go/local_file_recovery.go",
  'const localFileOwnerMaxUTF8Bytes = 2048\n\n',
  '',
);
replaceOnce(
  "src/go/local_file_recovery.go",
  `\tentries, err := os.ReadDir(path)\n\tif err != nil {\n\t\treturn LocalFileLockInspection{}, localFileError(LocalFileIO, path, "list local lock directory failed", err)\n\t}\n\tif len(entries) != 1 || entries[0].Name() != localFileOwnerName {\n\t\treturn compromisedInspection("lock directory must contain exactly one owner marker"), nil\n\t}\n`,
  `\tdirectory, err := os.Open(path)\n\tif err != nil {\n\t\treturn LocalFileLockInspection{}, localFileError(LocalFileIO, path, "open local lock directory failed", err)\n\t}\n\tnames, readErr := directory.Readdirnames(2)\n\tcloseErr := directory.Close()\n\tif readErr != nil && !errors.Is(readErr, io.EOF) {\n\t\treturn LocalFileLockInspection{}, localFileError(LocalFileIO, path, "read local lock directory entry failed", readErr)\n\t}\n\tif closeErr != nil {\n\t\treturn LocalFileLockInspection{}, localFileError(LocalFileIO, path, "close local lock directory failed", closeErr)\n\t}\n\tif len(names) != 1 || names[0] != localFileOwnerName {\n\t\treturn compromisedInspection("lock directory must contain exactly one owner marker"), nil\n\t}\n`,
);
replaceOnce(
  "src/go/local_file_recovery.go",
  `\townerFile, err := os.Open(ownerPath)\n\tif err != nil {\n`,
  `\townerFile, err := os.Open(ownerPath)\n\tif err != nil {\n`,
);
replaceOnce(
  "src/go/local_file_recovery.go",
  `\towner, readErr := io.ReadAll(io.LimitReader(ownerFile, localFileOwnerMaxUTF8Bytes+1))\n`,
  `\topenedInfo, statErr := ownerFile.Stat()\n\tif statErr != nil {\n\t\t_ = ownerFile.Close()\n\t\treturn LocalFileLockInspection{}, localFileError(LocalFileIO, path, "inspect opened local lock owner token failed", statErr)\n\t}\n\tif !openedInfo.Mode().IsRegular() {\n\t\t_ = ownerFile.Close()\n\t\treturn compromisedInspection("opened owner token is not a regular file"), nil\n\t}\n\towner, readErr := io.ReadAll(io.LimitReader(ownerFile, localFileOwnerMaxUTF8Bytes+1))\n`,
);

// 6) TypeScript release: bound read, fstat the opened handle, and reject lone UTF-16 surrogates.
replaceOnce(
  "src/ts/src/local-file.ts",
  'import { lstat, mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";\n',
  'import { lstat, mkdir, open, rmdir, unlink, writeFile } from "node:fs/promises";\n',
);
replaceOnce(
  "src/ts/src/local-file.ts",
  'export const MAX_LOCAL_FILE_LOCK_OWNER_CODEPOINTS = 512;\n',
  'export const MAX_LOCAL_FILE_LOCK_OWNER_CODEPOINTS = 512;\nexport const MAX_LOCAL_FILE_LOCK_OWNER_UTF8_BYTES = 2048;\n',
);
replaceOnce(
  "src/ts/src/local-file.ts",
  `    let observed: string;\n    try {\n      observed = await readFile(owner_path, "utf8");\n    } catch (error) {\n      if (error_code(error) === "ENOENT") {\n        throw new LocalFileLockError(\n          "compromised",\n          this.path,\n          "owner token is missing; refusing to treat externally altered lock state as a successful release",\n          error,\n        );\n      }\n      throw io_error(this.path, "read local lock owner token", error);\n    }\n`,
  `    const observed = await read_bounded_utf8_owner(this.path, owner_path);\n`,
);
replaceOnce(
  "src/ts/src/local-file.ts",
  `  if (Array.from(owner).length > MAX_LOCAL_FILE_LOCK_OWNER_CODEPOINTS) {\n`,
  `  if (!is_unicode_scalar_sequence(owner)) {\n    throw new LocalFileLockError(\n      "invalid_input",\n      path,\n      "owner token must be a valid Unicode scalar-value sequence",\n    );\n  }\n  if (Array.from(owner).length > MAX_LOCAL_FILE_LOCK_OWNER_CODEPOINTS) {\n`,
);
replaceOnce(
  "src/ts/src/local-file.ts",
  `function sleep(ms: number): Promise<void> {\n`,
  `function is_unicode_scalar_sequence(value: string): boolean {\n  for (let index = 0; index < value.length; index += 1) {\n    const unit = value.charCodeAt(index);\n    if (unit >= 0xd800 && unit <= 0xdbff) {\n      const next = value.charCodeAt(index + 1);\n      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;\n      index += 1;\n    } else if (unit >= 0xdc00 && unit <= 0xdfff) {\n      return false;\n    }\n  }\n  return true;\n}\n\nasync function read_bounded_utf8_owner(lockPath: string, ownerPath: string): Promise<string> {\n  let handle;\n  try {\n    handle = await open(ownerPath, "r");\n    const openedMetadata = await handle.stat();\n    if (!openedMetadata.isFile() || openedMetadata.isSymbolicLink()) {\n      throw new LocalFileLockError(\n        "compromised",\n        lockPath,\n        "opened owner token is not an unaliased regular file",\n      );\n    }\n    if (openedMetadata.size > MAX_LOCAL_FILE_LOCK_OWNER_UTF8_BYTES) {\n      throw new LocalFileLockError(\n        "compromised",\n        lockPath,\n        "owner token exceeds the portable 2048-byte UTF-8 storage bound",\n      );\n    }\n    const buffer = new Uint8Array(MAX_LOCAL_FILE_LOCK_OWNER_UTF8_BYTES + 1);\n    let total = 0;\n    while (total < buffer.byteLength) {\n      const { bytesRead } = await handle.read(buffer, total, buffer.byteLength - total, total);\n      if (bytesRead === 0) break;\n      total += bytesRead;\n    }\n    if (total > MAX_LOCAL_FILE_LOCK_OWNER_UTF8_BYTES) {\n      throw new LocalFileLockError(\n        "compromised",\n        lockPath,\n        "owner token exceeds the portable 2048-byte UTF-8 storage bound",\n      );\n    }\n    try {\n      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total));\n    } catch (error) {\n      throw new LocalFileLockError(\n        "compromised",\n        lockPath,\n        "owner token is not valid UTF-8",\n        error,\n      );\n    }\n  } catch (error) {\n    if (error instanceof LocalFileLockError) throw error;\n    if (error_code(error) === "ENOENT") {\n      throw new LocalFileLockError(\n        "compromised",\n        lockPath,\n        "owner token is missing; refusing to treat externally altered lock state as a successful release",\n        error,\n      );\n    }\n    throw io_error(lockPath, "read local lock owner token", error);\n  } finally {\n    await handle?.close();\n  }\n}\n\nfunction sleep(ms: number): Promise<void> {\n`,
);

// 7) TypeScript inspection: two-entry directory probe, shared byte bound, post-open fstat.
replaceOnce(
  "src/ts/src/local-file-recovery.ts",
  'import { lstat, open, readdir, rmdir, unlink } from "node:fs/promises";\n',
  'import { lstat, open, opendir, rmdir, unlink } from "node:fs/promises";\n',
);
replaceOnce(
  "src/ts/src/local-file-recovery.ts",
  `import {\n  LocalFileLockError,\n  MAX_LOCAL_FILE_LOCK_OWNER_CODEPOINTS,\n} from "./local-file.js";\n\nconst OWNER_FILE = "owner";\nexport const MAX_LOCAL_FILE_LOCK_OWNER_UTF8_BYTES = 2048;\n`,
  `import {\n  LocalFileLockError,\n  MAX_LOCAL_FILE_LOCK_OWNER_CODEPOINTS,\n  MAX_LOCAL_FILE_LOCK_OWNER_UTF8_BYTES,\n} from "./local-file.js";\n\nconst OWNER_FILE = "owner";\n`,
);
replaceOnce(
  "src/ts/src/local-file-recovery.ts",
  `  let entries: string[];\n  try {\n    entries = await readdir(path);\n  } catch (error) {\n    throw io_error(path, "list local lock directory", error);\n  }\n  if (entries.length !== 1 || entries[0] !== OWNER_FILE) {\n    return compromised("lock directory must contain exactly one owner marker");\n  }\n`,
  `  let directory;\n  try {\n    directory = await opendir(path);\n    const first = await directory.read();\n    const second = await directory.read();\n    if (first?.name !== OWNER_FILE || second !== null) {\n      return compromised("lock directory must contain exactly one owner marker");\n    }\n  } catch (error) {\n    throw io_error(path, "list local lock directory", error);\n  } finally {\n    await directory?.close();\n  }\n`,
);
replaceOnce(
  "src/ts/src/local-file-recovery.ts",
  `    handle = await open(ownerPath, "r");\n    const buffer = new Uint8Array(MAX_LOCAL_FILE_LOCK_OWNER_UTF8_BYTES + 1);\n`,
  `    handle = await open(ownerPath, "r");\n    const openedMetadata = await handle.stat();\n    if (!openedMetadata.isFile() || openedMetadata.isSymbolicLink()) {\n      throw new LocalFileLockError(\n        "compromised",\n        lockPath,\n        "opened owner token is not an unaliased regular file",\n      );\n    }\n    const buffer = new Uint8Array(MAX_LOCAL_FILE_LOCK_OWNER_UTF8_BYTES + 1);\n`,
);
replaceOnce(
  "src/ts/src/local-file-node-shims.d.ts",
  `  interface LocalFileHandle {\n    read(\n      buffer: Uint8Array,\n      offset: number,\n      length: number,\n      position: number,\n    ): Promise<{ bytesRead: number; buffer: Uint8Array }>;\n    close(): Promise<void>;\n  }\n`,
  `  interface LocalFileHandle {\n    read(\n      buffer: Uint8Array,\n      offset: number,\n      length: number,\n      position: number,\n    ): Promise<{ bytesRead: number; buffer: Uint8Array }>;\n    stat(): Promise<LocalFileStats>;\n    close(): Promise<void>;\n  }\n\n  interface LocalDirent {\n    readonly name: string;\n  }\n\n  interface LocalDir {\n    read(): Promise<LocalDirent | null>;\n    close(): Promise<void>;\n  }\n`,
);
replaceOnce(
  "src/ts/src/local-file-node-shims.d.ts",
  `  export function open(path: string, flags: string): Promise<LocalFileHandle>;\n\n  export function readFile(path: string, encoding: "utf8"): Promise<string>;\n`,
  `  export function open(path: string, flags: string): Promise<LocalFileHandle>;\n\n  export function opendir(path: string): Promise<LocalDir>;\n\n  export function readFile(path: string, encoding: "utf8"): Promise<string>;\n`,
);

// 8) TypeScript regressions for release read bounds and lone surrogate admission.
appendUnique(
  "src/ts/test/local-file-adversarial-v2.test.mjs",
  'test("release bounds persisted owner-marker reads"',
  `\n\ntest("release bounds persisted owner-marker reads", async () => {\n  await withTempDir(async (root) => {\n    const path = join(root, "install.lock");\n    const lock = await try_acquire_local_file_lock(path, "owner-a");\n    assert.ok(lock);\n    await writeFile(join(path, "owner"), "a".repeat(2049), { mode: 0o600 });\n    await assert.rejects(\n      lock.release(),\n      (error) => error instanceof LocalFileLockError\n        && error.kind === "compromised"\n        && /2048-byte/.test(error.message),\n    );\n  });\n});\n\ntest("owner input rejects lone UTF-16 surrogates", async () => {\n  await withTempDir(async (root) => {\n    const path = join(root, "install.lock");\n    for (const owner of ["\\ud800", "\\udfff", "a\\ud800b"]) {\n      await assert.rejects(\n        try_acquire_local_file_lock(path, owner),\n        (error) => error instanceof LocalFileLockError && error.kind === "invalid_input",\n      );\n    }\n  });\n});\n`,
);

// 9) Go regressions for normal release bounds and invalid persisted UTF-8.
writeFileSync(
  "src/go/local_file_second_order_test.go",
  `package oreslocks\n\nimport (\n\t"os"\n\t"path/filepath"\n\t"testing"\n)\n\nfunc TestLocalFileReleaseBoundsPersistedOwner(t *testing.T) {\n\tfor _, tc := range []struct {\n\t\tname string\n\t\tdata []byte\n\t}{\n\t\t{name: "oversized", data: []byte(string(make([]byte, 0)))},\n\t\t{name: "invalid-utf8", data: []byte{0xff}},\n\t} {\n\t\tt.Run(tc.name, func(t *testing.T) {\n\t\t\tpath := filepath.Join(t.TempDir(), "install.lock")\n\t\t\tlock, acquired, err := TryAcquireLocalFileLock(path, "owner-a")\n\t\t\tif err != nil || !acquired {\n\t\t\t\tt.Fatalf("acquire: acquired=%v err=%v", acquired, err)\n\t\t\t}\n\t\t\tdata := tc.data\n\t\t\tif tc.name == "oversized" {\n\t\t\t\tdata = make([]byte, localFileOwnerMaxUTF8Bytes+1)\n\t\t\t\tfor i := range data { data[i] = 'a' }\n\t\t\t}\n\t\t\tif err := os.WriteFile(filepath.Join(path, localFileOwnerName), data, 0o600); err != nil {\n\t\t\t\tt.Fatal(err)\n\t\t\t}\n\t\t\terr = lock.Release()\n\t\t\tvar localErr *LocalFileLockError\n\t\t\tif err == nil || !errorsAsLocalFile(err, &localErr) || localErr.Kind != LocalFileCompromised {\n\t\t\t\tt.Fatalf("expected compromised release, got %v", err)\n\t\t\t}\n\t\t})\n\t}\n}\n\nfunc errorsAsLocalFile(err error, target **LocalFileLockError) bool {\n\tlocal, ok := err.(*LocalFileLockError)\n\tif !ok { return false }\n\t*target = local\n\treturn true\n}\n`,
);

// 10) Gleam release: bounded owner reads live in the Erlang FFI so simplifile.read cannot allocate arbitrary state.
replaceOnce(
  "src/gleam/src/ores_locks_and_leases/local_file.gleam",
  'const owner_max_codepoints = 512\n',
  'const owner_max_codepoints = 512\n\nconst owner_max_utf8_bytes = 2048\n',
);
replaceOnce(
  "src/gleam/src/ores_locks_and_leases/local_file.gleam",
  `  case simplifile.read(owner_path) {\n    Ok(observed) if observed == lock.owner ->\n      remove_owned_lock(path, owner_path)\n    Ok(_) ->\n      Error(LocalFileLockError(\n        Compromised,\n        path,\n        "owner token changed; refusing to remove a lock that may belong to another acquisition",\n      ))\n    Error(simplifile.Enoent) ->\n      Error(LocalFileLockError(\n        Compromised,\n        path,\n        "owner token is missing; refusing to treat externally altered lock state as a successful release",\n      ))\n    Error(error) ->\n      Error(io_error(\n        path,\n        "read local lock owner token failed: "\n          <> simplifile.describe_error(error),\n      ))\n  }\n`,
  `  case read_owner_for_release_status(owner_path, lock.owner, owner_max_utf8_bytes) {\n    0 -> remove_owned_lock(path, owner_path)\n    1 ->\n      Error(LocalFileLockError(\n        Compromised,\n        path,\n        "owner token changed; refusing to remove a lock that may belong to another acquisition",\n      ))\n    2 ->\n      Error(LocalFileLockError(\n        Compromised,\n        path,\n        "owner token exceeds the portable 2048-byte UTF-8 storage bound",\n      ))\n    3 ->\n      Error(LocalFileLockError(\n        Compromised,\n        path,\n        "owner token is not valid UTF-8",\n      ))\n    4 ->\n      Error(LocalFileLockError(\n        Compromised,\n        path,\n        "owner token is missing; refusing to treat externally altered lock state as a successful release",\n      ))\n    _ -> Error(io_error(path, "read local lock owner token failed"))\n  }\n`,
);
replaceOnce(
  "src/gleam/src/ores_locks_and_leases/local_file.gleam",
  `@external(erlang, "ores_locks_and_leases_local_file_ffi", "unicode_codepoint_count")\nfn unicode_codepoint_count(value: String) -> Int\n`,
  `@external(erlang, "ores_locks_and_leases_local_file_ffi", "unicode_codepoint_count")\nfn unicode_codepoint_count(value: String) -> Int\n\n@external(erlang, "ores_locks_and_leases_local_file_ffi", "read_owner_for_release_status")\nfn read_owner_for_release_status(path: String, expected_owner: String, max_bytes: Int) -> Int\n`,
);
replaceOnce(
  "src/gleam/src/ores_locks_and_leases_local_file_ffi.erl",
  `    unicode_codepoint_count/1,\n    owner_private_mode_status/1\n`,
  `    unicode_codepoint_count/1,\n    owner_private_mode_status/1,\n    read_owner_for_release_status/3\n`,
);
appendUnique(
  "src/gleam/src/ores_locks_and_leases_local_file_ffi.erl",
  "read_owner_for_release_status(Path, ExpectedOwner, MaxBytes)",
  `\n\n%% Bounded release read. Status: 0 match, 1 mismatch, 2 oversized,\n%% 3 invalid UTF-8, 4 missing, 5 other IO/close failure.\nread_owner_for_release_status(Path, ExpectedOwner, MaxBytes) ->\n    case file:open(Path, [read, binary]) of\n        {error, enoent} -> 4;\n        {error, _} -> 5;\n        {ok, IoDevice} ->\n            Result = read_owner_bounded(IoDevice, MaxBytes + 1, <<>>),\n            CloseResult = file:close(IoDevice),\n            case {Result, CloseResult} of\n                {{ok, Bytes}, ok} when byte_size(Bytes) > MaxBytes -> 2;\n                {{ok, Bytes}, ok} ->\n                    case unicode:characters_to_list(Bytes, utf8) of\n                        {error, _, _} -> 3;\n                        {incomplete, _, _} -> 3;\n                        _ ->\n                            case Bytes =:= unicode:characters_to_binary(ExpectedOwner) of\n                                true -> 0;\n                                false -> 1\n                            end\n                    end;\n                {{error, enoent}, _} -> 4;\n                _ -> 5\n            end\n    end.\n\nread_owner_bounded(_IoDevice, Remaining, Acc) when Remaining =< 0 -> {ok, Acc};\nread_owner_bounded(IoDevice, Remaining, Acc) ->\n    case file:read(IoDevice, Remaining) of\n        eof -> {ok, Acc};\n        {ok, Bytes} -> read_owner_bounded(IoDevice, Remaining - byte_size(Bytes), <<Acc/binary, Bytes/binary>>);\n        {error, Reason} -> {error, Reason}\n    end.\n`,
);

console.log("DEN-2037 second-order local-lock repair applied");
