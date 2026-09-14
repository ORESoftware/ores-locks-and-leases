import { readFileSync, writeFileSync } from "node:fs";

const path = "src/rust/local_file.rs";
const before = `    owner_file\n        .by_ref()\n        .take((OWNER_MAX_UTF8_BYTES + 1) as u64)\n        .read_to_end(&mut observed)\n`;
const after = `    std::io::Read::by_ref(&mut owner_file)\n        .take((OWNER_MAX_UTF8_BYTES + 1) as u64)\n        .read_to_end(&mut observed)\n`;
const input = readFileSync(path, "utf8");
if (!input.includes(before)) {
  throw new Error("Rust bounded-reader hotfix anchor not found");
}
if (input.indexOf(before) !== input.lastIndexOf(before)) {
  throw new Error("Rust bounded-reader hotfix anchor is not unique");
}
writeFileSync(path, input.replace(before, after));
console.log("DEN-2037 bounded Rust reader disambiguated");
