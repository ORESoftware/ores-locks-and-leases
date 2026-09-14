-module(ores_locks_and_leases_local_file_ffi).
-export([delete_empty_directory/1]).

%% file:del_dir/1 returns the atom `ok` on success, while Gleam's Result
%% representation expects {ok, Value}. Normalize the return shape without
%% falling back to recursive deletion: a non-empty lock directory must still
%% fail closed rather than deleting unexpected files.
delete_empty_directory(Path) ->
    case file:del_dir(Path) of
        ok -> {ok, nil};
        {error, Reason} -> {error, Reason}
    end.
