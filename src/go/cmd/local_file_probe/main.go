package main

import (
	"fmt"
	"os"
	"strconv"
	"time"

	oreslocks "github.com/ORESoftware/ores-locks-and-leases/src/go"
)

func usage() {
	fmt.Fprintln(os.Stderr, "usage: local_file_probe <hold|try|crash> <path> <owner> [hold_ms]")
	os.Exit(2)
}

func main() {
	if len(os.Args) < 4 || len(os.Args) > 5 {
		usage()
	}
	mode, path, owner := os.Args[1], os.Args[2], os.Args[3]
	if mode != "hold" && mode != "try" && mode != "crash" {
		usage()
	}
	holdMs := int64(0)
	if len(os.Args) == 5 {
		parsed, err := strconv.ParseInt(os.Args[4], 10, 64)
		if err != nil || parsed < 0 {
			usage()
		}
		holdMs = parsed
	}

	lock, acquired, err := oreslocks.TryAcquireLocalFileLock(path, owner)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ERROR:%v\n", err)
		os.Exit(20)
	}
	if !acquired {
		fmt.Println("CONTENDED")
		os.Exit(10)
	}

	fmt.Println("ACQUIRED")
	switch mode {
	case "hold":
		time.Sleep(time.Duration(holdMs) * time.Millisecond)
	case "try":
	case "crash":
		fmt.Println("CRASHED")
		os.Exit(30)
	}
	if err := lock.Release(); err != nil {
		fmt.Fprintf(os.Stderr, "RELEASE_ERROR:%v\n", err)
		os.Exit(21)
	}
	fmt.Println("RELEASED")
}
