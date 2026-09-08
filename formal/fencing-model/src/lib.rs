#![forbid(unsafe_code)]
#![allow(unexpected_cfgs)]

#[path = "../../../src/rust/fence.rs"]
mod fence;
#[path = "../../../src/rust/key.rs"]
mod key;
#[path = "../../../src/rust/plan.rs"]
mod plan;

#[cfg(kani)]
mod kani_proofs {
    use super::fence::{FenceDecisionKind, classify_validated_fence};
    use super::key::LockKey;
    use super::plan::{LockLayers, LockStep, PgScope, plan};

    fn request(token: u64, operation_b: bool, payload_b: bool) -> FencedWriteRequest {
        FencedWriteRequest::new(
            "formal/tenant",
            LockKey::new("formal/resource").expect("fixed key is valid"),
            FencingTokenText::from_u64(token),
            if operation_b {
                "operation-b"
            } else {
                "operation-a"
            },
            if payload_b {
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            } else {
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            },
            None,
            None,
        )
        .expect("fixed request metadata is valid")
    }

    #[kani::proof]
    fn production_classifier_partitions_the_complete_u64_domain() {
        let has_current: bool = kani::any();
        let current_token: u64 = kani::any();
        let incoming_token: u64 = kani::any();
        let same_operation: bool = kani::any();
        let same_payload: bool = kani::any();

        let actual = classify_validated_fence(
            has_current,
            current_token,
            incoming_token,
            same_operation,
            same_payload,
        );
        let expected = if !has_current || incoming_token > current_token {
            FenceDecisionKind::Advanced
        } else if incoming_token < current_token {
            FenceDecisionKind::Stale
        } else if same_operation && same_payload {
            FenceDecisionKind::Replay
        } else {
            FenceDecisionKind::TokenReuse
        };

        assert_eq!(actual, expected);
        assert_eq!(
            actual == FenceDecisionKind::Advanced,
            !has_current || incoming_token > current_token,
        );
    }

    fn index_of(steps: &[LockStep], wanted: LockStep) -> Option<usize> {
        let mut index = 0;
        while index < steps.len() {
            if steps[index] == wanted {
                return Some(index);
            }
            index += 1;
        }
        None
    }

    #[kani::proof]
    #[kani::unwind(8)]
    fn production_lock_plan_never_enters_an_illegal_layer_order() {
        let layers = LockLayers {
            fiducia: kani::any(),
            pg_advisory: kani::any(),
        };
        let scope = if kani::any() {
            PgScope::Transaction
        } else {
            PgScope::Session
        };
        let wait: bool = kani::any();
        let computed = plan(layers, scope, wait);
        let steps = &computed.steps;

        assert!(!steps.is_empty());
        assert!(steps.len() <= 6);
        let mut work_count = 0;
        let mut index = 0;
        while index < steps.len() {
            if steps[index] == LockStep::Work {
                work_count += 1;
            }
            index += 1;
        }
        assert_eq!(work_count, 1);

        if layers.fiducia {
            assert_eq!(
                steps.first(),
                Some(if wait {
                    &LockStep::FiduciaAcquire
                } else {
                    &LockStep::FiduciaTryAcquire
                })
            );
            assert_eq!(steps.last(), Some(&LockStep::FiduciaRelease));
        } else {
            assert!(!steps.contains(&LockStep::FiduciaAcquire));
            assert!(!steps.contains(&LockStep::FiduciaTryAcquire));
            assert!(!steps.contains(&LockStep::FiduciaRelease));
        }

        if !layers.pg_advisory {
            assert!(!steps.contains(&LockStep::PgBegin));
            assert!(!steps.contains(&LockStep::PgAdvisoryXactLock));
            assert!(!steps.contains(&LockStep::PgTryAdvisoryXactLock));
            assert!(!steps.contains(&LockStep::PgAdvisoryLock));
            assert!(!steps.contains(&LockStep::PgTryAdvisoryLock));
            assert!(!steps.contains(&LockStep::PgAdvisoryUnlock));
        } else {
            let work = index_of(steps, LockStep::Work).expect("work is present");
            match scope {
                PgScope::Transaction => {
                    let begin = index_of(steps, LockStep::PgBegin).expect("begin is present");
                    let acquire = index_of(
                        steps,
                        if wait {
                            LockStep::PgAdvisoryXactLock
                        } else {
                            LockStep::PgTryAdvisoryXactLock
                        },
                    )
                    .expect("transaction acquire is present");
                    let commit = index_of(steps, LockStep::PgCommit).expect("commit is present");
                    assert!(begin < acquire && acquire < work && work < commit);
                    assert!(!steps.contains(&LockStep::PgAdvisoryUnlock));
                }
                PgScope::Session => {
                    let acquire = index_of(
                        steps,
                        if wait {
                            LockStep::PgAdvisoryLock
                        } else {
                            LockStep::PgTryAdvisoryLock
                        },
                    )
                    .expect("session acquire is present");
                    let release = index_of(steps, LockStep::PgAdvisoryUnlock)
                        .expect("session release is present");
                    assert!(acquire < work && work < release);
                    assert!(!steps.contains(&LockStep::PgBegin));
                    assert!(!steps.contains(&LockStep::PgCommit));
                }
            }
        }
    }
}

#[cfg(test)]
mod model_tests {
    use std::collections::{HashSet, VecDeque};

    use super::fence::{
        FenceDecisionKind, FenceWatermark, FencedWriteRequest, FencingTokenText, evaluate_fence,
    };
    use super::key::LockKey;
    use super::plan::{LockLayers, LockStep, PgScope, plan};

    #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
    struct Request {
        token: u8,
        identity: u8,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
    struct Mark {
        token: u8,
        identity: u8,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
    enum Phase {
        Start,
        Classified(FenceDecisionKind),
        AfterAtomic(FenceDecisionKind),
        Done,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
    struct Actor {
        request: Request,
        phase: Phase,
        crashes_left: u8,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
    struct State {
        watermark: Option<Mark>,
        applied_by_token: [u8; 3],
        actors: [Actor; 2],
    }

    fn production_request(request: Request) -> FencedWriteRequest {
        FencedWriteRequest::new(
            "model/tenant",
            LockKey::new("model/resource").unwrap(),
            FencingTokenText::from_u64(u64::from(request.token)),
            if request.identity == 0 {
                "operation-a"
            } else {
                "operation-b"
            },
            if request.identity == 0 {
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            } else {
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            },
            None,
            None,
        )
        .unwrap()
    }

    fn production_watermark(mark: Mark) -> FenceWatermark {
        FenceWatermark::from_request(&production_request(Request {
            token: mark.token,
            identity: mark.identity,
        }))
    }

    fn classify(watermark: Option<Mark>, request: Request) -> FenceDecisionKind {
        let current = watermark.map(production_watermark);
        evaluate_fence(current.as_ref(), &production_request(request))
            .unwrap()
            .kind
    }

    fn assert_state(state: &State) {
        assert!(state.applied_by_token.iter().all(|count| *count <= 1));
        if let Some(mark) = state.watermark {
            for token in usize::from(mark.token + 1)..state.applied_by_token.len() {
                assert_eq!(state.applied_by_token[token], 0);
            }
            assert_eq!(state.applied_by_token[usize::from(mark.token)], 1);
        } else {
            assert_eq!(state.applied_by_token, [0, 0, 0]);
        }
    }

    fn assert_transition(before: &State, after: &State) {
        if let (Some(old), Some(new)) = (before.watermark, after.watermark) {
            assert!(
                new.token >= old.token,
                "watermark regressed: {old:?} -> {new:?}"
            );
        }
        for index in 0..before.applied_by_token.len() {
            assert!(after.applied_by_token[index] >= before.applied_by_token[index]);
            assert!(after.applied_by_token[index] <= 1);
        }
        assert_state(after);
    }

    fn apply_advanced(state: &mut State, request: Request) {
        if let Some(current) = state.watermark {
            assert!(request.token > current.token);
        }
        let slot = &mut state.applied_by_token[usize::from(request.token)];
        assert_eq!(*slot, 0, "one token generation applied twice");
        *slot = 1;
        state.watermark = Some(Mark {
            token: request.token,
            identity: request.identity,
        });
    }

    fn successors(state: State, actor_index: usize) -> Vec<State> {
        let actor = state.actors[actor_index];
        let mut next = Vec::new();
        match actor.phase {
            Phase::Start => {
                let mut classified = state;
                classified.actors[actor_index].phase =
                    Phase::Classified(classify(state.watermark, actor.request));
                next.push(classified);
            }
            Phase::Classified(_cached) => {
                if actor.crashes_left > 0 {
                    let mut crashed = state;
                    crashed.actors[actor_index].phase = Phase::Start;
                    crashed.actors[actor_index].crashes_left -= 1;
                    next.push(crashed);
                }

                let mut atomic = state;
                let decision = classify(state.watermark, actor.request);
                if decision == FenceDecisionKind::Advanced {
                    apply_advanced(&mut atomic, actor.request);
                }
                atomic.actors[actor_index].phase = Phase::AfterAtomic(decision);
                next.push(atomic);
            }
            Phase::AfterAtomic(_decision) => {
                let mut returned = state;
                returned.actors[actor_index].phase = Phase::Done;
                next.push(returned);

                if actor.crashes_left > 0 {
                    let mut crashed = state;
                    crashed.actors[actor_index].phase = Phase::Start;
                    crashed.actors[actor_index].crashes_left -= 1;
                    next.push(crashed);
                }
            }
            Phase::Done => {}
        }
        for candidate in &next {
            assert_transition(&state, candidate);
        }
        next
    }

    fn complete_without_more_crashes(mut state: State) -> State {
        for actor in &mut state.actors {
            actor.crashes_left = 0;
        }
        for _ in 0..8 {
            if state.actors.iter().all(|actor| actor.phase == Phase::Done) {
                return state;
            }
            for actor_index in 0..state.actors.len() {
                if state.actors[actor_index].phase == Phase::Done {
                    continue;
                }
                let candidates = successors(state, actor_index);
                state = candidates
                    .into_iter()
                    .find(|candidate| !matches!(candidate.actors[actor_index].phase, Phase::Start))
                    .expect("a crash-free progress transition exists");
            }
        }
        panic!("crash-free fair completion exceeded the finite model bound");
    }

    fn explore(initial: State, seen_decisions: &mut [bool; 4]) {
        let mut queue = VecDeque::from([initial]);
        let mut visited = HashSet::from([initial]);
        while let Some(state) = queue.pop_front() {
            assert_state(&state);
            let completed = complete_without_more_crashes(state);
            assert!(
                completed
                    .actors
                    .iter()
                    .all(|actor| actor.phase == Phase::Done)
            );

            for actor in state.actors {
                let decision = match actor.phase {
                    Phase::Classified(decision) | Phase::AfterAtomic(decision) => Some(decision),
                    Phase::Start | Phase::Done => None,
                };
                if let Some(decision) = decision {
                    seen_decisions[match decision {
                        FenceDecisionKind::Advanced => 0,
                        FenceDecisionKind::Replay => 1,
                        FenceDecisionKind::Stale => 2,
                        FenceDecisionKind::TokenReuse => 3,
                    }] = true;
                }
            }

            for actor_index in 0..state.actors.len() {
                for candidate in successors(state, actor_index) {
                    if visited.insert(candidate) {
                        queue.push_back(candidate);
                    }
                }
            }
        }
    }

    #[test]
    fn every_two_holder_crash_retry_schedule_preserves_atomic_fencing() {
        let requests: Vec<Request> = (0..=2)
            .flat_map(|token| (0..=1).map(move |identity| Request { token, identity }))
            .collect();
        let mut seen_decisions = [false; 4];

        for first in &requests {
            for second in &requests {
                for initial in [
                    None,
                    Some(Mark {
                        token: 0,
                        identity: 0,
                    }),
                ] {
                    let mut applied = [0, 0, 0];
                    if let Some(mark) = initial {
                        applied[usize::from(mark.token)] = 1;
                    }
                    explore(
                        State {
                            watermark: initial,
                            applied_by_token: applied,
                            actors: [
                                Actor {
                                    request: *first,
                                    phase: Phase::Start,
                                    crashes_left: 1,
                                },
                                Actor {
                                    request: *second,
                                    phase: Phase::Start,
                                    crashes_left: 1,
                                },
                            ],
                        },
                        &mut seen_decisions,
                    );
                }
            }
        }
        assert_eq!(seen_decisions, [true, true, true, true]);
    }

    #[test]
    fn negative_control_witnesses_why_cached_classification_is_unsafe() {
        let low = Request {
            token: 1,
            identity: 0,
        };
        let high = Request {
            token: 2,
            identity: 0,
        };
        assert_eq!(classify(None, low), FenceDecisionKind::Advanced);
        assert_eq!(classify(None, high), FenceDecisionKind::Advanced);

        let mut unsafe_watermark = Some(Mark {
            token: high.token,
            identity: high.identity,
        });
        unsafe_watermark = Some(Mark {
            token: low.token,
            identity: low.identity,
        });
        assert_eq!(unsafe_watermark.unwrap().token, 1);
        assert!(
            classify(
                Some(Mark {
                    token: high.token,
                    identity: high.identity,
                }),
                low
            ) == FenceDecisionKind::Stale
        );
    }

    #[test]
    fn all_eight_lock_plan_inputs_preserve_the_layer_contract() {
        for layers in [
            LockLayers::NONE,
            LockLayers::FIDUCIA_ONLY,
            LockLayers::PG_ONLY,
            LockLayers::BOTH,
        ] {
            for scope in [PgScope::Transaction, PgScope::Session] {
                for wait in [false, true] {
                    let steps = plan(layers, scope, wait).steps;
                    assert_eq!(
                        steps.iter().filter(|step| **step == LockStep::Work).count(),
                        1
                    );
                    if layers.fiducia {
                        assert!(matches!(
                            steps.first(),
                            Some(LockStep::FiduciaAcquire | LockStep::FiduciaTryAcquire)
                        ));
                        assert_eq!(steps.last(), Some(&LockStep::FiduciaRelease));
                    }
                }
            }
        }
    }
}
