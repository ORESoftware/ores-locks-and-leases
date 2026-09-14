use ores_locks_and_leases::LocalFileLock;
use std::env;
use std::io::{self, Write};
use std::process;
use std::thread;
use std::time::Duration;

fn usage() -> ! {
    eprintln!("usage: local_file_probe <hold|try> <path> <owner> [hold_ms]");
    process::exit(2);
}

fn main() {
    let mut args = env::args().skip(1);
    let mode = args.next().unwrap_or_else(|| usage());
    let path = args.next().unwrap_or_else(|| usage());
    let owner = args.next().unwrap_or_else(|| usage());
    let hold_ms = args
        .next()
        .map(|value| value.parse::<u64>().unwrap_or_else(|_| usage()))
        .unwrap_or(0);
    if args.next().is_some() {
        usage();
    }

    let mut lock = match LocalFileLock::try_acquire(&path, owner) {
        Ok(Some(lock)) => lock,
        Ok(None) => {
            println!("CONTENDED");
            process::exit(10);
        }
        Err(error) => {
            eprintln!("ERROR:{:?}:{}", error.kind, error.message);
            process::exit(20);
        }
    };

    println!("ACQUIRED");
    io::stdout().flush().expect("flush stdout");
    if mode == "hold" {
        thread::sleep(Duration::from_millis(hold_ms));
    } else if mode != "try" {
        usage();
    }

    if let Err(error) = lock.release() {
        eprintln!("RELEASE_ERROR:{:?}:{}", error.kind, error.message);
        process::exit(21);
    }
    println!("RELEASED");
}
