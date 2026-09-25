//! Bounded model checker for lease exclusivity and fencing tokens.
//! At most one client owns the lease; every acquisition advances the fencing
//! epoch; stale and non-owner writes are rejected in every reachable state.

use std::collections::{HashSet, VecDeque};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum Client { A, B }

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct State { owner: Option<Client>, fence: u8 }

fn invariant(s: State) -> bool {
    s.fence <= 3 && (s.owner.is_none() || s.fence > 0)
}

fn write_allowed(s: State, client: Client, token: u8) -> bool {
    s.owner == Some(client) && token == s.fence
}

fn next(s: State) -> Vec<State> {
    match s.owner {
        None if s.fence < 3 => vec![
            State { owner: Some(Client::A), fence: s.fence + 1 },
            State { owner: Some(Client::B), fence: s.fence + 1 },
        ],
        Some(_) => vec![State { owner: None, ..s }],
        None => vec![],
    }
}

fn main() {
    let initial = State { owner: None, fence: 0 };
    let mut seen = HashSet::from([initial]);
    let mut queue = VecDeque::from([initial]);
    while let Some(state) = queue.pop_front() {
        assert!(invariant(state), "invalid lease state: {state:?}");
        for token in 0..state.fence {
            assert!(!write_allowed(state, Client::A, token), "stale A token admitted: {state:?}, token={token}");
            assert!(!write_allowed(state, Client::B, token), "stale B token admitted: {state:?}, token={token}");
        }
        if let Some(owner) = state.owner {
            let other = if owner == Client::A { Client::B } else { Client::A };
            assert!(write_allowed(state, owner, state.fence));
            assert!(!write_allowed(state, other, state.fence));
        }
        for candidate in next(state) {
            assert!(invariant(candidate), "unsafe lease transition: {state:?} -> {candidate:?}");
            assert!(candidate.fence >= state.fence, "fencing token regressed");
            if candidate.owner.is_some() && state.owner.is_none() {
                assert_eq!(candidate.fence, state.fence + 1, "acquisition did not advance fence");
            }
            if seen.insert(candidate) { queue.push_back(candidate); }
        }
    }
    println!("ores-locks-and-leases formal model: explored {} states; invariants hold", seen.len());
}
