//! Runtime-neutral shared retry timer.
//!
//! High-contention lease waits must not create one OS thread per retry interval.
//! This module keeps one process-wide scheduler thread, bounds the number of
//! parked sleepers, and releases cancelled registrations promptly.

use std::cmp::Ordering as CmpOrdering;
use std::collections::BinaryHeap;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc,
};
use std::task::{Context, Poll, Waker};
use std::time::{Duration, Instant};

/// A process-wide cap high enough for the 10k-runtime contention target while
/// still preventing accidental unbounded waiter growth.
const MAX_PENDING_SLEEPERS: usize = 16_384;

static ACTIVE_SLEEPERS: AtomicUsize = AtomicUsize::new(0);
static SCHEDULER: OnceLock<Option<mpsc::Sender<SchedulerMessage>>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SleepError {
    Saturated,
    SchedulerUnavailable,
}

impl fmt::Display for SleepError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Saturated => write!(
                f,
                "retry scheduler is saturated at {MAX_PENDING_SLEEPERS} pending sleepers"
            ),
            Self::SchedulerUnavailable => f.write_str("retry scheduler is unavailable"),
        }
    }
}

struct SleepState {
    ready: AtomicBool,
    cancelled: AtomicBool,
    counted: AtomicBool,
    waker: Mutex<Option<Waker>>,
}

impl SleepState {
    fn release_slot(&self) {
        if self.counted.swap(false, Ordering::AcqRel) {
            ACTIVE_SLEEPERS.fetch_sub(1, Ordering::AcqRel);
        }
    }
}

struct SleepRequest {
    deadline: Instant,
    state: Arc<SleepState>,
}

enum SchedulerMessage {
    Sleep(SleepRequest),
    Wake,
}

struct HeapEntry {
    deadline: Instant,
    sequence: u64,
    state: Arc<SleepState>,
}

impl PartialEq for HeapEntry {
    fn eq(&self, other: &Self) -> bool {
        self.deadline == other.deadline && self.sequence == other.sequence
    }
}

impl Eq for HeapEntry {}

impl PartialOrd for HeapEntry {
    fn partial_cmp(&self, other: &Self) -> Option<CmpOrdering> {
        Some(self.cmp(other))
    }
}

impl Ord for HeapEntry {
    fn cmp(&self, other: &Self) -> CmpOrdering {
        // BinaryHeap is a max-heap; reverse ordering gives the earliest
        // deadline priority.
        other
            .deadline
            .cmp(&self.deadline)
            .then_with(|| other.sequence.cmp(&self.sequence))
    }
}

struct SleepFuture {
    state: Arc<SleepState>,
    scheduler: mpsc::Sender<SchedulerMessage>,
}

impl Future for SleepFuture {
    type Output = Result<(), SleepError>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        if self.state.ready.load(Ordering::Acquire) {
            return Poll::Ready(Ok(()));
        }

        {
            let mut slot = self
                .state
                .waker
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if slot.as_ref().is_none_or(|old| !old.will_wake(cx.waker())) {
                *slot = Some(cx.waker().clone());
            }
        }

        if self.state.ready.load(Ordering::Acquire) {
            Poll::Ready(Ok(()))
        } else {
            Poll::Pending
        }
    }
}

impl Drop for SleepFuture {
    fn drop(&mut self) {
        if !self.state.ready.load(Ordering::Acquire) {
            self.state.cancelled.store(true, Ordering::Release);
            self.state.release_slot();
            // Wake the scheduler so a cancelled long-deadline registration can
            // be removed immediately rather than retained until its deadline.
            let _ = self.scheduler.send(SchedulerMessage::Wake);
        }
    }
}

fn scheduler() -> Option<&'static mpsc::Sender<SchedulerMessage>> {
    SCHEDULER
        .get_or_init(|| {
            let (tx, rx) = mpsc::channel::<SchedulerMessage>();
            match std::thread::Builder::new()
                .name("ores-lock-retry-timer".to_owned())
                .spawn(move || run_scheduler(rx))
            {
                Ok(_) => Some(tx),
                Err(_) => None,
            }
        })
        .as_ref()
}

fn reserve_slot() -> Result<(), SleepError> {
    ACTIVE_SLEEPERS
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            (current < MAX_PENDING_SLEEPERS).then_some(current + 1)
        })
        .map(|_| ())
        .map_err(|_| SleepError::Saturated)
}

fn prune_cancelled(pending: &mut BinaryHeap<HeapEntry>) {
    if !pending
        .iter()
        .any(|entry| entry.state.cancelled.load(Ordering::Acquire))
    {
        return;
    }

    let mut retained = BinaryHeap::with_capacity(pending.len());
    while let Some(entry) = pending.pop() {
        if entry.state.cancelled.load(Ordering::Acquire) {
            entry.state.release_slot();
        } else {
            retained.push(entry);
        }
    }
    *pending = retained;
}

fn complete_due(pending: &mut BinaryHeap<HeapEntry>) {
    let now = Instant::now();
    while pending
        .peek()
        .is_some_and(|entry| entry.deadline <= now)
    {
        let entry = pending.pop().expect("peeked entry exists");
        if entry.state.cancelled.load(Ordering::Acquire) {
            entry.state.release_slot();
            continue;
        }
        entry.state.ready.store(true, Ordering::Release);
        entry.state.release_slot();
        if let Some(waker) = entry
            .state
            .waker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            waker.wake();
        }
    }
}

fn run_scheduler(rx: mpsc::Receiver<SchedulerMessage>) {
    let mut pending = BinaryHeap::<HeapEntry>::new();
    let mut sequence = 0u64;

    loop {
        prune_cancelled(&mut pending);
        complete_due(&mut pending);

        let wait = pending
            .peek()
            .map(|entry| entry.deadline.saturating_duration_since(Instant::now()));

        let received = match wait {
            Some(duration) => rx.recv_timeout(duration),
            None => match rx.recv() {
                Ok(message) => {
                    match message {
                        SchedulerMessage::Sleep(request) => {
                            sequence = sequence.wrapping_add(1);
                            pending.push(HeapEntry {
                                deadline: request.deadline,
                                sequence,
                                state: request.state,
                            });
                        }
                        SchedulerMessage::Wake => {}
                    }
                    continue;
                }
                Err(_) => return,
            },
        };

        match received {
            Ok(SchedulerMessage::Sleep(request)) => {
                sequence = sequence.wrapping_add(1);
                pending.push(HeapEntry {
                    deadline: request.deadline,
                    sequence,
                    state: request.state,
                });
            }
            Ok(SchedulerMessage::Wake) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
    }
}

pub(crate) async fn sleep(duration: Duration) -> Result<(), SleepError> {
    if duration.is_zero() {
        return Ok(());
    }

    let scheduler = scheduler()
        .cloned()
        .ok_or(SleepError::SchedulerUnavailable)?;

    reserve_slot()?;
    let state = Arc::new(SleepState {
        ready: AtomicBool::new(false),
        cancelled: AtomicBool::new(false),
        counted: AtomicBool::new(true),
        waker: Mutex::new(None),
    });

    if scheduler
        .send(SchedulerMessage::Sleep(SleepRequest {
            deadline: Instant::now() + duration,
            state: Arc::clone(&state),
        }))
        .is_err()
    {
        state.release_slot();
        return Err(SleepError::SchedulerUnavailable);
    }

    SleepFuture { state, scheduler }.await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block_on<F: Future>(future: F) -> F::Output {
        let mut cx = Context::from_waker(Waker::noop());
        let mut future = std::pin::pin!(future);
        loop {
            if let Poll::Ready(value) = future.as_mut().poll(&mut cx) {
                return value;
            }
            std::thread::yield_now();
        }
    }

    #[test]
    fn shared_scheduler_wakes_many_waiters() {
        let handles = (0..32)
            .map(|_| std::thread::spawn(|| block_on(sleep(Duration::from_millis(2))).unwrap()))
            .collect::<Vec<_>>();
        for handle in handles {
            handle.join().expect("waiter");
        }
        assert!(SCHEDULER.get().is_some());
    }

    #[test]
    fn zero_duration_completes_without_registration() {
        let before = ACTIVE_SLEEPERS.load(Ordering::Acquire);
        block_on(sleep(Duration::ZERO)).unwrap();
        assert_eq!(ACTIVE_SLEEPERS.load(Ordering::Acquire), before);
    }

    #[test]
    fn dropping_sleep_releases_capacity_immediately() {
        let before = ACTIVE_SLEEPERS.load(Ordering::Acquire);
        let mut future = Box::pin(sleep(Duration::from_secs(60)));
        let mut cx = Context::from_waker(Waker::noop());
        assert!(matches!(future.as_mut().poll(&mut cx), Poll::Pending));
        assert_eq!(ACTIVE_SLEEPERS.load(Ordering::Acquire), before + 1);
        drop(future);
        assert_eq!(ACTIVE_SLEEPERS.load(Ordering::Acquire), before);
    }
}
