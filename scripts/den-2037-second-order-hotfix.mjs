import { readFileSync, writeFileSync } from "node:fs";

function replaceOnce(path, before, after) {
  const input = readFileSync(path, "utf8");
  if (!input.includes(before)) throw new Error(`hotfix anchor not found in ${path}`);
  if (input.indexOf(before) !== input.lastIndexOf(before)) throw new Error(`hotfix anchor is not unique in ${path}`);
  writeFileSync(path, input.replace(before, after));
}

replaceOnce(
  "src/rust/local_file.rs",
  `    owner_file\n        .by_ref()\n        .take((OWNER_MAX_UTF8_BYTES + 1) as u64)\n        .read_to_end(&mut observed)\n`,
  `    std::io::Read::by_ref(&mut owner_file)\n        .take((OWNER_MAX_UTF8_BYTES + 1) as u64)\n        .read_to_end(&mut observed)\n`,
);

replaceOnce(
  "src/go/local_file_recovery.go",
  `\tcloseErr := directory.Close()\n\tif readErr != nil && !errors.Is(readErr, io.EOF) {\n\t\treturn LocalFileLockInspection{}, localFileError(LocalFileIO, path, "read local lock directory entry failed", readErr)\n\t}\n\tif closeErr != nil {\n\t\treturn LocalFileLockInspection{}, localFileError(LocalFileIO, path, "close local lock directory failed", closeErr)\n\t}\n`,
  `\tdirectoryCloseErr := directory.Close()\n\tif readErr != nil && !errors.Is(readErr, io.EOF) {\n\t\treturn LocalFileLockInspection{}, localFileError(LocalFileIO, path, "read local lock directory entry failed", readErr)\n\t}\n\tif directoryCloseErr != nil {\n\t\treturn LocalFileLockInspection{}, localFileError(LocalFileIO, path, "close local lock directory failed", directoryCloseErr)\n\t}\n`,
);

console.log("DEN-2037 Rust and Go repair hotfixes applied");
