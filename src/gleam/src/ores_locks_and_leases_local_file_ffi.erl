-module(ores_locks_and_leases_local_file_ffi).
-include_lib("kernel/include/file.hrl").
-export([
    delete_empty_directory/1,
    is_directory/1,
    path_kind/1,
    directory_shape/1,
    write_new_file_status/2,
    make_symlink_status/2,
    unicode_codepoint_count/1,
    owner_private_mode_status/1,
    read_owner_for_release_status/3
]).

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

%% 0 means exactly one entry named owner; 1 means dirty/unexpected shape; 2 IO.
directory_shape(Path) ->
    case file:list_dir(Path) of
        {ok, [Only]} ->
            case unicode:characters_to_binary(Only) of
                <<"owner">> -> 0;
                _ -> 1
            end;
        {ok, _} -> 1;
        {error, _} -> 2
    end.

%% Create the owner marker without overwriting an attacker- or race-created
%% node. The owner token is not written until POSIX permissions have been
%% tightened to 0600. 0 success, 1 already exists, 2 other IO failure.
write_new_file_status(Path, Contents) ->
    case file:open(Path, [write, binary, exclusive]) of
        {error, eexist} -> 1;
        {error, _} -> 2;
        {ok, IoDevice} ->
            case ensure_private_mode(Path) of
                ok ->
                    write_and_close(IoDevice, Contents);
                {error, _} ->
                    _ = file:close(IoDevice),
                    _ = file:delete(Path),
                    2
            end
    end.

write_and_close(IoDevice, Contents) ->
    case file:write(IoDevice, Contents) of
        ok ->
            case file:close(IoDevice) of
                ok -> 0;
                {error, _} -> 2
            end;
        {error, _} ->
            _ = file:close(IoDevice),
            2
    end.

ensure_private_mode(Path) ->
    case os:type() of
        {unix, _} -> file:change_mode(Path, 8#600);
        _ -> ok
    end.

%% Count Unicode code points rather than UTF-8 bytes. This matches the string
%% length bound represented in TypeSpec/JSON Schema closely enough for the
%% portable contract and avoids treating astral characters as multiple units.
unicode_codepoint_count(Text) ->
    length(unicode:characters_to_list(Text)).

%% Test-support status: 0 private, 1 too-permissive, 2 IO, 3 non-POSIX.
owner_private_mode_status(Path) ->
    case os:type() of
        {unix, _} ->
            case file:read_file_info(Path) of
                {ok, #file_info{mode = Mode}} ->
                    case Mode band 8#077 of
                        0 -> 0;
                        _ -> 1
                    end;
                {error, _} -> 2
            end;
        _ -> 3
    end.

%% Test-support primitive used by cross-platform adversarial identity tests.
%% 0 success; 1 platform/permission does not permit symlink creation; 2 other.
make_symlink_status(Target, Link) ->
    case file:make_symlink(Target, Link) of
        ok -> 0;
        {error, Reason} when Reason =:= eperm; Reason =:= eacces; Reason =:= enotsup -> 1;
        {error, _} -> 2
    end.


%% Bounded release read. Status: 0 match, 1 mismatch, 2 oversized,
%% 3 invalid UTF-8, 4 missing, 5 other IO/close failure.
read_owner_for_release_status(Path, ExpectedOwner, MaxBytes) ->
    case file:open(Path, [read, binary]) of
        {error, enoent} -> 4;
        {error, _} -> 5;
        {ok, IoDevice} ->
            Result = read_owner_bounded(IoDevice, MaxBytes + 1, <<>>),
            CloseResult = file:close(IoDevice),
            case {Result, CloseResult} of
                {{ok, Bytes}, ok} when byte_size(Bytes) > MaxBytes -> 2;
                {{ok, Bytes}, ok} ->
                    case unicode:characters_to_list(Bytes, utf8) of
                        {error, _, _} -> 3;
                        {incomplete, _, _} -> 3;
                        _ ->
                            case Bytes =:= unicode:characters_to_binary(ExpectedOwner) of
                                true -> 0;
                                false -> 1
                            end
                    end;
                {{error, enoent}, _} -> 4;
                _ -> 5
            end
    end.

read_owner_bounded(_IoDevice, Remaining, Acc) when Remaining =< 0 -> {ok, Acc};
read_owner_bounded(IoDevice, Remaining, Acc) ->
    case file:read(IoDevice, Remaining) of
        eof -> {ok, Acc};
        {ok, Bytes} -> read_owner_bounded(IoDevice, Remaining - byte_size(Bytes), <<Acc/binary, Bytes/binary>>);
        {error, Reason} -> {error, Reason}
    end.
