-module(ores_locks_and_leases_local_file_ffi).
-include_lib("kernel/include/file.hrl").
-export([delete_empty_directory/1, is_directory/1, path_kind/1, write_new_file_status/2]).

%% file:del_dir/1 returns the atom `ok` on success, while Gleam's Result
%% representation expects {ok, Value}. Normalize the return shape without
%% falling back to recursive deletion: a non-empty lock directory must still
%% fail closed rather than deleting unexpected files.
delete_empty_directory(Path) ->
    case file:del_dir(Path) of
        ok -> {ok, nil};
        {error, Reason} -> {error, Reason}
    end.

%% Retained for compatibility with the first portable-lock implementation.
is_directory(Path) ->
    filelib:is_dir(Path).

%% Alias-aware path classification using read_link_info so symbolic links are
%% never followed. Values are intentionally tiny and stable for the Gleam FFI:
%% 0 absent, 1 real directory, 2 real regular file, 3 alias/other node, 4 IO.
path_kind(Path) ->
    case file:read_link_info(Path) of
        {error, enoent} -> 0;
        {ok, #file_info{type = directory}} -> 1;
        {ok, #file_info{type = regular}} -> 2;
        {ok, _} -> 3;
        {error, _} -> 4
    end.

%% Create the owner marker without overwriting an attacker- or race-created
%% node. 0 success, 1 already exists, 2 other IO failure.
write_new_file_status(Path, Contents) ->
    case file:open(Path, [write, binary, exclusive]) of
        {error, eexist} -> 1;
        {error, _} -> 2;
        {ok, IoDevice} ->
            case file:write(IoDevice, Contents) of
                ok ->
                    case file:close(IoDevice) of
                        ok -> 0;
                        {error, _} -> 2
                    end;
                {error, _} ->
                    _ = file:close(IoDevice),
                    2
            end
    end.
