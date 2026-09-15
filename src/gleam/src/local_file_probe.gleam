import gleam/erlang/process
import gleam/int
import gleam/io
import gleam/option.{None, Some}
import ores_locks_and_leases/local_file

pub fn main() {
  case plain_arguments() {
    [mode, lock_root, lock_name, owner, hold_text] ->
      run(mode, lock_root, lock_name, owner, hold_text)
    [mode, lock_root, lock_name, owner] ->
      run(mode, lock_root, lock_name, owner, "0")
    _ -> usage()
  }
}

fn run(
  mode: String,
  lock_root: String,
  lock_name: String,
  owner: String,
  hold_text: String,
) {
  case mode {
    "hold" -> Nil
    "try" -> Nil
    "crash" -> Nil
    _ -> usage()
  }

  let hold_ms = case int.parse(hold_text) {
    Ok(value) if value >= 0 -> value
    _ -> {
      usage()
      0
    }
  }

  case local_file.try_acquire(lock_root, lock_name, owner) {
    Error(_) -> {
      io.println("LOCK_ERROR")
      halt(20)
    }
    Ok(None) -> {
      io.println("CONTENDED")
      halt(10)
    }
    Ok(Some(lock)) -> {
      io.println("ACQUIRED")
      case mode {
        "hold" -> process.sleep(hold_ms)
        "try" -> Nil
        "crash" -> {
          io.println("CRASHED")
          halt(30)
        }
        _ -> panic as "validated probe mode became unreachable"
      }

      case local_file.release(lock) {
        Ok(Nil) -> {
          io.println("RELEASED")
          Nil
        }
        Error(_) -> {
          io.println("RELEASE_ERROR")
          halt(21)
        }
      }
    }
  }
}

fn usage() {
  io.println(
    "usage: local_file_probe <hold|try|crash> <lock_root> <lock_name> <owner> [hold_ms]",
  )
  halt(2)
}

@external(erlang, "local_file_probe_ffi", "plain_arguments")
fn plain_arguments() -> List(String)

@external(erlang, "local_file_probe_ffi", "halt")
fn halt(code: Int) -> Nil
