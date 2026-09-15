-module(local_file_budget_test_ffi).
-export([monotonic_ms/0]).

monotonic_ms() ->
    erlang:monotonic_time(millisecond).
