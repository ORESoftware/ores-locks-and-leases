//! Runtime-neutral shared retry timer.
//!
//! High-contention lease waits must not create one OS thread per retry interval.
//! This module keeps one process-wide scheduler thread, bounds the number of
//! parked sleepers, and removes cancelled registrations by key.

use std::collections::BTreeMap;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    mpsc,
};
use std::task::{Context, Poll, Waker};
use std::time::{Duration, Instant};

/// A process-wide cap high enough for the 10k-runtime contention target while
/// still preventing accidental unbounded waiter growth.
const MAX_PENDING_SLEEPERS: usize = 16_384;

static ACTIVE_SLEEPERS: AtomicUsize = AtomicUsize::new(0);
static NEXT_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static SCHEDULER: OnceLock<Option<mpsc::Sender<SchedulerMessage>>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SleepError {
    Saturated,
    SchedulerUnavailable,
    DeadlineOverflow,
    SequenceExhausted,
}

impl fmt::Display for SleepError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Saturated => write!(
                f,
                "retry scheduler is saturated at {MAX_PENDING_SLEEPERS} pending sleepers"
            ),
            Self::SchedulerUnavailable => f.write_str("retry scheduler is unavailable"),
            Self::DeadlineOverflow => f.write_str("retry deadline exceeds monotonic clock range"),
            Self::SequenceExhausted => f.write_str("retry scheduler sequence space exhausted"),
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct SleepKey {
    deadline: Instant,
    sequence: u64,
}

struct SleepRequest {
    key: SleepKey,
    state: Arc<SleepState>,
}

enum SchedulerMessage {
    Sleep(SleepRequest),
    Cancel(SleepKey),
}

struct SleepFuture {
    key: SleepKey,
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
        if self.state.ready.load(Ordering::Acquire) {
            return;
        }

        self.state.cancelled.store(true, Ordering::Release);
        // Keep the registration counted until the scheduler acknowledges
        // removal. This prevents cancellation churn from bypassing the global
        // waiter cap and growing the message queue without bound.
        if self
            .scheduler
            .send(SchedulerMessage::Cancel(self.key))
            .is_err()
        {
            // The scheduler is permanently gone, so no background owner can
            // release the registration for us.
            self.state.release_slot();
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

fn next_sequence() -> Result<u64, SleepError> {
    NEXT_SEQUENCE
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            current.checked_add(1)
        })
        .map_err(|_| SleepError::SequenceExhausted)
}

fn complete_due(pending: &mut BTreeMap<SleepKey, Arc<SleepState>>) {
    let now = Instant::now();
    loop {
        let Some((&key, _)) = pending.first_key_value() else {
            return;
        };
        if key.deadline > now {
            return;
        }
        let Some((_key, state)) = pending.pop_first() else {
            return;
        };
        if !state.cancelled.load(Ordering::Acquire) {
            state.ready.store(true, Ordering::Release);
            if let Some(waker) = state
                .waker
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take()
            {
                waker.wake();
            }
        }
        state.release_slot();
    }
}

fn accept_message(
    pending: &mut BTreeMap<SleepKey, Arc<SleepState>>,
    message: SchedulerMessage,
) {
    match message {
        SchedulerMessage::Sleep(request) => {
            if request.state.cancelled.load(Ordering::Acquire) {
                request.state.release_slot();
            } else {
                pending.insert(request.key, request.state);
            }
        }
        SchedulerMessage::Cancel(key) => {
            if let Some(state) = pending.remove(&key) {
                state.release_slot();
            }
            // If the matching Sleep message has not been handled yet, FIFO
            // order from this sender guarantees it will be observed first.
            // If the registration was already completed, release_slot is
            // intentionally idempotent.
        }
    }
}

fn run_scheduler(rx: mpsc::Receiver<SchedulerMessage>) {
    let mut pending = BTreeMap::<SleepKey, Arc<SleepState>>::new();

    loop {
        complete_due(&mut pending);

        let wait = pending
            .first_key_value()
            .map(|(key, _)| key.deadline.saturating_duration_since(Instant::now()));

        let received = match wait {
            Some(duration) => rx.recv_timeout(duration).map_err(Some),
            None => rx.recv().map_err(|_| None),
        };

        match received {
            Ok(message) => accept_message(&mut pending, message),
            Err(Some(mpsc::RecvTimeoutError::Timeout)) => {}
            Err(Some(mpsc::RecvTimeoutError::Disconnected)) | Err(None) => {
                for state in pending.into_values() {
                    state.release_slot();
                }
                return;
            }
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

    let deadline = match Instant::now().checked_add(duration) {
        Some(deadline) => deadline,
        None => {
            ACTIVE_SLEEPERS.fetch_sub(1, Ordering::AcqRel);
            return Err(SleepError::DeadlineOverflow);
        }
    };
    let sequence = match next_sequence() {
        Ok(sequence) => sequence,
        Err(error) => {
            ACTIVE_SLEEPERS.fetch_sub(1, Ordering::AcqRel);
            return Err(error);
        }
    };
    let key = SleepKey { deadline, sequence };
    let state = Arc::new(SleepState {
        ready: AtomicBool::new(false),
        cancelled: AtomicBool::new(false),
        counted: AtomicBool::new(true),
        waker: Mutex::new(None),
    });

    if scheduler
        .send(SchedulerMessage::Sleep(SleepRequest {
            key,
            state: Arc::clone(&state),
        }))
        .is_err()
    {
        state.release_slot();
        return Err(SleepError::SchedulerUnavailable);
    }

    SleepFuture {
        key,
        state,
        scheduler,
    }
    .await
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

    fn wait_for_active(expected: usize) {
        let deadline = Instant::now() + Duration::from_secs(1);
        while ACTIVE_SLEEPERS.load(Ordering::Acquire) != expected && Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert_eq!(ACTIVE_SLEEPERS.load(Ordering::Acquire), expected);
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
    fn dropping_sleep_cancels_and_releases_capacity() {
        let before = ACTIVE_SLEEPERS.load(Ordering::Acquire);
        let mut future = Box::pin(sleep(Duration::from_secs(60)));
        let mut cx = Context::from_waker(Waker::noop());
        assert!(matches!(future.as_mut().poll(&mut cx), Poll::Pending));
        assert_eq!(ACTIVE_SLEEPERS.load(Ordering::Acquire), before + 1);
        drop(future);
        wait_for_active(before);
    }
}
