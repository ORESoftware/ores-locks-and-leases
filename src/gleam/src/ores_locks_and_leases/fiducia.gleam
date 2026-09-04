//// `Lease` over the fiducia-cloud node HTTP protocol with `gleam_httpc`. It
//// speaks the same three endpoints the official clients do
//// (`/v1/locks/acquire`, `/v1/locks/renew`, `/v1/locks/release`) with the
//// same headers.
////
//// The node never holds a request open: `acquire` returns at once with
//// `acquired: false` when the key is held, so the client owns the wait.
//// This adapter polls at `retry_interval_ms` until the grant arrives or
//// `wait_timeout_ms` elapses.

import gleam/dynamic/decode
import gleam/erlang/process
import gleam/http.{Post}
import gleam/http/request
import gleam/httpc
import gleam/int
import gleam/json
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import ores_locks_and_leases as core

pub type Config {
  Config(
    /// Base URL of the node or edge, e.g. `https://fiducia.example` or
    /// `http://localhost:8090`.
    base_url: String,
    /// Trusted internal hop: `x-fiducia-internal-auth` + `x-fiducia-org-id`.
    internal: Option(#(String, String)),
    /// Public edge: `Authorization: Bearer`.
    api_key: Option(String),
    /// Send a credential over cleartext http to a non-local host. Only for
    /// fully trusted paths.
    allow_cleartext_internal: Bool,
    /// Holder ids when `AcquireOptions.holder` is `None`.
    generate_holder: fn() -> String,
  )
}

/// The trusted internal hop straight to a fiducia-node.
pub fn internal(base_url: String, secret: String, org_id: String) -> Config {
  Config(
    base_url: strip_trailing_slash(base_url),
    internal: Some(#(secret, org_id)),
    api_key: None,
    allow_cleartext_internal: False,
    generate_holder: generated_holder,
  )
}

/// A public edge or load-balancer endpoint authenticated with an API key.
pub fn bearer(base_url: String, api_key: String) -> Config {
  Config(
    base_url: strip_trailing_slash(base_url),
    internal: None,
    api_key: Some(api_key),
    allow_cleartext_internal: False,
    generate_holder: generated_holder,
  )
}

fn strip_trailing_slash(url: String) -> String {
  case string.ends_with(url, "/") {
    True -> strip_trailing_slash(string.drop_end(url, 1))
    False -> url
  }
}

/// A `Lease` whose three verbs call the node described by `config`.
pub fn lease(config: Config) -> core.Lease {
  core.Lease(
    acquire: fn(key, opts, wait) { acquire(config, key, opts, wait) },
    renew: fn(grant, ttl_ms) { renew(config, grant, ttl_ms) },
    release: fn(grant) { release(config, grant) },
  )
}

/// An unguessable holder identity.
pub fn generated_holder() -> String {
  "ores-locks-"
  <> int.to_string(int.random(1_000_000_000_000))
  <> "-"
  <> int.to_string(int.random(1_000_000_000_000))
}

/// Why a credential must not be sent to `base_url`, if it must not.
pub fn cleartext_refusal(
  base_url: String,
  has_credential: Bool,
  allow: Bool,
) -> Option(String) {
  case has_credential && !allow && string.starts_with(base_url, "http://") {
    False -> None
    True -> {
      let host =
        base_url
        |> string.drop_start(7)
        |> string.split_once("/")
        |> result.map(fn(pair) { pair.0 })
        |> result.unwrap(string.drop_start(base_url, 7))
        |> string.split_once(":")
        |> result.map(fn(pair) { pair.0 })
        |> result.unwrap(string.drop_start(base_url, 7))
      let local =
        host == "localhost"
        || host == "127.0.0.1"
        || host == "[::1]"
        || string.ends_with(host, ".svc")
        || string.ends_with(host, ".cluster.local")
        || string.ends_with(host, ".internal")
        || string.ends_with(host, ".local")
      case local {
        True -> None
        False ->
          Some(
            "fiducia: refusing to send a credential over cleartext http to \""
            <> host
            <> "\"; use https or allow_cleartext_internal",
          )
      }
    }
  }
}

fn post(
  config: Config,
  path: String,
  body: json.Json,
) -> Result(decode.Dynamic, String) {
  let has_credential =
    option.is_some(config.internal) || option.is_some(config.api_key)
  use _ <- result.try(
    case
      cleartext_refusal(
        config.base_url,
        has_credential,
        config.allow_cleartext_internal,
      )
    {
      Some(refusal) -> Error(refusal)
      None -> Ok(Nil)
    },
  )
  use req <- result.try(
    request.to(config.base_url <> path)
    |> result.map_error(fn(_) {
      "fiducia: invalid base url " <> config.base_url
    }),
  )
  let req =
    req
    |> request.set_method(Post)
    |> request.set_header("content-type", "application/json")
    |> request.set_body(json.to_string(body))
  let req = case config.internal {
    Some(#(secret, org_id)) ->
      req
      |> request.set_header("x-fiducia-internal-auth", secret)
      |> request.set_header("x-fiducia-org-id", org_id)
    None -> req
  }
  let req = case config.api_key {
    Some(api_key) ->
      request.set_header(req, "authorization", "Bearer " <> api_key)
    None -> req
  }
  use resp <- result.try(
    httpc.send(req)
    |> result.map_error(fn(error) {
      "fiducia: transport: " <> string.inspect(error)
    }),
  )
  case resp.status >= 300 {
    True ->
      Error("fiducia: HTTP " <> int.to_string(resp.status) <> ": " <> resp.body)
    False -> {
      let decoder = {
        use output <- decode.subfield(["result", "output"], decode.dynamic)
        decode.success(output)
      }
      json.parse(resp.body, decoder)
      |> result.map_error(fn(error) {
        "fiducia: malformed response: " <> string.inspect(error)
      })
    }
  }
}

fn field_bool(output: decode.Dynamic, name: String) -> Bool {
  decode.run(output, decode.at([name], decode.bool)) |> result.unwrap(False)
}

fn field_int(output: decode.Dynamic, name: String) -> Option(Int) {
  decode.run(output, decode.at([name], decode.int)) |> option.from_result
}

fn now_ms() -> Int {
  erlang_monotonic_ms()
}

@external(erlang, "erlang", "monotonic_time")
fn erlang_monotonic_native() -> Int

fn erlang_monotonic_ms() -> Int {
  // monotonic_time/0 is in native units (nanoseconds on modern BEAM).
  erlang_monotonic_native() / 1_000_000
}

pub fn acquire(
  config: Config,
  key: core.LockKey,
  opts: core.AcquireOptions,
  wait: Bool,
) -> Result(core.LeaseGrant, core.LockError) {
  let holder = core.holder_or(opts, config.generate_holder)
  poll_acquire(config, key, opts, wait, holder, now_ms())
}

fn poll_acquire(
  config: Config,
  key: core.LockKey,
  opts: core.AcquireOptions,
  wait: Bool,
  holder: String,
  started_ms: Int,
) -> Result(core.LeaseGrant, core.LockError) {
  let body =
    json.object([
      #("key", json.string(core.key_to_string(key))),
      #("holder", json.string(holder)),
      #("ttl_ms", json.int(opts.ttl_ms)),
    ])
  use output <- result.try(
    post(config, "/v1/locks/acquire", body)
    |> result.map_error(core.transport_error(key, _)),
  )
  case field_bool(output, "acquired"), field_int(output, "fencing_token") {
    True, Some(fencing_token) ->
      Ok(core.LeaseGrant(
        key: key,
        holder: holder,
        fencing_token: fencing_token,
        lease_expires_ms: field_int(output, "lease_expires_ms"),
        ttl_ms: opts.ttl_ms,
      ))
    True, None ->
      Error(core.transport_error(
        key,
        "fiducia: acquired without a fencing token",
      ))
    False, _ ->
      case wait {
        False -> Error(core.contention(key, core.FiduciaTryAcquire))
        True -> {
          let waited = now_ms() - started_ms
          case waited + opts.retry_interval_ms > opts.wait_timeout_ms {
            True -> Error(core.timeout(key, core.FiduciaAcquire, waited))
            False -> {
              process.sleep(opts.retry_interval_ms)
              poll_acquire(config, key, opts, wait, holder, started_ms)
            }
          }
        }
      }
  }
}

/// `renewed: false` is lost fenced authority: fiducia has already reaped the
/// grant and may have promoted another holder.
pub fn renew(
  config: Config,
  grant: core.LeaseGrant,
  ttl_ms: Int,
) -> Result(core.LeaseGrant, core.LockError) {
  let body =
    json.object([
      #("key", json.string(core.key_to_string(grant.key))),
      #("holder", json.string(grant.holder)),
      #("fencing_token", json.int(grant.fencing_token)),
      #("ttl_ms", json.int(ttl_ms)),
    ])
  use output <- result.try(
    post(config, "/v1/locks/renew", body)
    |> result.map_error(core.transport_error(grant.key, _)),
  )
  case field_bool(output, "renewed") {
    False ->
      Error(core.LockError(
        core.LostLease,
        grant.key,
        None,
        "fiducia: lock renewal lost fenced authority",
      ))
    True ->
      Ok(
        core.LeaseGrant(
          ..grant,
          ttl_ms: ttl_ms,
          lease_expires_ms: field_int(output, "lease_expires_ms"),
        ),
      )
  }
}

pub fn release(
  config: Config,
  grant: core.LeaseGrant,
) -> Result(Bool, core.LockError) {
  let body =
    json.object([
      #("key", json.string(core.key_to_string(grant.key))),
      #("holder", json.string(grant.holder)),
      #("fencing_token", json.int(grant.fencing_token)),
    ])
  post(config, "/v1/locks/release", body)
  |> result.map(field_bool(_, "released"))
  |> result.map_error(fn(message) {
    core.tag_step(core.transport_error(grant.key, message), core.FiduciaRelease)
  })
}
