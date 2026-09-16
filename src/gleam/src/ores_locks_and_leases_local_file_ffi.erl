-module(ores_locks_and_leases_local_file_ffi).
-include_lib("kernel/include/file.hrl").
-export([
    delete_empty_directory/1,
    is_directory/1,
    path_kind/1,
    directory_shape/1,
    write_new_file_status/2,
    publish_owner_status/3,
    make_private_directory_status/1,
    make_symlink_status/2,
    make_hardlink_status/2,
    make_hard_link_status/2,
    unicode_codepoint_count/1,
    owner_private_mode_status/1,
    monotonic_milliseconds/0,
    windows_path_admission_status/1
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
%% 0 absent, 1 real directory, 2 single-linked regular file, 3 alias/other
%% node (including a multiply linked regular owner marker), 4 IO.
path_kind(Path) ->
    case file:read_link_info(Path) of
        {error, enoent} -> 0;
        {ok, #file_info{type = directory}} -> 1;
        {ok, #file_info{type = regular, links = 1}} -> 2;
        {ok, #file_info{type = regular}} -> 3;
        {ok, _} -> 3;
        {error, _} -> 4
    end.

%% 0 exactly one published owner; 1 dirty/unexpected; 2 IO; 3 incomplete
%% transition. A lone owner.pending is the reader-safe publication window and
%% must never be interpreted as a held owner token.
directory_shape(Path) ->
    case file:list_dir(Path) of
        {ok, []} -> 3;
        {ok, [Only]} ->
            case unicode:characters_to_binary(Only) of
                <<"owner">> -> 0;
                <<"owner.pending">> -> 3;
                _ -> 1
            end;
        {ok, _} -> 1;
        {error, _} -> 2
    end.

%% Atomically claim the rendezvous with make_dir, then tighten the newly owned
%% directory to 0700 before publishing any owner identity. Erlang's file API
%% does not expose a per-call mkdir mode, so POSIX mode tightening is the first
%% operation after the atomic claim. If chmod fails, roll the still-empty
%% provisional directory back and fail closed.
%% 0 success, 1 already exists, 2 other IO/mode failure.
make_private_directory_status(Path) ->
    case file:make_dir(Path) of
        {error, eexist} -> 1;
        {error, _} -> 2;
        ok ->
            case os:type() of
                {unix, _} ->
                    case file:change_mode(Path, 8#700) of
                        ok -> 0;
                        {error, _} ->
                            _ = file:del_dir(Path),
                            2
                    end;
                _ -> 0
            end
    end.

%% Legacy helper retained for compatibility. New lock acquisition uses
%% publish_owner_status/3 so readers cannot observe a partially written owner.
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

%% Reader-safe owner publication. Write the owner to a private, exclusive
%% owner.pending marker, sync and close it, then atomically rename it to owner.
%% Inspection treats owner.pending as Incomplete, never Held.
%% 0 success, 1 target/pending already exists, 2 other IO failure.
publish_owner_status(PendingPath, OwnerPath, Contents) ->
    case file:open(PendingPath, [write, binary, exclusive]) of
        {error, eexist} -> 1;
        {error, _} -> 2;
        {ok, IoDevice} ->
            case ensure_private_mode(PendingPath) of
                ok -> publish_owner_write_sync_close(IoDevice, PendingPath, OwnerPath, Contents);
                {error, _} ->
                    _ = file:close(IoDevice),
                    _ = file:delete(PendingPath),
                    2
            end
    end.

publish_owner_write_sync_close(IoDevice, PendingPath, OwnerPath, Contents) ->
    case file:write(IoDevice, Contents) of
        ok ->
            case file:sync(IoDevice) of
                ok ->
                    case file:close(IoDevice) of
                        ok ->
                            case file:rename(PendingPath, OwnerPath) of
                                ok -> 0;
                                {error, eexist} ->
                                    _ = file:delete(PendingPath),
                                    1;
                                {error, _} ->
                                    _ = file:delete(PendingPath),
                                    2
                            end;
                        {error, _} ->
                            _ = file:delete(PendingPath),
                            2
                    end;
                {error, _} ->
                    _ = file:close(IoDevice),
                    _ = file:delete(PendingPath),
                    2
            end;
        {error, _} ->
            _ = file:close(IoDevice),
            _ = file:delete(PendingPath),
            2
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

%% Monotonic clock used by the Gleam acquisition loop so filesystem-call
%% latency consumes the same end-to-end wait budget as retry sleeps.
monotonic_milliseconds() ->
    erlang:monotonic_time(millisecond).

%% Windows admission is intentionally conservative because Win32 normalizes
%% several path spellings that would otherwise create ambiguous rendezvous
%% identities. On non-Windows hosts the same strings retain ordinary POSIX
%% semantics and are left untouched.
%%
%% Status: 0 admitted (or non-Windows), 1 rejected.
windows_path_admission_status(Path) ->
    case os:type() of
        {win32, _} ->
            try
                Chars = unicode:characters_to_list(Path),
                case windows_path_is_safe(Chars) of
                    true -> 0;
                    false -> 1
                end
            catch
                _:_ -> 1
            end;
        _ -> 0
    end.

windows_path_is_safe(Chars) ->
    Normalized = normalize_windows_separators(Chars),
    not has_forbidden_windows_prefix(Normalized)
        andalso windows_components_safe(string:split(Normalized, "/", all), true).

normalize_windows_separators(Chars) ->
    [case C of $\\ -> $/; _ -> C end || C <- Chars].

has_forbidden_windows_prefix(Path) ->
    lists:prefix("//?/", Path)
        orelse lists:prefix("//./", Path)
        orelse lists:prefix("/??/", Path).

windows_components_safe([], _) -> true;
windows_components_safe(["" | Rest], IsFirst) ->
    windows_components_safe(Rest, IsFirst);
windows_components_safe([Component | Rest], IsFirst) ->
    case windows_component_safe(Component, IsFirst) of
        true -> windows_components_safe(Rest, false);
        false -> false
    end.

windows_component_safe(".", _) -> true;
windows_component_safe("..", _) -> true;
windows_component_safe(Component, true) ->
    case is_drive_component(Component) of
        true -> true;
        false -> windows_ordinary_component_safe(Component)
    end;
windows_component_safe(Component, false) ->
    windows_ordinary_component_safe(Component).

is_drive_component([Letter, $:]) ->
    (Letter >= $A andalso Letter =< $Z) orelse (Letter >= $a andalso Letter =< $z);
is_drive_component(_) -> false.

windows_ordinary_component_safe([]) -> false;
windows_ordinary_component_safe(Component) ->
    Last = lists:last(Component),
    Last =/= $. andalso Last =/= 32
        andalso not lists:member($:, Component)
        andalso not windows_reserved_device_component(Component).

windows_reserved_device_component(Component) ->
    Upper = string:uppercase(Component),
    Base = string:trim(take_until_dot(Upper)),
    lists:member(Base, [
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
    ]).

take_until_dot([]) -> [];
take_until_dot([$. | _]) -> [];
take_until_dot([Head | Tail]) -> [Head | take_until_dot(Tail)].

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

%% Test-support primitive for owner-marker hard-link policy.
%% 0 success; 1 platform/filesystem does not permit hard links; 2 other.
make_hardlink_status(Existing, Link) ->
    case file:make_link(Existing, Link) of
        ok -> 0;
        {error, Reason} when Reason =:= eperm; Reason =:= eacces; Reason =:= enotsup; Reason =:= exdev -> 1;
        {error, _} -> 2
    end.

%% Compatibility spelling used by the newer Gleam recovery test surface.
make_hard_link_status(Existing, Link) ->
    make_hardlink_status(Existing, Link).
