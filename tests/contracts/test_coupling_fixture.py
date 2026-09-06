"""Source-level checks for the alien fixture; API coverage belongs to the matrix."""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from worldfixture_compiler import build_world, load_world, validate_world
from worldfixture_compiler.compiler import _validate_commerce, _validate_social

ROOT = Path(__file__).resolve().parents[2]
GENERATOR = ROOT / "tests/fixtures/alien-world.py"
SPEC = importlib.util.spec_from_file_location("alien_world", GENERATOR)
assert SPEC is not None and SPEC.loader is not None
alien = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(alien)


class CouplingFixtureTest(unittest.TestCase):
    def test_same_seed_is_byte_identical_across_process_hash_seeds(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            outputs = []
            for hash_seed in ("7", "89"):
                output = Path(directory) / f"{hash_seed}.json"
                subprocess.run(
                    [sys.executable, str(GENERATOR), "--seed", alien.REGRESSION_SEED,
                     "--variant", "short", "--output", str(output)],
                    env={**os.environ, "PYTHONHASHSEED": hash_seed}, check=True,
                    capture_output=True,
                )
                outputs.append(output.read_bytes())
            self.assertEqual(outputs[0], outputs[1])
            self.assertEqual(outputs[0], alien.source_bytes(alien.REGRESSION_SEED))

    def test_different_seeds_change_owned_content(self) -> None:
        first = alien.generate_world(alien.REGRESSION_SEED)
        second = alien.generate_world("fresh-seed-example")
        self.assertNotEqual(first["id"], second["id"])
        self.assertNotEqual(first["people"], second["people"])
        self.assertTrue(set(first["fixture"]["markers"]).isdisjoint(second["fixture"]["markers"]))

    def test_both_timeline_extremes_have_unique_referenced_arrivals(self) -> None:
        for variant, (count, duration) in alien.VARIANTS.items():
            with self.subTest(variant=variant):
                world = alien.generate_world(alien.REGRESSION_SEED, variant)
                events = world["timeline"]
                self.assertEqual(count, len(events))
                self.assertEqual(count, len({event["id"] for event in events}))
                offsets = [event["after_seconds"] for event in events]
                self.assertEqual(0, offsets[0])
                self.assertEqual(duration, offsets[-1])
                self.assertEqual(sorted(set(offsets)), offsets)
                people = {person["id"] for person in world["people"]}
                channels = {channel["id"] for channel in world["communication"]["channels"]}
                for event in events:
                    payload = event["payload"]
                    if event["kind"] == "incoming-email":
                        self.assertIn(payload["from_id"], people)
                        self.assertIn(payload["to_id"], people)
                    else:
                        self.assertIn(payload["author_id"], people)
                        self.assertIn(payload["channel_id"], channels)

    def test_sparse_source_contains_real_domain_records_without_saas_padding(self) -> None:
        world = alien.generate_world(alien.REGRESSION_SEED)
        self.assertNotIn("profile", world)
        self.assertNotIn("software", world)
        self.assertNotIn("finance", world)
        self.assertNotIn("time_entries", world["work"])
        for person in world["people"]:
            self.assertRegex(person["id"], r"^[a-z][a-z0-9.-]+$")
            self.assertIn(".", person["id"])
            self.assertEqual(1, len(person["name"].split()))
            self.assertNotIn("github_login", person)
            self.assertNotIn("slack_id", person)
            self.assertTrue(person["email"].endswith(".test"))
        tasks = world["work"]["tasks"]
        self.assertEqual(tasks[0]["title"], tasks[1]["title"])
        self.assertNotEqual(tasks[0]["id"], tasks[1]["id"])
        self.assertNotIn(tasks[0]["status"], {"backlog", "ready", "in-progress", "blocked", "review", "done"})
        self.assertEqual([], world["communication"]["calendar_events"])
        for section in ("communication", "commerce", "social"):
            self.assertTrue(any(world[section].values()))
        self.assertNotEqual("USD", world["commerce"]["orders"][0]["currency"])
        people = {person["id"]: person for person in world["people"]}
        products, orders = _validate_commerce(world, people)
        _validate_social(world, people, products, orders)

    def test_generated_vocabulary_does_not_reuse_shipped_owned_identities(self) -> None:
        world = alien.generate_world(alien.REGRESSION_SEED)
        text = json.dumps(world).lower()
        for literal in ("northstar", "maya-chen", "lumen", "relay-core", "marlow", "fieldstone"):
            self.assertNotIn(literal, text)
        for source in sorted((ROOT / "worlds").glob("*/world.json")):
            shipped, _ = load_world(source)
            shipped_text = json.dumps(shipped).lower()
            for marker in world["fixture"]["markers"]:
                self.assertNotIn(marker, shipped_text)
            for person in shipped.get("people", []):
                for key in ("id", "name", "email"):
                    self.assertNotIn(person[key].lower(), text)
            for organization in shipped.get("organizations", []):
                self.assertNotIn(organization["domain"].lower(), text)

    def test_each_variant_builds_and_preserves_all_source_records(self) -> None:
        for variant in alien.VARIANTS:
            with self.subTest(variant=variant), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = root / "source.json"
                source.write_bytes(alien.source_bytes(alien.REGRESSION_SEED, variant))
                expected = json.loads(source.read_bytes())
                validate_world(expected)
                first = build_world(source, root / "first")
                second = build_world(source, root / "second")
                self.assertEqual(first, second)
                self.assertEqual(expected["id"], first["world_id"])
                self.assertIsNone(first["profile"])
                self.assertEqual(expected, json.loads((root / "first/world.json").read_bytes()))
                self.assertEqual(expected["timeline"], json.loads((root / "first/timeline.json").read_bytes()))
                # Do not require empty projections here: that is a current
                # compiler gap, and the image matrix must fail for it until fixed.
                for filename in first["files"]:
                    self.assertEqual((root / "first" / filename).read_bytes(),
                                     (root / "second" / filename).read_bytes())

    def test_invalid_generation_arguments_fail(self) -> None:
        for seed, variant in (("", "short"), ("seed", "unknown")):
            with self.subTest(seed=seed, variant=variant), self.assertRaises(ValueError):
                alien.generate_world(seed, variant)


if __name__ == "__main__":
    unittest.main()
