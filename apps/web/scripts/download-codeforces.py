#!/usr/bin/env python3
"""
Download and filter Codeforces problems from open-r1/codeforces dataset.

Filters:
  - Rating 800-1200 (easy problems)
  - stdio input mode
  - No interactive problems
  - No generated checker (custom checker required)
  - At least 5 official test cases

Output: /tmp/cf_problems.json (override with CF_OUTPUT_PATH)

Usage:
  pip install datasets
  python3 scripts/download-codeforces.py

Environment overrides (all optional; the defaults keep the old behaviour of writing /tmp/cf_problems.json):
  CF_PROBLEM_LIMIT   how many problems to keep, ranked by number of official tests (default 240, so the
                     corpus is comfortably "200+")
  CF_OUTPUT_PATH     where to write the JSON (default /tmp/cf_problems.json; scripts/import-codeforces.ts
                     reads the same path from CF_PROBLEMS_PATH)
  CF_STREAMING       "1" (default) streams the dataset and stops early instead of downloading every shard
                     (the full split is several GB); "0" downloads the whole split like the original script
  CF_SCAN_FACTOR     streaming only: stop after collecting LIMIT x FACTOR qualifying problems (default 3)
                     and keep the LIMIT with the most official tests among them
"""

import json
import os
import sys
import time

from datasets import load_dataset

LIMIT = int(os.environ.get("CF_PROBLEM_LIMIT", "240"))
OUTPUT_PATH = os.environ.get("CF_OUTPUT_PATH", "/tmp/cf_problems.json")
STREAMING = os.environ.get("CF_STREAMING", "1") != "0"
SCAN_FACTOR = max(1, int(os.environ.get("CF_SCAN_FACTOR", "3")))


def qualifies(row) -> bool:
    rating = row.get("rating") or 0
    if not (800 <= rating <= 1200):
        return False
    if row.get("input_mode") != "stdio":
        return False
    if row.get("interaction_format") is not None:
        return False
    if row.get("generated_checker") is not None:
        return False
    official = row.get("official_tests") or []
    return len(official) >= 5


# Only the columns this script writes out. The dataset also carries very large columns (generated tests, editorials,
# executable checkers) that are never used here; projecting them away cuts the amount of data streamed from the Hub.
COLUMNS = [
    "id", "contest_id", "index", "title", "description", "input_format", "output_format", "note",
    "time_limit", "memory_limit", "rating", "tags", "official_tests", "official_tests_complete",
    "examples", "input_mode", "generated_checker", "interaction_format",
]


def main():
    started = time.time()
    print(f"Loading open-r1/codeforces dataset (streaming={STREAMING}, limit={LIMIT})...", flush=True)
    try:
        ds = load_dataset("open-r1/codeforces", split="train", streaming=STREAMING, columns=COLUMNS)
    except TypeError:  # an older/newer datasets build that does not forward `columns`
        ds = load_dataset("open-r1/codeforces", split="train", streaming=STREAMING)
    if not STREAMING:
        print(f"Total problems in dataset: {len(ds)}")

    filtered = []
    scanned = 0
    stop_after = LIMIT * SCAN_FACTOR
    for row in ds:
        scanned += 1
        if qualifies(row):
            filtered.append(row)
            if STREAMING and len(filtered) >= stop_after:
                break
        if STREAMING and scanned % 100 == 0:
            print(f"  scanned {scanned} rows, {len(filtered)} qualifying so far ({time.time() - started:.0f}s)", flush=True)

    print(f"Rows scanned: {scanned}; problems matching criteria: {len(filtered)}")

    if len(filtered) < LIMIT:
        print(f"Warning: Only {len(filtered)} problems found with rating 800-1200 and 5+ tests")
        print("Consider expanding rating range to 800-1400")

    # Keep the problems with the most official tests (best coverage)
    filtered.sort(key=lambda x: len(x.get("official_tests", [])), reverse=True)
    filtered = filtered[:LIMIT]

    # Convert to JSON-friendly format
    output = []
    for row in filtered:
        output.append({
            "id": row.get("id", ""),
            "contest_id": row.get("contest_id", ""),
            "index": row.get("index", ""),
            "title": row.get("title", ""),
            "description": row.get("description", ""),
            "input_format": row.get("input_format", ""),
            "output_format": row.get("output_format", ""),
            "note": row.get("note"),
            "time_limit": row.get("time_limit", 2.0),
            "memory_limit": row.get("memory_limit", 256),
            "rating": row.get("rating", 800),
            "tags": list(row.get("tags", [])),
            "official_tests": row.get("official_tests", []),
            "official_tests_complete": row.get("official_tests_complete", False),
            "examples": row.get("examples", []),
            "input_mode": row.get("input_mode", "stdio"),
            "generated_checker": row.get("generated_checker"),
            "interaction_format": row.get("interaction_format"),
        })

    with open(OUTPUT_PATH, "w") as f:
        json.dump(output, f)

    print(f"Saved {len(output)} problems to {OUTPUT_PATH} ({os.path.getsize(OUTPUT_PATH) / 1e6:.1f} MB) in {time.time() - started:.0f}s")

    # Print some stats
    ratings = [row.get("rating", 0) for row in filtered]
    test_counts = [len(row.get("official_tests", [])) for row in filtered]
    print(f"\nRating range: {min(ratings)}-{max(ratings)}")
    print(f"Test cases: min={min(test_counts)}, max={max(test_counts)}, avg={sum(test_counts)/len(test_counts):.1f}")

    # Show sample problem titles
    print("\nSample problems:")
    for row in filtered[:10]:
        print(f"  - {row.get('title', 'Unknown')} (rating={row.get('rating')}, tests={len(row.get('official_tests', []))})")


if __name__ == "__main__":
    main()
