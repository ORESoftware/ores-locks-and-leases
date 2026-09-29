//! Runtime-neutral shared retry timer.
//!
//! High-contention lease waits must not create one OS thread per retry interval.
//! This module keeps one process-wide scheduler thread and wakes futures when
//! their monotonic deadline is reached.

use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::task::{Poll, Waker};
use std::time::{Duration, Instant};

struct SleepState {
    ready: AtomicBool,
    waker: Mutex<Option<Waker>>,
}

struct SleepRequest {
    deadline: Instant,
    state: Arc<SleepState>,
}

static SCHEDULER: OnceLock<mpsc::Sender<SleepRequest>> = OnceLock::new();

fn scheduler() -> &'static mpsc::Sender<SleepRequest> {
    SCHEDULER.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<SleepRequest>();
        std::thread::Builder::new()
            .name("ores-lock-retry-timer".to_owned())
            .spawn(move || run_scheduler(rx))
            .expect("spawn shared retry timer");
        tx
    })
}

fn run_scheduler(rx: mpsc::Receiver<SleepRequest>) {
    let mut pending = Vec::<SleepRequest>::new();

    loop {
        let now = Instant::now();
        let mut index = 0;
        while index < pending.len() {
            if pending[index].deadline <= now {
                let request = pending.swap_remove(index);
                request.state.ready.store(true, Ordering::Release);
                if let Some(waker) = request.state.waker.lock().unwrap().take() {
                    waker.wake();
                }
            } else {
                index += 1;
            }
        }

        let wait = pending
            .iter()
            .map(|request| request.deadline.saturating_duration_since(Instant::now()))
            .min();

        let received = match wait {
            Some(duration) => rx.recv_timeout(duration),
            None => match rx.recv() {
                Ok(request) => {
                    pending.push(request);
                    continue;
                }
                Err(_) => return,
            },
        };

        match received {
            Ok(request) => pending.push(request),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
    }
}

pub(crate) async fn sleep(duration: Duration) {
    if duration.is_zero() {
        return;
    }

    let state = Arc::new(SleepState {
        ready: AtomicBool::new(false),
        waker: Mutex::new(None),
    });
    scheduler()
        .send(SleepRequest {
            deadline: Instant::now() + duration,
            state: Arc::clone(&state),
        })
        .expect("shared retry timer remains alive");

    std::future::poll_fn(move |cx| {
        if state.ready.load(Ordering::Acquire) {
            return Poll::Ready(());
        }
        *state.waker.lock().unwrap() = Some(cx.waker().clone());
        if state.ready.load(Ordering::Acquire) {
            Poll::Ready(())
        } else {
            Poll::Pending
        }
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        use std::task::{Context, Poll, Waker};
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
            .map(|_| std::thread::spawn(|| block_on(sleep(Duration::from_millis(2)))))
            .collect::<Vec<_>>();
        for handle in handles {
            handle.join().expect("waiter");
        }
        assert!(SCHEDULER.get().is_some());
    }

    #[test]
    fn zero_duration_completes() {
        block_on(sleep(Duration::ZERO));
    }
}
