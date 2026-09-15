-module(local_file_probe_ffi).
-export([plain_arguments/0, halt/1]).

plain_arguments() ->
    [unicode:characters_to_binary(Arg) || Arg <- init:get_plain_arguments()].

halt(Code) ->
    erlang:halt(Code).
