import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const [reportArgument] = process.argv.slice(2);
assert.ok(reportArgument, "usage: check-stale-mapping-receipt.mjs <report.json>");

const report = JSON.parse(await readFile(resolve(reportArgument), "utf8"));
assert.equal(report.schema, "ores.typespec-json-schema-validator.report/v1");
assert.equal(report.status, "stopped_for_evaluation");
assert.equal(report.authorities?.precedence, "none");
assert.equal(
  report.authorities?.onUnexplainedMismatch,
  "STOPPED_FOR_EVALUATION",
);
assert.ok(Array.isArray(report.findings));

const mappingFindings = report.findings.filter(
  (finding) => finding.ruleId === "mapping-typespec-declaration-missing",
);
assert.equal(
  mappingFindings.length,
  1,
  "the stale mapping fixture must emit exactly one attributable mapping finding",
);
const [finding] = mappingFindings;
assert.equal(finding.comparison, "mapping-integrity");
assert.equal(
  finding.declaration,
  "Ores.LocksAndLeases.MissingLeaseGrant",
);
assert.equal(finding.resolutionState, "unexplained");
assert.match(finding.fingerprint, /^[0-9a-f]{64}$/u);
assert.equal(
  report.findings.some((entry) => entry.ruleId === "run-failed"),
  false,
  "mapping drift must not be collapsed into a generic execution failure",
);
assert.equal(
  report.findings.some((entry) => entry.ruleId === "mapping-target-collision"),
  false,
  "the fixture isolates stale-source mapping behavior",
);

process.stdout.write(
  JSON.stringify(
    {
      declaration: finding.declaration,
      findingCount: report.findingCount,
      ruleId: finding.ruleId,
      runId: report.runId,
      status: report.status,
    },
    null,
    2,
  ) + "\n",
);
