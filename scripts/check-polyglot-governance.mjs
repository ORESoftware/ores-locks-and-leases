#!/usr/bin/env node
import { lstatSync, readFileSync, readdirSync } from 'node:fs';

const fail = (message) => { throw new Error(`[polyglot-governance] ${message}`); };
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const realFile = (path) => {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${path} must be a real file`);
};
const realDir = (path) => {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${path} must be a real directory`);
};

const path = 'governance/polyglot-participants.v1.json';
realFile(path);
const governance = json(path);

if (governance.schema !== 'ores.locks.polyglot-governance/v1') fail('unsupported governance schema');
if (process.env.GITHUB_REPOSITORY && governance.repository !== process.env.GITHUB_REPOSITORY) {
  fail(`repository mismatch: ${governance.repository}`);
}

for (const requiredPath of [
  governance.languageBoundaries,
  governance.primaryWorkflow,
  governance.contractRuntimeWorkflow,
  governance.tjsvRuntimeWorkflow,
]) realFile(requiredPath);

if (!Array.isArray(governance.participants) || governance.participants.length < 2) {
  fail('at least two governed participants are required');
}

const ids = new Set();
const sourceDirs = new Set();
const boundaryNames = new Set();
for (const participant of governance.participants) {
  for (const field of ['id', 'sourceDir', 'boundaryLanguage', 'ciJob', 'contractRuntimeJob', 'tjsvStepId']) {
    if (typeof participant?.[field] !== 'string' || participant[field].length === 0) {
      fail(`participant missing ${field}`);
    }
  }
  if (ids.has(participant.id)) fail(`duplicate participant id: ${participant.id}`);
  if (sourceDirs.has(participant.sourceDir)) fail(`duplicate participant sourceDir: ${participant.sourceDir}`);
  if (boundaryNames.has(participant.boundaryLanguage)) fail(`duplicate boundary language: ${participant.boundaryLanguage}`);
  ids.add(participant.id);
  sourceDirs.add(participant.sourceDir);
  boundaryNames.add(participant.boundaryLanguage);
  realDir(participant.sourceDir);
}

const actualSourceDirs = readdirSync(governance.sourceRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
  .map((entry) => `${governance.sourceRoot}/${entry.name}`)
  .sort();
const declaredSourceDirs = [...sourceDirs].sort();
if (JSON.stringify(actualSourceDirs) !== JSON.stringify(declaredSourceDirs)) {
  fail(`source runtime drift; declared=${declaredSourceDirs.join(',')} actual=${actualSourceDirs.join(',')}`);
}

const boundaries = json(governance.languageBoundaries);
if (boundaries.schema !== 'ores.typespec-json-schema-validator.language-boundaries/v1') {
  fail('unsupported language-boundary schema');
}
if (boundaries.minimumDistinctLanguages !== ids.size) {
  fail(`minimumDistinctLanguages must equal governed participant count (${ids.size})`);
}
if (boundaries.authorities?.typeSpec !== 'peer'
  || boundaries.authorities?.jsonSchema !== 'peer'
  || boundaries.authorities?.generatedWitness !== 'evidence_only') {
  fail('contract authority policy drifted');
}
const requiredBoundaries = new Set((boundaries.targets || [])
  .filter((target) => target.required && target.ingress && target.egress)
  .map((target) => target.language));
if (requiredBoundaries.size !== ids.size) fail('required boundary count differs from governed participant count');
for (const language of boundaryNames) {
  if (!requiredBoundaries.has(language)) fail(`governed language missing required bidirectional boundary: ${language}`);
}
for (const language of requiredBoundaries) {
  if (!boundaryNames.has(language)) fail(`required boundary missing governance participant: ${language}`);
}

const primary = readFileSync(governance.primaryWorkflow, 'utf8');
const contractRuntime = readFileSync(governance.contractRuntimeWorkflow, 'utf8');
const tjsvRuntime = readFileSync(governance.tjsvRuntimeWorkflow, 'utf8');

for (const participant of governance.participants) {
  if (!primary.includes(`\n  ${participant.ciJob}:\n`)) {
    fail(`primary CI job missing for ${participant.id}: ${participant.ciJob}`);
  }
  if (!contractRuntime.includes(`\n  ${participant.contractRuntimeJob}:\n`)) {
    fail(`contract/runtime CI job missing for ${participant.id}: ${participant.contractRuntimeJob}`);
  }
  if (!tjsvRuntime.includes(`id: ${participant.tjsvStepId}\n`)) {
    fail(`TJSV runtime step missing for ${participant.id}: ${participant.tjsvStepId}`);
  }
}

for (const workflow of [primary, contractRuntime, tjsvRuntime]) {
  if (!workflow.includes('scripts/check-polyglot-governance.mjs')) {
    fail('a required workflow does not execute the polyglot governance gate');
  }
}

console.log(`polyglot governance OK (${ids.size} required runtimes)`);
