"""Independent, byte-reversible evidence for the declared operator migration."""

from __future__ import annotations

import copy
import json
from pathlib import Path

from worldfixture_compiler.compiler import canonical_json, sha256

from tests.parity.mail_migration import mail_record, mail_source_evidence

ROOT = Path(__file__).resolve().parents[2]
OPERATOR_MIGRATION = json.loads((Path(__file__).parent / "coupling-operator-migration.json").read_text())
OPERATOR_FIELDS = {"operator_teams", "operator_ids", "operator_limit"}
OPERATOR_FILES = {"manifest.json", "world.json", "packs/software.json", "projections/aws.json", "projections/emulator-overlay.json"}


def digest(data: bytes) -> dict:
    return {"sha256": sha256(data), "size": len(data)}


def operator_record(world_id: str, version: str) -> dict:
    matches = [row for row in OPERATOR_MIGRATION["worlds"] if (row["id"], row["version"]) == (world_id, version)]
    assert len(matches) == 1, "Each migrated identity needs exactly one operator record"
    return matches[0]


def source_evidence(record: dict, source_root: Path = ROOT) -> dict:
    """Remove the exact inserted declarations from current source bytes.

    Old provenance is recomputed from restored bytes, never copied from an old
    manifest. Parsing both forms proves the removed bytes are only the declared
    policy at /contributes/software. The original digests prove all other source
    bytes, including whitespace, are retained.
    """
    directory = source_root / Path(record["source"]).parent
    document = json.loads((source_root / record["source"]).read_bytes())
    source_bytes = None
    if "packs/google-mailboxes.json" in document.get("fragments", []):
        # A later, independently proved migration must be reversed first.
        source_bytes = mail_source_evidence(mail_record(record["id"], record["version"]), source_root)["before_bytes"]
        document = json.loads(source_bytes[Path(record["source"]).name])
    assert document["api_version"] == "worldfixture.world-manifest/v1"
    # Source provenance covers the manifest and its declared fragments. Docs,
    # generator programs and interpreter caches are not compiler source inputs.
    names = [Path(record["source"]).name, *document["fragments"]]
    assert len(names) == len(set(names))
    assert set(names) == set(record["source_files"]), "Declared source file set changed outside the operator migration"
    before, after = {}, {}
    for name, original in record["source_files"].items():
        data = source_bytes[name] if source_bytes is not None else (directory / name).read_bytes()
        after[name] = digest(data)
        change = record["source_migrations"].get(name)
        if change:
            assert change["json_pointer"] == "/contributes/software"
            assert set(change["added_fields"]) == OPERATOR_FIELDS
            assert change["added_fields"] == record["policy"]
            assert change["from"] == original
            assert after[name] == change["to"], f"Current source bytes changed: {name}"
            insertion = change["inserted_text"].encode()
            assert insertion and data.count(insertion) == 1, "Expected one exact declaration insertion"
            restored = data.replace(insertion, b"", 1)
            current_document = json.loads(data)
            restored_document = json.loads(restored)
            expected_document = copy.deepcopy(current_document)
            software = expected_document["contributes"]["software"]
            for key, value in change["added_fields"].items():
                assert software.pop(key) == value
            assert expected_document == restored_document, "Source reversal changed more than operator policy"
            assert not (set(restored_document["contributes"]["software"]) & OPERATOR_FIELDS)
        else:
            restored = data
        before[name] = digest(restored)
        assert before[name] == original, f"Original source bytes not reproduced: {name}"
    # These three reviewed sources use fragment manifests. Their complete file
    # tables, rather than the top-level world.json bytes alone, define provenance.
    assert (document["world"]["id"], document["world"]["version"]) == (record["id"], record["version"])
    before_sha, after_sha = sha256(canonical_json(before)), sha256(canonical_json(after))
    assert before_sha == record["from_source_sha256"]
    assert after_sha == record["to_source_sha256"]
    return {"before_files": before, "after_files": after, "before_sha256": before_sha, "after_sha256": after_sha}


def selected_people(world: dict, *, legacy: bool = False) -> list[dict]:
    """Compute expected membership from world people and authored policy only."""
    organization = next(row["id"] for row in world["organizations"] if row.get("primary"))
    members = [person for person in world["people"] if person["organization_id"] == organization]
    if legacy:
        return [person for person in members if person.get("primary") or person.get("team") == "engineering"][:4]
    policy = world["software"]
    explicit = bool({"operator_teams", "operator_ids"} & policy.keys())
    teams = set(policy.get("operator_teams", [] if explicit else ["engineering"]))
    named = set(policy.get("operator_ids", []))
    eligible_ids = {person["id"] for person in members if person.get("team") in teams or person["id"] in named}
    if not explicit:
        eligible_ids.update(person["id"] for person in members if person.get("primary"))
    selected = [person for person in members if person["id"] in eligible_ids]
    if OPERATOR_FIELDS & policy.keys():
        selected.sort(key=lambda person: person["id"])
    limit = policy.get("operator_limit", 4)
    assert limit is None or (type(limit) is int and limit >= 0)
    return selected if limit is None else selected[:limit]


def iam_users(people: list[dict]) -> list[dict]:
    return [{"user_name": person["github_login"], "path": "/people/", "create_access_key": False} for person in people]


def assert_operator_semantics(case, files: dict[str, bytes], source_root: Path = ROOT) -> None:
    world = json.loads(files["world.json"])
    record = operator_record(world["id"], world["version"])
    evidence = source_evidence(record, source_root)
    case.assertEqual(OPERATOR_FIELDS, set(record["policy"]))
    for software in (world["software"], json.loads(files["packs/software.json"])):
        case.assertTrue(OPERATOR_FIELDS <= software.keys(), "Source operator declarations must reach world and software pack")
        case.assertEqual(record["policy"], {key: software[key] for key in OPERATOR_FIELDS})
    selected = selected_people(world)
    case.assertEqual(record["selected_person_ids"], [person["id"] for person in selected])
    expected = iam_users(selected)
    case.assertEqual(len(expected), len({row["user_name"] for row in expected}), "IAM names must remain unique")
    case.assertEqual(expected, json.loads(files["projections/aws.json"])["iam"]["users"])
    case.assertEqual(expected, json.loads(files["projections/emulator-overlay.json"])["aws"]["iam"]["users"])
    manifest = json.loads(files["manifest.json"])
    case.assertEqual(evidence["after_files"], manifest["source_files"])
    case.assertEqual(evidence["after_sha256"], manifest["source_sha256"])
    table = {name: digest(data) for name, data in files.items() if name != "manifest.json"}
    case.assertEqual(table, manifest["files"])
    case.assertEqual(record["to_artifact_sha256"], sha256(canonical_json(table)))
    case.assertEqual(record["to_artifact_sha256"], manifest["artifact_sha256"])


def reverse_operator_migration(files: dict[str, bytes], source_root: Path = ROOT) -> dict[str, bytes]:
    """Restore only operator fields, IAM users and derived provenance/hashes."""
    restored = dict(files)
    world = json.loads(files["world.json"])
    record = operator_record(world["id"], world["version"])
    evidence = source_evidence(record, source_root)
    software = json.loads(files["packs/software.json"])
    for node in (world["software"], software):
        for key, expected in record["policy"].items():
            assert node.pop(key) == expected
    restored["world.json"], restored["packs/software.json"] = canonical_json(world), canonical_json(software)
    original_users = iam_users(selected_people(world, legacy=True))
    for name in ("projections/aws.json", "projections/emulator-overlay.json"):
        document = json.loads(files[name])
        aws = document if name.endswith("/aws.json") else document["aws"]
        aws["iam"]["users"] = original_users
        restored[name] = canonical_json(document)
    manifest = json.loads(files["manifest.json"])
    manifest["source_files"] = evidence["before_files"]
    manifest["source_sha256"] = evidence["before_sha256"]
    for name in OPERATOR_FILES - {"manifest.json"}:
        manifest["files"][name] = digest(restored[name])
    manifest["artifact_sha256"] = sha256(canonical_json(manifest["files"]))
    restored["manifest.json"] = canonical_json(manifest)
    return restored
