-module(worker).
-export([handle/2]).

%% Tenant code is activated alongside BeamScale's trusted critical-section
%% authority. It does not acquire/release locks or mint fencing tokens.
%% A future execute-under-token API can dispatch admitted work here.
handle(_Request, _Context) ->
    {response, 204, [], <<>>}.
