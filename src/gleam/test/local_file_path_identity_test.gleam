import gleeunit/should
import ores_locks_and_leases/local_file
import simplifile

fn clean(root: String) -> Nil {
  let _ = simplifile.delete_all([root])
  Nil
}

pub fn dot_and_dot_dot_lock_names_are_invalid_test() {
  let root = "./.tmp-local-file-path-identity/dot-names"
  clean(root)
  let assert Error(dot) = local_file.try_acquire(root, ".", "owner-a")
  dot.kind |> should.equal(local_file.InvalidInput)
  let assert Error(dot_dot) = local_file.try_acquire(root, "..", "owner-a")
  dot_dot.kind |> should.equal(local_file.InvalidInput)
  clean(root)
}

pub fn rendezvous_symlink_is_compromised_when_supported_test() {
  let root = "./.tmp-local-file-path-identity/rendezvous"
  clean(root)
  let assert Ok(Nil) = simplifile.create_directory_all(root <> "/target")
  let status = make_symlink_status(root <> "/target", root <> "/install.lock")
  case status {
    0 -> {
      let assert Error(error) =
        local_file.try_acquire(root, "install.lock", "owner-a")
      error.kind |> should.equal(local_file.Compromised)
    }
    1 -> Nil
    other -> other |> should.equal(1)
  }
  clean(root)
}

pub fn immediate_parent_symlink_is_compromised_when_supported_test() {
  let root = "./.tmp-local-file-path-identity/parent"
  clean(root)
  let assert Ok(Nil) = simplifile.create_directory_all(root <> "/real-parent")
  let status =
    make_symlink_status(root <> "/real-parent", root <> "/alias-parent")
  case status {
    0 -> {
      let assert Error(error) =
        local_file.try_acquire(
          root <> "/alias-parent",
          "install.lock",
          "owner-a",
        )
      error.kind |> should.equal(local_file.Compromised)
    }
    1 -> Nil
    other -> other |> should.equal(1)
  }
  clean(root)
}

pub fn owner_symlink_is_compromised_on_release_when_supported_test() {
  let root = "./.tmp-local-file-path-identity/owner"
  clean(root)
  let assert Ok(local_file.Some(lock)) =
    local_file.try_acquire(root, "install.lock", "owner-a")
  let path = local_file.local_file_lock_path(lock)
  let assert Ok(Nil) = simplifile.delete_file(at: path <> "/owner")
  let assert Ok(Nil) =
    simplifile.write(to: root <> "/external-owner", contents: "owner-a")
  let status = make_symlink_status(root <> "/external-owner", path <> "/owner")
  case status {
    0 -> {
      let assert Error(error) = local_file.release(lock)
      error.kind |> should.equal(local_file.Compromised)
    }
    1 -> {
      let assert Ok(Nil) =
        simplifile.write(to: path <> "/owner", contents: "owner-a")
      local_file.release(lock) |> should.equal(Ok(Nil))
    }
    other -> other |> should.equal(1)
  }
  clean(root)
}

@external(erlang, "ores_locks_and_leases_local_file_ffi", "make_symlink_status")
fn make_symlink_status(target: String, link: String) -> Int
