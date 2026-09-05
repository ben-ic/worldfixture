"""Every service entrypoint installs its cleanup trap before it starts a child.

WHY THIS IS A TEST AND NOT A CODE REVIEW. `emulators/mail/worldfixture-entrypoint.sh`
installed `trap stop INT TERM EXIT` 84 lines after `cyrus master` was already
running. Four explicit exits sat in the gap, and so did every `set -e` failure.
Each one killed the shell and left Cyrus holding its ports, so the supervisor
restarted the service and the new `cyrus master` could not bind -- a permanent
restart loop, from a fault whose only symptom is that the container never comes
up. `emulators/s3/worldfixture-entrypoint.sh` had the ordering right the whole
time, which is exactly why the defect survived: reading either script alone
tells you nothing about the other.

The check is deliberately shallow. It does not model shell semantics; it asks
one question about line order that a reviewer would have to re-derive by hand
for every script every time one of them changes.

`postgres` and `mysql` `exec` their server as PID 1 and start no background
child, so they have nothing to trap and are covered by the same rule trivially.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ENTRYPOINTS = sorted((ROOT / "emulators").glob("*/worldfixture-entrypoint.sh"))

# A command put into the background: the line ends in a single `&`. `&&` is a
# conjunction, and a `&` inside a comment starts nothing.
BACKGROUND = re.compile(r"(?<!&)&\s*$")
# `trap - INT TERM` inside a handler REMOVES a trap. Only an install counts.
TRAP_INSTALL = re.compile(r"^\s*trap\s+(?!-\s)\S+")


def numbered(path: Path) -> list[tuple[int, str]]:
    lines = path.read_text().splitlines()
    return [
        (number, line)
        for number, line in enumerate(lines, start=1)
        if line.strip() and not line.lstrip().startswith("#")
    ]


def first_match(path: Path, pattern: re.Pattern[str]) -> int | None:
    for number, line in numbered(path):
        if pattern.search(line):
            return number
    return None


class EntrypointTrapOrderTest(unittest.TestCase):
    def test_the_repository_has_entrypoints_to_check(self) -> None:
        # A glob that silently matches nothing would make every test below pass.
        self.assertTrue(ENTRYPOINTS, "no worldfixture-entrypoint.sh was found under emulators/")

    def test_every_entrypoint_traps_before_it_starts_a_background_child(self) -> None:
        for path in ENTRYPOINTS:
            with self.subTest(script=path.relative_to(ROOT).as_posix()):
                background = first_match(path, BACKGROUND)
                if background is None:
                    continue
                trap = first_match(path, TRAP_INSTALL)
                self.assertIsNotNone(
                    trap,
                    f"starts a background child at line {background} and never installs a trap, "
                    "so any later exit leaves the child holding its ports",
                )
                self.assertLess(
                    trap,
                    background,
                    f"installs its trap at line {trap} but starts a background child at line "
                    f"{background}; every exit in between leaves the child running and the "
                    "restarted service cannot bind",
                )

    def test_a_script_that_backgrounds_a_child_can_clean_up_after_a_plain_exit(self) -> None:
        # INT and TERM alone do not cover the paths that actually bit mail: a
        # `set -e` failure and an explicit `exit 1` raise no signal. A script
        # closes that gap one of two ways, and both are legitimate -- mail traps
        # EXIT, s3 routes every post-start exit through a `fail()` that kills the
        # child first. Assert the property, not either mechanism, because a test
        # that fails on the reference implementation is worse than no test.
        for path in ENTRYPOINTS:
            with self.subTest(script=path.relative_to(ROOT).as_posix()):
                if first_match(path, BACKGROUND) is None:
                    continue
                body = path.read_text()
                traps_exit = any(
                    TRAP_INSTALL.search(line) and "EXIT" in line
                    for _, line in numbered(path)
                )
                # A helper that terminates the child and then exits. `kill` is
                # what every one of these scripts uses to stop its child.
                kills_before_exiting = re.search(
                    r"\bkill\b[\s\S]{0,400}?\bexit\b", body
                ) is not None
                self.assertTrue(
                    traps_exit or kills_before_exiting,
                    "backgrounds a child but neither traps EXIT nor kills it before exiting, so "
                    "a `set -e` failure or a bare `exit` leaves it holding its ports",
                )


if __name__ == "__main__":
    unittest.main()
