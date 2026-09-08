#!/usr/bin/env node

import { spawn } from "node:child_process";
import process from "node:process";

const DATABASE_URL_ENV = "ORES_LOCKS_TEST_DATABASE_URL";
const QUERY_ENV = new Map([
  ["application_name", "PGAPPNAME"],
  ["channel_binding", "PGCHANNELBINDING"],
  ["connect_timeout", "PGCONNECT_TIMEOUT"],
  ["gssencmode", "PGGSSENCMODE"],
  ["hostaddr", "PGHOSTADDR"],
  ["keepalives", "PGKEEPALIVES"],
  ["keepalives_count", "PGKEEPALIVESCOUNT"],
  ["keepalives_idle", "PGKEEPALIVESIDLE"],
  ["keepalives_interval", "PGKEEPALIVESINTERVAL"],
  ["krbsrvname", "PGKRBSRVNAME"],
  ["options", "PGOPTIONS"],
  ["passfile", "PGPASSFILE"],
  ["requirepeer", "PGREQUIREPEER"],
  ["service", "PGSERVICE"],
  ["servicefile", "PGSERVICEFILE"],
  ["sslcert", "PGSSLCERT"],
  ["sslcompression", "PGSSLCOMPRESSION"],
  ["sslcrl", "PGSSLCRL"],
  ["sslcrldir", "PGSSLCRLDIR"],
  ["sslkey", "PGSSLKEY"],
  ["sslmode", "PGSSLMODE"],
  ["sslpassword", "PGSSLPASSWORD"],
  ["sslrootcert", "PGSSLROOTCERT"],
  ["sslsni", "PGSSLSNI"],
  ["target_session_attrs", "PGTARGETSESSIONATTRS"],
  ["tcp_user_timeout", "PGTCPUSER_TIMEOUT"],
]);
const CONNECTION_ENV = new Set([
  "PGDATABASE",
  "PGHOST",
  "PGPASSWORD",
  "PGPORT",
  "PGUSER",
  ...QUERY_ENV.values(),
]);

function fail(message) {
  console.error(`psql launcher: ${message}`);
  process.exit(2);
}

function decodeComponent(value, label) {
  try {
    return decodeURIComponent(value);
  } catch {
    fail(`${label} contains invalid percent encoding`);
  }
}

const raw = process.env[DATABASE_URL_ENV];
if (!raw) {
  fail(`${DATABASE_URL_ENV} is required`);
}

let url;
try {
  url = new URL(raw);
} catch {
  fail(`${DATABASE_URL_ENV} must be a PostgreSQL URL`);
}

if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
  fail(`${DATABASE_URL_ENV} must use postgres:// or postgresql://`);
}
if (!url.hostname) {
  fail(`${DATABASE_URL_ENV} must include a host`);
}
if (url.hash) {
  fail(`${DATABASE_URL_ENV} must not include a fragment`);
}

const childEnv = { ...process.env };
delete childEnv[DATABASE_URL_ENV];
for (const name of CONNECTION_ENV) {
  delete childEnv[name];
}
const hostname =
  url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
childEnv.PGHOST = hostname;
childEnv.PGPORT = url.port || "5432";

if (url.username) {
  childEnv.PGUSER = decodeComponent(url.username, "PostgreSQL user");
}
if (url.password) {
  childEnv.PGPASSWORD = decodeComponent(url.password, "PostgreSQL password");
}

const database = decodeComponent(
  url.pathname.replace(/^\/+/, ""),
  "PostgreSQL database",
);
if (database) {
  childEnv.PGDATABASE = database;
}

const seen = new Set();
for (const [name, value] of url.searchParams) {
  if (seen.has(name)) {
    fail(`duplicate PostgreSQL URL parameter: ${name}`);
  }
  seen.add(name);
  const environmentName = QUERY_ENV.get(name);
  if (!environmentName) {
    fail(`unsupported PostgreSQL URL parameter: ${name}`);
  }
  childEnv[environmentName] = value;
}

const child = spawn("psql", process.argv.slice(2), {
  env: childEnv,
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error(`psql launcher: could not start psql: ${error.message}`);
  process.exitCode = 127;
});
child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`psql launcher: psql terminated by signal ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
