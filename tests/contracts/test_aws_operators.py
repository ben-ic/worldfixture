"""AWS operator membership comes from an authored policy, with legacy parity."""

from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path

from worldfixture_compiler import WorldError, build_world, validate_world
from worldfixture_compiler.compiler import (
    LEGACY_OPERATOR_LIMIT,
    _aws_projection,
    canonical_json,
    compile_world,
    load_world,
    sha256,
)

ROOT = Path(__file__).resolve().parents[2]
POLICY_FIELDS = ("operator_teams", "operator_ids", "operator_limit")
POLICIES = {
    "business.saas-company.v2": {
        "operator_teams": ["engineering"], "operator_ids": ["maya-chen"], "operator_limit": None,
    },
    "business.saas-company.v3": {
        "operator_teams": ["console", "data", "exports", "platform", "reliability", "security"],
        "operator_ids": ["amara-diallo", "jon-bell", "maya-chen"], "operator_limit": None,
    },
    "consumer.retail-brand.v1": {
        "operator_teams": ["engineering"], "operator_ids": ["iris-mendel"], "operator_limit": None,
    },
}


def source(name: str = "business.saas-company.v2", *, legacy: bool = False) -> dict:
    world, _ = load_world(ROOT / "worlds" / name / "world.json")
    if legacy:
        for field in POLICY_FIELDS:
            world["software"].pop(field, None)
    return world


def user_ids(world: dict) -> list[str]:
    from worldfixture_compiler.sections import provider_world
    people = {person["github_login"]: person["id"] for person in provider_world(world)["people"]}
    return [people[user["user_name"]] for user in _aws_projection(world)["iam"]["users"]]


class AWSOperatorTest(unittest.TestCase):
    def test_shipped_policies_project_the_complete_source_membership(self) -> None:
        for name, policy in POLICIES.items():
            with self.subTest(world=name):
                world = source(name)
                self.assertEqual(policy, {field: world["software"][field] for field in POLICY_FIELDS})
                organization = next(row["id"] for row in world["organizations"] if row.get("primary"))
                expected = sorted(person["id"] for person in world["people"] if (
                    person["organization_id"] == organization
                    and (person.get("team") in policy["operator_teams"] or person["id"] in policy["operator_ids"])
                ))
                compiled = compile_world(world)
                self.assertEqual(expected, user_ids(world))
                self.assertEqual(compiled["projections"]["aws"]["iam"]["users"],
                                 compiled["projections"]["emulator-overlay"]["aws"]["iam"]["users"])
        self.assertIn("theo-martin", user_ids(source()))
        self.assertTrue({"amara-diallo", "jon-bell", "maya-chen"} <= set(user_ids(source("business.saas-company.v3"))))
        self.assertEqual([5, 42, 4], [len(user_ids(source(name))) for name in POLICIES])

    def test_absent_policy_reproduces_reviewed_aws_bytes(self) -> None:
        baseline = json.loads((ROOT / "tests/parity/coupling-artifacts.baseline.json").read_text())
        self.assertEqual(4, LEGACY_OPERATOR_LIMIT)
        for record in baseline["worlds"]:
            with self.subTest(world=record["id"], version=record["version"]):
                world = source(f"{record['id']}.{record['version']}", legacy=True)
                output = canonical_json(_aws_projection(world))
                self.assertEqual(record["files"]["projections/aws.json"], {"sha256": sha256(output), "size": len(output)})

    def test_empty_selection_lists_never_infer_teams_or_primary_membership(self) -> None:
        cases = [
            ({"operator_teams": []}, []),
            ({"operator_ids": []}, []),
            ({"operator_teams": [], "operator_ids": []}, []),
            ({"operator_ids": ["theo-martin"], "operator_limit": None}, ["theo-martin"]),
            ({"operator_teams": [], "operator_ids": ["maya-chen"]}, ["maya-chen"]),
            ({"operator_teams": ["engineering"], "operator_limit": None}, ["hana-ito", "jon-bell", "lucas-meyer", "theo-martin"]),
        ]
        for settings, expected in cases:
            with self.subTest(settings=settings):
                world = source(legacy=True)
                world["software"].update(settings)
                validate_world(world)
                self.assertEqual(expected, user_ids(world))

    def test_limits_distinguish_absent_null_zero_and_positive(self) -> None:
        for limit, expected in [
            (None, ["hana-ito", "jon-bell", "lucas-meyer", "maya-chen", "theo-martin"]),
            (0, []), (2, ["hana-ito", "jon-bell"]),
            (99, ["hana-ito", "jon-bell", "lucas-meyer", "maya-chen", "theo-martin"]),
        ]:
            with self.subTest(limit=limit):
                world = source()
                world["software"]["operator_limit"] = limit
                validate_world(world)
                self.assertEqual(expected, user_ids(world))
        world = source()
        del world["software"]["operator_limit"]
        self.assertEqual(["hana-ito", "jon-bell", "lucas-meyer", "maya-chen"], user_ids(world))
        legacy = source(legacy=True)
        self.assertEqual(["maya-chen", "jon-bell", "lucas-meyer", "hana-ito"], user_ids(legacy))
        legacy["software"]["operator_limit"] = None
        self.assertIn("theo-martin", user_ids(legacy))

    def test_unlimited_policy_grows_and_finite_caps_ignore_source_order(self) -> None:
        for name in POLICIES:
            with self.subTest(world=name):
                world = source(name)
                before = user_ids(world)
                person = copy.deepcopy(next(row for row in world["people"] if row.get("team") in world["software"]["operator_teams"]))
                person.update(id="new-cloud-operator", github_login="new-cloud-operator",
                              email="new-cloud-operator@example.worldfixture.test", slack_id="U999999999")
                world["people"].append(person)
                validate_world(world)
                self.assertEqual(sorted([*before, "new-cloud-operator"]), user_ids(world))
                world["software"]["operator_limit"] = 2
                limited = user_ids(world)
                world["people"].reverse()
                self.assertEqual(limited, user_ids(world))

    def test_explicit_id_can_select_a_person_without_team_and_union_is_unique(self) -> None:
        world = source()
        world["software"]["operator_ids"].append("theo-martin")
        self.assertEqual(1, user_ids(world).count("theo-martin"))
        next(person for person in world["people"] if person["id"] == "theo-martin").pop("team")
        validate_world(world)
        self.assertIn("theo-martin", user_ids(world))

    def test_invalid_values_fail_validation_and_build_before_artifact_writes(self) -> None:
        invalid = []
        for value in (False, True, -1, 1.5, "0", [], {}):
            invalid.append(("operator_limit", value))
        for field in ("operator_teams", "operator_ids"):
            for value in (None, False, "engineering", 4, [""], [4], ["x", "x"]):
                invalid.append((field, value))
        invalid.extend([
            ("operator_teams", ["missing-team"]),
            ("operator_ids", ["missing-person"]),
            ("operator_ids", ["priya-raman"]),
        ])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path, output = root / "source.json", root / "artifact"
            for field, value in invalid:
                with self.subTest(field=field, value=value):
                    world = source()
                    world["software"][field] = value
                    pattern = rf"business.saas-company:v2 software\.{field}"
                    with self.assertRaisesRegex(WorldError, pattern):
                        validate_world(world)
                    path.write_bytes(canonical_json(world))
                    with self.assertRaisesRegex(WorldError, pattern):
                        build_world(path, output)
                    self.assertFalse(output.exists())

    def test_external_only_teams_and_ids_have_reference_errors(self) -> None:
        world = source()
        next(person for person in world["people"] if person["id"] == "priya-raman")["team"] = "external-only"
        world["software"]["operator_teams"] = ["external-only"]
        with self.assertRaisesRegex(WorldError, "unknown primary-organization teams"):
            validate_world(world)
        world["software"]["operator_teams"] = []
        world["software"]["operator_ids"] = ["priya-raman"]
        with self.assertRaisesRegex(WorldError, "outside the primary organization"):
            validate_world(world)
        world["software"]["operator_ids"] = ["missing-person"]
        with self.assertRaisesRegex(WorldError, "unknown people"):
            validate_world(world)
