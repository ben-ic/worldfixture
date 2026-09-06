"""Operator changes must preserve source bytes and all unrelated artifact data."""

from __future__ import annotations

import copy
import io
import json
import shutil
import tarfile
import tempfile
import unittest
from pathlib import Path

from worldfixture_compiler.compiler import canonical_json, sha256

from tests.parity.finance_migration import finance_record, reverse_finance_migration
from tests.parity.mail_migration import (
    mail_record,
    reverse_mail_migration,
    write_pre_mail_sources,
)
from tests.parity.operator_migration import (
    OPERATOR_FILES,
    OPERATOR_MIGRATION,
    ROOT,
    assert_operator_semantics,
    digest,
    reverse_operator_migration,
    selected_people,
    source_evidence,
)
from tests.parity.p4_migration import build_historical_finance_stage, bundle_historical_finance_stage
from tests.parity.test_coupling_baseline import read_files


class OperatorMigrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.built = {}
        for record in OPERATOR_MIGRATION["worlds"]:
            with tempfile.TemporaryDirectory() as temporary:
                output = Path(temporary)
                build_historical_finance_stage(ROOT / record["source"], output)
                cls.built[(record["id"], record["version"])] = reverse_mail_migration(reverse_finance_migration(read_files(output)))

    def test_exact_reviewed_migration_scope_and_source_semantics(self) -> None:
        self.assertEqual(OPERATOR_FILES, set(OPERATOR_MIGRATION["allowed_artifact_files"]))
        for record in OPERATOR_MIGRATION["worlds"]:
            with self.subTest(world=record["id"], version=record["version"]):
                self.assertEqual(OPERATOR_FILES, set(record["files"]))
                self.assertEqual(1, len(record["source_migrations"]))
                self.assertTrue(record["reason"])
                self.assertEqual(record["policy"]["operator_limit"], None)
                for change in record["source_migrations"].values():
                    self.assertEqual(3, len(change["inserted_text"].splitlines()))
                files = self.built[(record["id"], record["version"])]
                assert_operator_semantics(self, files)
                restored = reverse_operator_migration(files)
                self.assertEqual(record["from_artifact_sha256"], json.loads(restored["manifest.json"])["artifact_sha256"])
                for name, change in record["files"].items():
                    self.assertEqual(change["from"], digest(restored[name]), name)
                    self.assertEqual(change["to"], digest(files[name]), name)

    def test_exact_source_reversal_preserves_pre_operator_bytes(self) -> None:
        """P4 no longer invents operators for an absent declaration.

        Historical source bytes remain provable through exact migration reversal;
        current absent-policy behavior is covered by compiler contract tests.
        """
        for record in OPERATOR_MIGRATION["worlds"]:
            with self.subTest(world=record["id"], version=record["version"]):
                evidence = source_evidence(record)
                self.assertEqual(record["source_files"], evidence["before_files"])
                self.assertEqual(record["from_source_sha256"], evidence["before_sha256"])

    def test_each_transport_bundle_reverses_content_without_changing_member_metadata(self) -> None:
        for record in OPERATOR_MIGRATION["worlds"]:
            with self.subTest(world=record["id"], version=record["version"]), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary) / "world.tar"
                result = bundle_historical_finance_stage(ROOT / record["source"], path)
                data = path.read_bytes()
                current = finance_record(record["id"], record["version"])["bundle"]["to"]
                self.assertEqual(current["bundle_sha256"], sha256(data))
                self.assertEqual(current["bundle_size"], len(data))
                self.assertEqual(current["content_sha256"], result["content_sha256"])
                self.assertEqual(current["bundle_sha256"], result["artifact_sha256"])
                self.assertEqual(current["bundle_size"], result["artifact_size"])
                with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as archive:
                    members = archive.getmembers()
                    self.assertTrue(all(member.isfile() for member in members))
                    files = {member.name: archive.extractfile(member).read() for member in members}
                self.assertEqual(len(members), len(files), "Duplicate archive members")
                files = reverse_mail_migration(reverse_finance_migration(files))
                self.assertEqual(self.built[(record["id"], record["version"])], files)
                intermediate = io.BytesIO()
                with tarfile.open(fileobj=intermediate, mode="w", format=tarfile.USTAR_FORMAT) as archive:
                    for member in members:
                        content = files[member.name]
                        member.size = len(content)
                        archive.addfile(member, io.BytesIO(content))
                self.assertEqual(record["bundle"]["to"]["bundle_sha256"], sha256(intermediate.getvalue()))
                self.assertEqual(record["bundle"]["to"]["bundle_size"], len(intermediate.getvalue()))
                restored = reverse_operator_migration(files)
                output = io.BytesIO()
                with tarfile.open(fileobj=output, mode="w", format=tarfile.USTAR_FORMAT) as archive:
                    for member in members:
                        content = restored[member.name]
                        member.size = len(content)
                        archive.addfile(member, io.BytesIO(content))
                previous = record["bundle"]["from"]
                self.assertEqual(previous["bundle_sha256"], sha256(output.getvalue()))
                self.assertEqual(previous["bundle_size"], len(output.getvalue()))
                self.assertEqual(previous["content_sha256"], json.loads(restored["manifest.json"])["artifact_sha256"])

    def test_missing_foreign_or_privileged_iam_records_cannot_pass_semantics(self) -> None:
        record = OPERATOR_MIGRATION["worlds"][1]
        original = self.built[(record["id"], record["version"])]
        for mutation in ("missing", "foreign", "access-key", "reordered", "cap-four"):
            with self.subTest(mutation=mutation):
                files = dict(original)
                for name in ("projections/aws.json", "projections/emulator-overlay.json"):
                    document = json.loads(files[name])
                    aws = document if name.endswith("/aws.json") else document["aws"]
                    users = aws["iam"]["users"]
                    if mutation == "missing":
                        users.pop()
                    elif mutation == "foreign":
                        users.append({"user_name": "foreign", "path": "/people/", "create_access_key": False})
                    elif mutation == "access-key":
                        users[0]["create_access_key"] = True
                    elif mutation == "reordered":
                        users.reverse()
                    else:
                        aws["iam"]["users"] = users[:4]
                    files[name] = canonical_json(document)
                with self.assertRaises(AssertionError):
                    assert_operator_semantics(self, files)

    def test_source_people_not_projection_determine_unlimited_union(self) -> None:
        record = OPERATOR_MIGRATION["worlds"][0]
        world = json.loads(self.built[(record["id"], record["version"])]["world.json"])
        original = selected_people(world)
        newcomer = {**original[0], "id": "new-eligible-operator", "github_login": "new.operator"}
        world["people"].insert(0, newcomer)
        self.assertEqual(sorted([person["id"] for person in original] + [newcomer["id"]]), [person["id"] for person in selected_people(world)])
        world["software"]["operator_ids"].append(newcomer["id"])
        self.assertEqual(len(original) + 1, len(selected_people(world)), "Team/ID union cannot duplicate people")
        world["software"]["operator_limit"] = 2
        expected = [person["id"] for person in selected_people(world)]
        world["people"].reverse()
        self.assertEqual(expected, [person["id"] for person in selected_people(world)])
        world["software"]["operator_limit"] = 0
        self.assertEqual([], selected_people(world))
        world["software"] = {"operator_teams": [], "operator_ids": [], "operator_limit": None}
        self.assertEqual([], selected_people(world), "Explicit empty selection cannot fall back to primary/engineering")

    def test_reversal_does_not_hide_unrelated_aws_fields(self) -> None:
        record = OPERATOR_MIGRATION["worlds"][0]
        files = dict(self.built[(record["id"], record["version"])])
        for name in ("projections/aws.json", "projections/emulator-overlay.json"):
            document = json.loads(files[name])
            aws = document if name.endswith("/aws.json") else document["aws"]
            aws["iam"]["roles"][0]["description"] = "Unrelated role drift"
            files[name] = canonical_json(document)
        restored = reverse_operator_migration(files)
        for name in ("projections/aws.json", "projections/emulator-overlay.json"):
            self.assertNotEqual(record["files"][name]["from"], digest(restored[name]))

    def test_new_source_hash_cannot_authorize_unrelated_original_byte_drift(self) -> None:
        record = copy.deepcopy(OPERATOR_MIGRATION["worlds"][0])
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary)
            directory = target / Path(record["source"]).parent
            shutil.copytree(ROOT / Path(record["source"]).parent, directory)
            write_pre_mail_sources(mail_record(record["id"], record["version"]), target)
            name = next(iter(record["source_migrations"]))
            path = directory / name
            data = path.read_bytes() + b"\n"
            path.write_bytes(data)
            # Even if someone accepts the new file hash and source digest, the
            # exact source reversal still has to reproduce the immutable old one.
            record["source_migrations"][name]["to"] = digest(data)
            after = {key: digest((directory / key).read_bytes()) for key in record["source_files"]}
            record["to_source_sha256"] = sha256(canonical_json(after))
            with self.assertRaisesRegex(AssertionError, "Original source bytes not reproduced"):
                source_evidence(record, target)


if __name__ == "__main__":
    unittest.main()
