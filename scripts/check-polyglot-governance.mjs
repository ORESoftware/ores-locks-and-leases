#!/usr/bin/env node
import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const root = process.cwd();
const registryPath = 'governance/polyglot-participants.v1.json';

function fail(message) { throw new Error(message); }
function sorted(values) { return [...values].sort((a, b) => String(a).localeCompare(String(b))); }
function normalize(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || isAbsolute(value)) {
    fail(`${label} must be a non-empty repository-relative path`);
  }
  const absolute = resolve(root, value);
  const rel = relative(root, absolute);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail(`${label} escapes repository root: ${value}`);
  return rel.split(sep).join('/');
}
async function readText(path, label = path) {
  const rel = normalize(path, label);
  const info = await lstat(resolve(root, rel));
  if (!info.isFile() || info.isSymbolicLink()) fail(`${label} must be a real file: ${rel}`);
  return readFile(resolve(root, rel), 'utf8');
}
async function readJson(path, label = path) { return JSON.parse(await readText(path, label)); }
async function realDirectory(path, label = path) {
  const rel = normalize(path, label);
  const info = await lstat(resolve(root, rel));
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${label} must be a real directory: ${rel}`);
  return rel;
}
function workflowJobBlock(workflow, jobName) {
  const lines = workflow.split(/\r?\n/);
  const marker = `  ${jobName}:`;
  const start = lines.findIndex((line) => line === marker);
  if (start < 0) fail(`missing CI job: ${jobName}`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:$/.test(lines[index])) { end = index; break; }
  }
  return lines.slice(start, end).join('\n');
}
function participantLanguage(participant, field) {
  const value = participant[field] ?? participant.id;
  if (typeof value !== 'string' || value.length === 0) fail(`${participant.id}.${field} must be a non-empty string`);
  return value;
}

try {
  const registry = await readJson(registryPath, 'polyglot governance registry');
  assert.equal(registry.schema, 'ores.polyglot-governance/v1', 'unexpected governance schema');
  if (typeof registry.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(registry.repository)) fail('repository must be owner/name');
  if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY !== registry.repository) {
    fail(`registry repository ${registry.repository} does not match CI repository ${process.env.GITHUB_REPOSITORY}`);
  }
  const policy = registry.policy ?? {};
  for (const key of ['allSourceDirectoriesMustBeGoverned', 'ciExercisesEveryParticipant', 'missingOrExtraParticipantFailsClosed']) {
    assert.equal(policy[key], true, `policy.${key} must be true`);
  }

  const sourceRoot = await realDirectory(registry.sourceRoot ?? 'src', 'sourceRoot');
  await realDirectory('governance', 'governance');
  if (!Array.isArray(registry.participants) || registry.participants.length === 0) fail('participants must be non-empty');
  if (!Array.isArray(registry.ignoredSourceDirectories)) fail('ignoredSourceDirectories must be an array');

  const ids = new Set();
  const participantDirs = new Set();
  for (const participant of registry.participants) {
    if (!participant || typeof participant !== 'object' || Array.isArray(participant)) fail('participant must be an object');
    if (typeof participant.id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(participant.id)) fail(`invalid participant id: ${participant?.id}`);
    if (ids.has(participant.id)) fail(`duplicate participant id: ${participant.id}`);
    ids.add(participant.id);
    const sourceDir = await realDirectory(participant.sourceDir, `${participant.id}.sourceDir`);
    if (!sourceDir.startsWith(`${sourceRoot}/`) || sourceDir.split('/').length !== sourceRoot.split('/').length + 1) {
      fail(`${participant.id}.sourceDir must be an immediate child of ${sourceRoot}/`);
    }
    if (participantDirs.has(sourceDir)) fail(`duplicate participant sourceDir: ${sourceDir}`);
    participantDirs.add(sourceDir);
    if (typeof participant.ciJob !== 'string' || participant.ciJob.length === 0) fail(`${participant.id}.ciJob is required`);
    if (!Array.isArray(participant.requiredCiTokens) || participant.requiredCiTokens.length === 0) fail(`${participant.id}.requiredCiTokens must be non-empty`);
  }

  const ignoredDirs = new Set();
  for (const entry of registry.ignoredSourceDirectories) {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || !entry.name || typeof entry.reason !== 'string' || !entry.reason.trim()) {
      fail('ignoredSourceDirectories entries require name and reason');
    }
    if (ignoredDirs.has(entry.name)) fail(`duplicate ignored source directory: ${entry.name}`);
    if (entry.owner && !ids.has(entry.owner)) fail(`ignored source directory ${entry.name} has unknown owner ${entry.owner}`);
    ignoredDirs.add(entry.name);
  }

  const entries = await readdir(resolve(root, sourceRoot), { withFileTypes: true });
  const discoveredDirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const absolute = resolve(root, sourceRoot, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) fail(`symbolic links are forbidden in ${sourceRoot}/: ${entry.name}`);
    discoveredDirs.push(`${sourceRoot}/${entry.name}`);
  }
  const governed = new Set([...participantDirs, ...[...ignoredDirs].map((name) => `${sourceRoot}/${name}`)]);
  assert.deepEqual(sorted(discoveredDirs), sorted(governed), `every immediate ${sourceRoot}/ directory must be governed or explicitly ignored`);

  const workflowPath = normalize(registry.workflow, 'workflow');
  const workflow = await readText(workflowPath, 'workflow');
  for (const token of registry.requiredWorkflowTokens ?? []) {
    if (!workflow.includes(token)) fail(`workflow is missing required shared token: ${token}`);
  }
  for (const participant of registry.participants) {
    const block = workflowJobBlock(workflow, participant.ciJob);
    for (const token of participant.requiredCiTokens) {
      if (!block.includes(token)) fail(`${participant.id} CI job ${participant.ciJob} is missing required token: ${token}`);
    }
  }

  const mirrors = registry.mirrors ?? {};
  if (mirrors.languageBoundaries) {
    assert.equal(policy.languageBoundariesMustMatchParticipants, true, 'policy.languageBoundariesMustMatchParticipants must be true');
    const manifest = await readJson(mirrors.languageBoundaries, 'language boundary manifest');
    if (!Array.isArray(manifest.targets)) fail('language boundary manifest targets must be an array');
    const actual = manifest.targets.filter((target) => target?.required !== false).map((target) => target?.language);
    const expected = registry.participants.map((participant) => participantLanguage(participant, 'boundaryLanguage'));
    assert.deepEqual(sorted(actual), sorted(expected), 'required language-boundary targets must exactly match governed participants');
  }

  if (mirrors.runtimeSurfaces) {
    assert.equal(policy.runtimeSurfacesMustMatchParticipants, true, 'policy.runtimeSurfacesMustMatchParticipants must be true');
    const manifest = await readJson(mirrors.runtimeSurfaces, 'runtime surface manifest');
    if (!Array.isArray(manifest.targets)) fail('runtime surface manifest targets must be an array');
    const actual = manifest.targets.map((target) => target?.language);
    const expected = registry.participants.map((participant) => participantLanguage(participant, 'surfaceLanguage'));
    assert.deepEqual(sorted(actual), sorted(expected), 'runtime-surface targets must exactly match governed participants');
  }

  if (mirrors.conformanceManifest) {
    assert.equal(policy.conformanceParticipantsMustMatch, true, 'policy.conformanceParticipantsMustMatch must be true');
    const manifest = await readJson(mirrors.conformanceManifest, 'conformance manifest');
    if (!Array.isArray(manifest.requiredParticipants)) fail('conformance requiredParticipants must be an array');
    const actual = manifest.requiredParticipants.map((entry) => typeof entry === 'string' ? entry : entry?.id);
    const expected = registry.participants.map((participant) => participantLanguage(participant, 'conformanceId'));
    assert.deepEqual(sorted(actual), sorted(expected), 'conformance participants must exactly match governed participants');
  }

  if (mirrors.providerMatrix) {
    assert.equal(policy.providerLanguagesMustBeGoverned, true, 'policy.providerLanguagesMustBeGoverned must be true');
    const manifest = await readJson(mirrors.providerMatrix, 'provider matrix');
    const providers = Object.values(manifest.providers ?? {});
    const providerLanguages = new Set(providers.flatMap((provider) => Array.isArray(provider?.languages) ? provider.languages : []));
    const expected = new Set(registry.participants.map((participant) => participantLanguage(participant, 'providerLanguage')));
    for (const language of providerLanguages) if (!expected.has(language)) fail(`provider matrix references ungoverned language: ${language}`);
    for (const language of expected) if (!providerLanguages.has(language)) fail(`governed language has no provider conformance coverage: ${language}`);
  }

  if (mirrors.conformanceAdapterFile) {
    assert.equal(policy.conformanceAdaptersMustMatchParticipants, true, 'policy.conformanceAdaptersMustMatchParticipants must be true');
    const adapterSource = await readText(mirrors.conformanceAdapterFile, 'conformance adapter file');
    for (const participant of registry.participants) {
      if (!Array.isArray(participant.adapterTokens) || participant.adapterTokens.length === 0) fail(`${participant.id}.adapterTokens must be non-empty`);
      for (const token of participant.adapterTokens) if (!adapterSource.includes(token)) fail(`${participant.id} conformance adapter token missing: ${token}`);
    }
  }

  if (mirrors.apiSurface) {
    assert.equal(policy.apiSurfaceBindingsMustMatch, true, 'policy.apiSurfaceBindingsMustMatch must be true');
    const api = await readJson(mirrors.apiSurface, 'API surface contract');
    if (!Array.isArray(api.operations) || api.operations.length === 0) fail('API surface operations must be non-empty');
    const operations = api.operations.map((entry) => typeof entry === 'string' ? entry : entry?.id);
    if (new Set(operations).size !== operations.length || operations.some((op) => typeof op !== 'string' || !op)) fail('API surface operations must have unique non-empty ids');
    for (const participant of registry.participants) {
      if (!participant.apiBindingFile || !participant.apiBindings || typeof participant.apiBindings !== 'object' || Array.isArray(participant.apiBindings)) {
        fail(`${participant.id} must declare apiBindingFile and apiBindings`);
      }
      assert.deepEqual(sorted(Object.keys(participant.apiBindings)), sorted(operations), `${participant.id} API binding keys drifted from canonical operations`);
      const source = await readText(participant.apiBindingFile, `${participant.id}.apiBindingFile`);
      for (const operation of operations) {
        const token = participant.apiBindings[operation];
        if (typeof token !== 'string' || !token) fail(`${participant.id} has invalid binding for ${operation}`);
        if (!source.includes(token)) fail(`${participant.id} API binding token for ${operation} is absent from ${participant.apiBindingFile}: ${token}`);
      }
    }
  }

  console.log(JSON.stringify({
    schema: 'ores.polyglot-governance.check/v1',
    repository: registry.repository,
    participants: sorted(ids),
    sourceDirectories: sorted(participantDirs),
    ignoredSourceDirectories: sorted(ignoredDirs),
    status: 'pass',
  }, null, 2));
} catch (error) {
  console.error(`[polyglot-governance] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
