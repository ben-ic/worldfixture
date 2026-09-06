"""Independent sections retain source records and validate cross-section references."""

from __future__ import annotations

import copy
import json
import runpy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from worldfixture_compiler.compiler import WorldError, build_world, compile_world, load_world, validate_world
from worldfixture_compiler.sections import RECORD_COLLECTIONS

ROOT = Path(__file__).resolve().parents[2]
GENERATE = runpy.run_path(str(ROOT / "tests/fixtures/alien-world.py"))["generate_world"]


def empty_world():
    return {
        "api_version": "worldfixture.world-source/v1",
        "id": "tiny.world",
        "version": "v1",
        "title": "Tiny",
        "synthetic_notice": "All data is synthetic and describes no real person.",
        "scenario": {"id": "normal-world", "class": "normal", "title": "Tiny world"},
        "clock": {"anchor": "2031-01-01T00:00:00Z", "timezone": "UTC", "locale": "en"},
        # A connected test application can inspect these collections without
        # requiring the world to invent a person or a provider account.
        "timeline": [{
            "id": "arrival-inspection", "after_seconds": 1, "kind": "application-event",
            "payload": {"kind": "fixture.inspection.requested", "data": {"inspection": "declared-collections"}},
        }],
    }


class IndependentSectionsTest(unittest.TestCase):
    def test_all_declared_empty_collections_remain_distinct_from_absence(self):
        for section, fields in RECORD_COLLECTIONS.items():
            for field in fields:
                with self.subTest(collection=f"{section}.{field}"):
                    world = empty_world()
                    target = world if section == "identity" else world.setdefault(section, {})
                    target[field] = []
                    result = compile_world(world)
                    self.assertEqual({f"{section}.{field}": []}, result["projections"]["domain"]["collections"])
                    self.assertNotIn("people", result["world"]) if field != "people" else None
        self.assertEqual({}, compile_world(empty_world())["projections"])

    def test_profile_does_not_require_unrelated_sections_or_primary_actor(self):
        world = empty_world()
        world.update(profile="business.operations/v1", people=[{"id": "person.47", "name": "Tavi"}])
        result = compile_world(world)
        self.assertEqual(world["people"], result["packs"]["identity"]["people"])
        self.assertEqual({"domain"}, set(result["projections"]))
        self.assertNotIn("organizations", result["world"])

    def test_alien_records_duplicate_titles_and_native_identities_are_preserved(self):
        for variant in ("short", "long"):
            world = GENERATE("p4-regression", variant)
            original = copy.deepcopy(world)
            result = compile_world(world)
            self.assertEqual(original, world)
            self.assertEqual(world["people"], result["packs"]["identity"]["people"])
            self.assertNotIn("software", result["packs"])
            self.assertNotIn("finance", result["packs"])
            self.assertNotIn("subscriptions", result["projections"]["stripe"])
            self.assertEqual(
                world["commerce"]["orders"], result["projections"]["domain"]["collections"]["commerce.orders"]
            )
            self.assertEqual(
                world["social"]["comments"], result["projections"]["domain"]["collections"]["social.comments"]
            )
            self.assertEqual(len(world["timeline"]), len(result["timeline"]))
            issues = result["projections"]["linear"]["issues"]
            self.assertEqual(2, len(issues))
            self.assertEqual(issues[0]["title"], issues[1]["title"])
            self.assertEqual(
                {task["id"] for task in world["work"]["tasks"]}, {row["worldfixture_task_id"] for row in issues}
            )
            self.assertEqual({task["status"] for task in world["work"]["tasks"]}, {row["state"] for row in issues})
            self.assertEqual(len(world["people"]), len(result["projections"]["google"]["users"]))
            self.assertEqual({"region", "account_id", "s3"}, set(result["projections"]["aws"]))
            self.assertTrue(
                all("slack_id" not in person and "github_login" not in person for person in result["world"]["people"])
            )

    def test_alien_builds_are_byte_deterministic(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "world.json"
            source.write_text(json.dumps(GENERATE("determinism")))
            first = build_world(source, root / "first")
            second = build_world(source, root / "second")
            self.assertEqual(first, second)
            for name in first["files"]:
                self.assertEqual((root / "first" / name).read_bytes(), (root / "second" / name).read_bytes())

    def test_rebuild_removes_obsolete_files_and_keeps_failed_previous_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, output = root / "source.json", root / "artifact"
            world = empty_world()
            world["site"] = {"pages": []}
            source.write_text(json.dumps(world))
            build_world(source, output)
            self.assertTrue((output / "projections/http-targets.json").exists())
            # Simulate a stale generated provider file from an older compiler.
            (output / "projections/obsolete.json").write_text("{}")
            del world["site"]
            source.write_text(json.dumps(world))
            manifest = build_world(source, output)
            self.assertEqual(set(manifest["files"]) | {"manifest.json"}, {
                path.relative_to(output).as_posix() for path in output.rglob("*") if path.is_file()
            })
            previous = {path.relative_to(output): path.read_bytes() for path in output.rglob("*") if path.is_file()}
            world["title"] = "Changed generation"
            source.write_text(json.dumps(world))
            rename = Path.rename

            def fail_publish(path, target):
                if path.name == "artifact" and path.parent.name.startswith(".artifact-build-"):
                    raise OSError("simulated publish failure")
                return rename(path, target)

            with patch.object(Path, "rename", fail_publish), self.assertRaisesRegex(OSError, "publish failure"):
                build_world(source, output)
            self.assertEqual(previous, {path.relative_to(output): path.read_bytes() for path in output.rglob("*") if path.is_file()})
            world["clock"]["anchor"] = "invalid"
            source.write_text(json.dumps(world))
            with self.assertRaises(WorldError):
                build_world(source, output)
            self.assertEqual(previous, {path.relative_to(output): path.read_bytes() for path in output.rglob("*") if path.is_file()})

    def test_failed_rollback_retains_the_previous_artifact_for_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, output = root / "source.json", root / "artifact"
            source.write_text(json.dumps(empty_world()))
            build_world(source, output)
            previous = {path.relative_to(output): path.read_bytes() for path in output.rglob("*") if path.is_file()}
            rename = Path.rename

            def fail_publish_and_restore(path, target):
                if path.parent.name.startswith(".artifact-build-"):
                    raise OSError("simulated filesystem failure")
                return rename(path, target)

            with patch.object(Path, "rename", fail_publish_and_restore), self.assertRaisesRegex(WorldError, "previous artifact retained"):
                build_world(source, output)
            backups = list(root.glob(".artifact-build-*/previous"))
            self.assertEqual(1, len(backups))
            self.assertEqual(previous, {path.relative_to(backups[0]): path.read_bytes() for path in backups[0].rglob("*") if path.is_file()})

    def test_build_never_removes_unrelated_output_or_follows_output_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.json"
            source.write_text(json.dumps(empty_world()))
            output = root / "user-files"
            output.mkdir()
            (output / "notes.txt").write_text("preserve this")
            with self.assertRaisesRegex(WorldError, "non-artifact"):
                build_world(source, output)
            (root / "linked").symlink_to(output, target_is_directory=True)
            with self.assertRaisesRegex(WorldError, "symlink"):
                build_world(source, root / "linked")
            self.assertEqual("preserve this", (output / "notes.txt").read_text())
            artifact = root / "artifact"
            build_world(source, artifact)
            (artifact / "notes.txt").write_text("also preserve")
            with self.assertRaisesRegex(WorldError, "unrelated"):
                build_world(source, artifact)
            self.assertEqual("also preserve", (artifact / "notes.txt").read_text())

    def test_apple_requires_a_declared_application_and_microsoft_service_scope(self):
        for source in (GENERATE("apple-policy"), load_world(ROOT / "worlds/business.saas-company.v2/world.json")[0]):
            for clients in (None, [], [{"client_id": "declared-apple", "name": "Declared Apple", "redirect_uris": ["http://application.test/callback"]}]):
                world = copy.deepcopy(source)
                if clients is not None:
                    world.setdefault("software", {})["oauth_clients"] = {"apple": clients}
                result = compile_world(world)
                self.assertEqual(bool(clients), "apple" in result["projections"])
                overlay = result["projections"]["emulator-overlay"]
                self.assertEqual(bool(clients), "apple" in overlay)
                self.assertEqual(bool(clients), "apple_token" in overlay["tokens"])
                self.assertIn("User.ReadBasic.All", overlay["tokens"]["microsoft_token"]["scopes"])
                self.assertEqual(world["people"], result["packs"]["identity"]["people"])
                if clients:
                    self.assertEqual({person["id"] for person in world["people"]}, {
                        person["worldfixture_person_id"] for person in result["projections"]["apple"]["users"]
                    })

    def test_github_full_projection_preserves_source_organizations_members_and_labels(self):
        world = load_world(ROOT / "worlds/business.saas-company.v2/world.json")[0]
        world["software"]["repositories"][0]["issues"][0]["labels"] = ["authored-label"]
        result = compile_world(world)
        github = result["projections"]["emulator-overlay"]["github"]
        self.assertEqual({row["slug"] for row in world["organizations"]}, {row["login"] for row in github["orgs"]})
        self.assertEqual({row["github_login"] for row in world["people"]}, {row["login"] for row in github["users"]})
        people = {row["id"]: row for row in world["people"]}
        for source, actual in zip(world["software"]["repositories"], github["repos"], strict=True):
            self.assertEqual([{"username": people[identity]["github_login"], "permission": "push"} for identity in source.get("member_ids", [])], actual["collaborators"])
        self.assertEqual(["authored-label"], github["repos"][0]["issues"][0]["labels"])

    def test_no_primary_person_is_needed_to_seed_declared_mail(self):
        world = GENERATE("no-primary")
        for person in world["people"]:
            person.pop("primary", None)
        result = compile_world(world)
        self.assertEqual(7, len(result["projections"]["google"]["users"]))
        self.assertTrue(all("primary" not in row for row in result["packs"]["identity"]["people"]))

    def test_http_page_only_world_does_not_create_company_or_story_endpoints(self):
        world = empty_world()
        world["site"] = {"pages": [{"path": "/bonjour", "title": "Bonjour", "body": "Salut"}]}
        result = compile_world(world)
        http = result["projections"]["http-targets"]
        self.assertEqual(world["site"]["pages"], http["pages"])
        self.assertNotIn("feeds", http)
        self.assertNotIn("api", http)

    def test_unknown_reference_fails_before_output_creation(self):
        world = GENERATE("bad-reference")
        world["work"]["tasks"][0]["assignee_id"] = "absent-person"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "world.json"
            source.write_text(json.dumps(world))
            with self.assertRaisesRegex(WorldError, "work.tasks.*assignee_id.*unknown reference"):
                build_world(source, root / "out")
            self.assertFalse((root / "out").exists())

    def test_bad_shapes_fail_with_world_error(self):
        for key, value in [("people", {}), ("people", [None]), ("communication", []), ("timeline", [None])]:
            world = empty_world()
            world[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(WorldError):
                compile_world(world)
        for value in (None, {}, [None], 123):
            world = GENERATE("bad-mail")
            world["timeline"][0]["payload"]["labels"] = value
            with self.subTest(labels=value), self.assertRaisesRegex(WorldError, "labels"):
                compile_world(world)

    def test_duplicate_domain_ids_and_nested_unknown_refs_fail(self):
        world = GENERATE("duplicates")
        world["commerce"]["products"].append(copy.deepcopy(world["commerce"]["products"][0]))
        with self.assertRaisesRegex(WorldError, "duplicate"):
            compile_world(world)
        world = GENERATE("nested-refs")
        world["communication"]["channels"][0]["messages"][0]["entity_refs"] = {"document_id": "missing-document"}
        with self.assertRaisesRegex(WorldError, "entity_refs.*unknown reference"):
            compile_world(world)

    def test_domain_operation_validates_schema_refs_and_target_collection(self):
        world = GENERATE("operation")
        order = copy.deepcopy(world["commerce"]["orders"][0])
        order["id"] = "order.future"
        operation = {
            "api_version": "worldfixture.runtime-operation/v1",
            "type": "commerce.order.place.v1",
            "actor_id": world["people"][0]["id"],
            "record": order,
        }
        world["timeline"] = [
            {"id": "arrival.order", "after_seconds": 1, "kind": "domain-operation", "payload": operation}
        ]
        self.assertEqual(world["timeline"], compile_world(world)["timeline"])
        operation["actor_id"] = "unknown-person"
        with self.assertRaisesRegex(WorldError, "actor_id"):
            compile_world(world)
        operation["actor_id"] = world["people"][0]["id"]
        operation["record"]["total_cents"] += 1
        with self.assertRaisesRegex(WorldError, "states total"):
            compile_world(world)

    def test_oauth_only_retail_has_clients_and_real_users_without_a_repository(self):
        from worldfixture_compiler.oauth import CLIENT_COLLECTIONS
        world, _ = load_world(ROOT / "worlds/consumer.retail-brand.v1/world.json")
        world["software"]["oauth_clients"] = {
            provider: [{"client_id": f"test-{provider}", "name": f"Test {provider}", "redirect_uris": ["http://application.test/callback"]}]
            for provider in CLIENT_COLLECTIONS
        }
        result = compile_world(world)
        overlay = result["projections"]["emulator-overlay"]
        for provider, key in CLIENT_COLLECTIONS.items():
            self.assertEqual(f"test-{provider}", overlay[provider][key][0]["client_id"])
            self.assertTrue(overlay[provider]["users"], provider)
        self.assertEqual([], overlay["github"]["repos"])
        self.assertEqual([], overlay["vercel"]["projects"])
        self.assertNotIn("repositories", result["world"]["software"])

    def test_default_tokens_never_choose_the_first_person_without_primary(self):
        world = GENERATE("no-default-actor")
        for person in world["people"]:
            person.pop("primary", None)
        tokens = compile_world(world)["projections"]["emulator-overlay"]["tokens"]
        for name in ("demo_token", "slack_token", "linear_token", "notion_token", "stripe_token", "microsoft_token", "apple_token"):
            self.assertNotIn(name, tokens)
        self.assertTrue(all(f"google_token_{person['id']}" in tokens for person in world["people"]))
        self.assertTrue(all(f"linear_token_{person['id']}" in tokens for person in world["people"]))

    def test_document_without_email_owner_remains_a_canonical_document(self):
        world = empty_world()
        world["people"] = [{"id": "person.one", "name": "Tavi"}]
        world["communication"] = {"documents": [{"id": "document.one", "owner_id": "person.one", "content": "A note"}]}
        result = compile_world(world)
        self.assertEqual(world["communication"]["documents"], result["projections"]["domain"]["collections"]["communication.documents"])
        self.assertNotIn("google", result["projections"])
        self.assertEqual("A note", result["projections"]["aws"]["s3"]["objects"][0]["content"])

    def test_rules_must_be_executable_or_explicitly_descriptive(self):
        world = empty_world()
        world["agentic"] = {"causal_rules": [{"id": "rule.one", "when": "something"}]}
        with self.assertRaisesRegex(WorldError, "explicitly descriptive"):
            compile_world(world)
        world["agentic"]["causal_rules"][0].update(
            execution="descriptive", reason="Story relation without an operation payload"
        )
        validate_world(world)
        world["agentic"]["causal_rules"][0]["api_version"] = "worldfixture.causal-rule/v1"
        with self.assertRaisesRegex(WorldError, "causal rule"):
            compile_world(world)

    def test_retail_source_has_no_artificial_repositories_time_entries_or_provider_ids(self):
        world, _ = load_world(ROOT / "worlds/consumer.retail-brand.v1/world.json")
        result = compile_world(world)
        self.assertNotIn("repositories", world["software"])
        self.assertNotIn("time_entries", world["work"])
        self.assertTrue(all(not {"github_login", "slack_id"} & person.keys() for person in world["people"]))
        self.assertNotIn("software.repositories", result["projections"]["domain"]["collections"])
        self.assertNotIn("work.time_entries", result["projections"]["domain"]["collections"])
        self.assertEqual(world["commerce"]["orders"], result["projections"]["domain"]["collections"]["commerce.orders"])


if __name__ == "__main__":
    unittest.main()
