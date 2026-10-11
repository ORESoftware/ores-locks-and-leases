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
        {ok, [First, Second]} ->
            case lists:sort([unicode:characters_to_binary(First),
                             unicode:characters_to_binary(Second)]) of
                [<<"owner">>, <<"owner.recovering">>] -> 3;
                _ -> 1
            end;
        {ok, _} -> 1;
        {error, _} -> 2
    end.

%% Exclusively create a durable recovery-claim marker before touching the
%% published owner. Rename can replace a competing claim on some filesystems,
%% and must not serve as a compare-and-swap across language runtimes.
%% 0 claimed; 1 directory disappeared; 2 claim exists; 3 other IO.
claim_recovery_status(_OwnerPath, RecoveringPath) ->
    case file:open(RecoveringPath, [write, exclusive, raw, binary]) of
        {ok, Claim} ->
            case file:close(Claim) of
                ok -> 0;
                {error, _} -> 3
            end;
        {error, enoent} -> 1;
        {error, eexist} -> 2;
        {error, _} -> 3
    end.
