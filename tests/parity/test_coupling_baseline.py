"""Hold every shipped world to its immutable pre-fix coupling baseline.

Do not update the original hashes to accept a fix. Add a separate, narrow
migration record and a semantic migration check, as the v2 reference test does.
These checks compare compiler output and checked-in artifacts independently, so
a changed projection cannot define its own passing expected result.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from worldfixture_compiler.compiler import canonical_json, sha256

from tests.parity.finance_migration import (
    FINANCE_MIGRATION,
    assert_finance_semantics,
    finance_record,
    reverse_finance_migration,
)
from tests.parity.mail_migration import (
    MAIL_FILES,
    MAIL_MIGRATION,
    assert_mail_semantics,
    mail_record,
    reverse_mail_migration,
)
from tests.parity.operator_migration import (
    OPERATOR_FILES,
    OPERATOR_MIGRATION,
    assert_operator_semantics,
    operator_record,
    reverse_operator_migration,
    source_evidence,
)
from tests.parity.p4_migration import build_historical_finance_stage

ROOT = Path(__file__).resolve().parents[2]
BASELINE = json.loads((Path(__file__).parent / "coupling-artifacts.baseline.json").read_text())
CALENDAR_MIGRATION = json.loads((Path(__file__).parent / "coupling-calendar-migration.json").read_text())
CALENDAR_FILES = {"manifest.json", "projections/google.json", "projections/emulator-overlay.json"}


def file_digest(data: bytes) -> dict:
    return {"sha256": sha256(data), "size": len(data)}


def reverse_calendar_migration(files: dict[str, bytes]) -> dict[str, bytes]:
    """Restore only the two source calendar arrays and derived manifest hashes.

    The caller must also check the forward semantics. Reversal alone could hide
    a bad calendar transform because it replaces the transformed arrays.
    """
    restored = dict(files)
    source = json.loads(files["world.json"])["communication"]
    for name in ("projections/google.json", "projections/emulator-overlay.json"):
        document = json.loads(files[name])
        google = document if name.endswith("/google.json") else document["google"]
        for key in ("calendars", "calendar_events"):
            google[key] = source.get(key, [])
        restored[name] = canonical_json(document)
    manifest = json.loads(files["manifest.json"])
    for name in CALENDAR_FILES - {"manifest.json"}:
        manifest["files"][name] = file_digest(restored[name])
    manifest["artifact_sha256"] = sha256(canonical_json(manifest["files"]))
    restored["manifest.json"] = canonical_json(manifest)
    return restored


def assert_calendar_semantics(case: unittest.TestCase, files: dict[str, bytes]) -> None:
    """Check each changed field from source, preserving all other authored data."""
    world = json.loads(files["world.json"])
    source = world["communication"]
    primary_email = next(person["email"] for person in world["people"] if person.get("primary"))
    google = json.loads(files["projections/google.json"])
    overlay = json.loads(files["projections/emulator-overlay.json"])["google"]
    for key in ("calendars", "calendar_events"):
        case.assertEqual(google[key], overlay[key], f"Overlay {key} must retain the Google seed data")
        case.assertEqual([row["id"] for row in source.get(key, [])], [row["id"] for row in google[key]])
    owners = {row["id"]: row.get("user_email", primary_email) for row in source.get("calendars", [])}
    for authored, actual in zip(source.get("calendars", []), google["calendars"], strict=True):
        wanted = {key: value for key, value in authored.items() if key not in {"name", "title", "summary", "user_email"}}
        wanted["summary"] = next((authored[key] for key in ("summary", "name", "title", "id") if authored.get(key)), None)
        wanted["user_email"] = authored.get("user_email", primary_email)
        case.assertEqual(wanted, actual, f"Calendar {authored['id']}")
    for authored, actual in zip(source.get("calendar_events", []), google["calendar_events"], strict=True):
        wanted = {key: value for key, value in authored.items() if key not in {"start", "end", "attendees", "user_email"}}
        wanted["user_email"] = authored.get("user_email", owners.get(authored.get("calendar_id"), primary_email))
        wanted["attendees"] = [{"email": value} if isinstance(value, str) else value for value in authored.get("attendees", [])]
        for boundary in ("start", "end"):
            value = authored.get(boundary)
            if value is None:
                continue
            if isinstance(value, str):
                suffix, timestamp = ("date", value) if len(value) == 10 else ("date_time", value)
            else:
                case.assertIsInstance(value, dict)
                case.assertTrue("dateTime" in value or "date" in value, "Unsupported source calendar time")
                suffix, timestamp = ("date_time", value["dateTime"]) if "dateTime" in value else ("date", value["date"])
            wanted[f"{boundary}_{suffix}"] = authored.get(f"{boundary}_{suffix}", timestamp)
        case.assertEqual(wanted, actual, f"Calendar event {authored['id']}")


def read_files(directory: Path) -> dict[str, bytes]:
    return {
        path.relative_to(directory).as_posix(): path.read_bytes()
        for path in directory.rglob("*")
        if path.is_file()
    }


class CouplingBaselineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.built = {}
        for record in BASELINE["worlds"]:
            with tempfile.TemporaryDirectory() as temporary:
                output = Path(temporary)
                build_historical_finance_stage(ROOT / record["source"], output)
                cls.built[(record["id"], record["version"])] = read_files(output)

    def assert_file_parity(self, files: dict[str, bytes], record: dict) -> None:
        from tests.parity.p4_migration import historical_files
        files = historical_files(files)
        finance = finance_record(record['id'], record['version'])
        assert_finance_semantics(self, files)
        before_finance = reverse_finance_migration(files)
        self.assertEqual(mail_record(record['id'], record['version'])['to_artifact_sha256'], finance['from_artifact_sha256'])
        for name, data in files.items():
            expected = file_digest(before_finance[name])
            if name in finance['files']:
                self.assertEqual(expected, finance['files'][name]['from'])
                expected = finance['files'][name]['to']
            self.assertEqual(expected, file_digest(data), f'Current finance migration bytes: {name}')
        files = before_finance
        mail = mail_record(record["id"], record["version"])
        self.assertEqual(MAIL_FILES, set(mail["files"]))
        self.assertEqual(operator_record(record["id"], record["version"])["to_artifact_sha256"], mail["from_artifact_sha256"])
        assert_mail_semantics(self, files)
        before_mail = reverse_mail_migration(files)
        self.assertEqual(set(files), set(before_mail))
        for name, data in files.items():
            expected = file_digest(before_mail[name])
            if name in MAIL_FILES:
                self.assertEqual(expected, mail["files"][name]["from"])
                expected = mail["files"][name]["to"]
            self.assertEqual(expected, file_digest(data), f"Current mail migration bytes: {name}")
        files = before_mail
        migration = next(row for row in CALENDAR_MIGRATION["worlds"] if (row["id"], row["version"]) == (record["id"], record["version"]))
        operators = operator_record(record["id"], record["version"])
        self.assertEqual(OPERATOR_FILES, set(operators["files"]))
        self.assertEqual(record["source"], operators["source"])
        self.assertEqual(record["source_files"], operators["source_files"])
        self.assertEqual(record["source_sha256"], operators["from_source_sha256"])
        self.assertEqual(record["artifact"], operators["artifact"])
        self.assertEqual(migration["to_artifact_sha256"], operators["from_artifact_sha256"])
        assert_operator_semantics(self, files)
        before_operators = reverse_operator_migration(files)
        for name, data in files.items():
            expected = file_digest(before_operators[name])
            if name in OPERATOR_FILES:
                self.assertEqual(expected, operators["files"][name]["from"])
                expected = operators["files"][name]["to"]
            self.assertEqual(expected, file_digest(data), f"Current operator migration bytes: {name}")
        files = before_operators
        self.assertEqual(record["source"], migration["source"])
        self.assertEqual(record["source_sha256"], migration["source_sha256"])
        self.assertEqual(record["artifact"], migration["artifact"])
        self.assertEqual(record["artifact_sha256"], migration["from_artifact_sha256"])
        self.assertEqual(CALENDAR_FILES, set(migration["files"]))
        assert_calendar_semantics(self, files)
        restored = reverse_calendar_migration(files)
        self.assertEqual(set(files), set(record["files"]), "Added and removed files need an explicit migration")
        for name, expected in record["files"].items():
            with self.subTest(file=name):
                self.assertEqual(expected, file_digest(restored[name]), f"Original bytes: {name}")
                if name in CALENDAR_FILES:
                    self.assertEqual(expected, migration["files"][name]["from"])
                    expected = migration["files"][name]["to"]
                self.assertEqual(expected, file_digest(files[name]), f"Current bytes: {name}")

    def test_every_shipped_artifact_has_one_original_record(self) -> None:
        discovered = {}
        for path in (ROOT / "dist").rglob("manifest.json"):
            manifest = json.loads(path.read_text())
            identity = (manifest["world_id"], manifest["world_version"])
            self.assertNotIn(identity, discovered, "Duplicate artifact identity")
            discovered[identity] = path.parent.relative_to(ROOT).as_posix()
        recorded = {(record["id"], record["version"]): record["artifact"] for record in BASELINE["worlds"]}
        self.assertEqual(len(recorded), len(BASELINE["worlds"]), "Duplicate baseline identity")
        self.assertTrue(recorded, "The baseline must contain shipped artifacts")
        self.assertEqual(recorded, discovered, "Record every new artifact and retain each original baseline")
        migrated = [(record["id"], record["version"]) for record in CALENDAR_MIGRATION["worlds"]]
        self.assertEqual(len(migrated), len(set(migrated)), "Duplicate migration identity")
        self.assertEqual(set(recorded), set(migrated))
        operators = [(record["id"], record["version"]) for record in OPERATOR_MIGRATION["worlds"]]
        self.assertEqual(len(operators), len(set(operators)), "Duplicate operator migration identity")
        self.assertEqual(set(recorded), set(operators))
        mail = [(record["id"], record["version"]) for record in MAIL_MIGRATION["worlds"]]
        self.assertEqual(len(mail), len(set(mail)), "Duplicate mail migration identity")
        self.assertEqual(set(recorded), set(mail))
        finance = [(record['id'], record['version']) for record in FINANCE_MIGRATION['worlds']]
        self.assertEqual(len(finance), len(set(finance)))
        self.assertEqual(set(recorded), set(finance))

    def test_compiler_output_matches_original_file_digests_and_sizes(self) -> None:
        for record in BASELINE["worlds"]:
            with self.subTest(world=record["id"], version=record["version"]):
                self.assert_file_parity(self.built[(record["id"], record["version"])], record)

    def test_checked_in_artifacts_match_original_file_digests_and_sizes(self) -> None:
        for record in BASELINE["worlds"]:
            with self.subTest(world=record["id"], version=record["version"]):
                self.assert_file_parity(read_files(ROOT / record["artifact"]), record)

    def test_source_provenance_matches_recorded_files_and_full_digest(self) -> None:
        for record in BASELINE["worlds"]:
            with self.subTest(world=record["id"], version=record["version"]):
                source = ROOT / record["source"]
                document = json.loads(source.read_text())
                identity = document.get("world", document)
                self.assertEqual(record["id"], identity["id"])
                self.assertEqual(record["version"], identity["version"])
                evidence = source_evidence(operator_record(record["id"], record["version"]))
                self.assertEqual(record["source_files"], evidence["before_files"])
                self.assertEqual(record["source_sha256"], evidence["before_sha256"])
                manifest = json.loads(reverse_mail_migration(reverse_finance_migration(self.built[(record["id"], record["version"])]))["manifest.json"])
                self.assertEqual(evidence["after_files"], manifest["source_files"])
                self.assertEqual(evidence["after_sha256"], manifest["source_sha256"])

    def test_full_artifact_digest_is_recomputed_from_built_bytes(self) -> None:
        for record in BASELINE["worlds"]:
            with self.subTest(world=record["id"], version=record["version"]):
                files = self.built[(record["id"], record["version"])]
                digests = {
                    name: {"sha256": sha256(data), "size": len(data)}
                    for name, data in files.items()
                    if name != "manifest.json"
                }
                manifest = json.loads(files["manifest.json"])
                self.assertEqual(digests, manifest["files"])
                migration = next(row for row in CALENDAR_MIGRATION["worlds"] if (row["id"], row["version"]) == (record["id"], record["version"]))
                operators = operator_record(record["id"], record["version"])
                mail = mail_record(record["id"], record["version"])
                finance = finance_record(record['id'], record['version'])
                self.assertEqual(finance["to_artifact_sha256"], sha256(canonical_json(digests)))
                self.assertEqual(finance["to_artifact_sha256"], manifest["artifact_sha256"])
                before_finance = reverse_finance_migration(files)
                self.assertEqual(mail['to_artifact_sha256'], json.loads(before_finance['manifest.json'])['artifact_sha256'])
                before_mail = reverse_mail_migration(before_finance)
                self.assertEqual(operators["to_artifact_sha256"], json.loads(before_mail["manifest.json"])["artifact_sha256"])
                before_operators = reverse_operator_migration(before_mail)
                self.assertEqual(migration["to_artifact_sha256"], json.loads(before_operators["manifest.json"])["artifact_sha256"])
                restored = reverse_calendar_migration(before_operators)
                self.assertEqual(record["artifact_sha256"], json.loads(restored["manifest.json"])["artifact_sha256"])

    def test_calendar_migration_cannot_hide_missing_or_changed_events(self) -> None:
        record = BASELINE["worlds"][0]
        for mutation in ("missing", "attendee", "time", "calendar", "other"):
            with self.subTest(mutation=mutation):
                files = dict(self.built[(record["id"], record["version"])])
                google = json.loads(files["projections/google.json"])
                if mutation == "missing":
                    google["calendar_events"].pop()
                elif mutation == "attendee":
                    google["calendar_events"][0]["attendees"][0]["email"] = "foreign@example.test"
                elif mutation == "time":
                    google["calendar_events"][0]["start_date_time"] = "2099-01-01T00:00:00Z"
                elif mutation == "calendar":
                    google["calendars"][0]["summary"] = "Foreign calendar"
                else:
                    google["calendar_events"][0]["description"] = "Changed unrelated text"
                files["projections/google.json"] = canonical_json(google)
                overlay = json.loads(files["projections/emulator-overlay.json"])
                for key in ("calendars", "calendar_events"):
                    overlay["google"][key] = google[key]
                files["projections/emulator-overlay.json"] = canonical_json(overlay)
                with self.assertRaises(AssertionError):
                    assert_calendar_semantics(self, files)

    def test_calendar_reversal_does_not_hide_unrelated_projection_changes(self) -> None:
        record = BASELINE["worlds"][0]
        files = dict(self.built[(record["id"], record["version"])])
        google = json.loads(files["projections/google.json"])
        google["messages"][0]["subject"] = "Changed unrelated mail"
        files["projections/google.json"] = canonical_json(google)
        assert_calendar_semantics(self, files)
        restored = reverse_calendar_migration(files)
        self.assertNotEqual(record["files"]["projections/google.json"], file_digest(restored["projections/google.json"]))


if __name__ == "__main__":
    unittest.main()
