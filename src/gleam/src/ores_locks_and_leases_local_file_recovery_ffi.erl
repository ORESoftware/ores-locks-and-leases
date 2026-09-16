-module(ores_locks_and_leases_local_file_recovery_ffi).
-export([directory_shape/1, claim_recovery_status/2]).

%% Recovery-aware lock-directory shape.
%% 0 exactly one published owner; 1 dirty/unexpected; 2 IO; 3 incomplete.
%% Both publication and recovery claim markers are incomplete transition state,
%% never reusable ownership authority.
directory_shape(Path) ->
    case file:list_dir(Path) of
        {ok, []} -> 3;
        {ok, [Only]} ->
            case unicode:characters_to_binary(Only) of
                <<"owner">> -> 0;
                <<"owner.pending">> -> 3;
                <<"owner.recovering">> -> 3;
                _ -> 1
            end;
        {ok, _} -> 1;
        {error, _} -> 2
    end.

%% Atomically move the authenticated published owner marker to one fixed
%% recovery claim name. The rename is the destructive recovery linearization
%% point across all maintained runtimes.
%% 0 claimed; 1 source disappeared; 2 claim target exists; 3 other IO.
claim_recovery_status(OwnerPath, RecoveringPath) ->
    case file:rename(OwnerPath, RecoveringPath) of
        ok -> 0;
        {error, enoent} -> 1;
        {error, eexist} -> 2;
        {error, enotempty} -> 2;
        {error, _} -> 3
    end.
