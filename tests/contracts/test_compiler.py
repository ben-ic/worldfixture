from __future__ import annotations

import copy
import hashlib
import json
import tarfile
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

from worldfixture_compiler import WorldError, build_world, bundle_world, load_world, validate_world
from worldfixture_compiler.compiler import compile_world, rebase_world


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "worlds/business.saas-company.v2/world.json"


def source_world() -> dict:
    return load_world(SOURCE)[0]


class WorldCompilerTest(unittest.TestCase):
    def test_source_is_valid(self) -> None:
        validate_world(source_world())

    def test_manifest_tracks_every_authoring_file(self) -> None:
        _world, provenance = load_world(SOURCE)

        self.assertEqual(
            {
                "world.json",
                "backbones/northstar-relay.json",
                "packs/saas-operations.json",
                "stories/lumen-renewal.json",
                "stories/release-28.json",
                "stories/theo-onboarding.json",
            },
            set(provenance["source_files"]),
        )

    def test_manifest_refuses_a_fragment_outside_its_world_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outside = root / "outside.json"
            world_dir = root / "world"
            world_dir.mkdir()
            outside.write_text('{"api_version":"worldfixture.world-fragment/v1"}\n')
            manifest = {
                "api_version": "worldfixture.world-manifest/v1",
                "world": {"id": "test.world", "version": "v1"},
                "fragments": ["../outside.json"],
            }
            source = world_dir / "world.json"
            source.write_text(json.dumps(manifest))

            with self.assertRaisesRegex(WorldError, "fragment path leaves world directory"):
                load_world(source)

    def test_manifest_refuses_conflicting_scalar_contributions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = {
                "api_version": "worldfixture.world-fragment/v1",
                "id": "fragment.first",
                "contributes": {"clock": {"timezone": "Europe/London"}},
            }
            second = {
                "api_version": "worldfixture.world-fragment/v1",
                "id": "fragment.second",
                "contributes": {"clock": {"timezone": "America/New_York"}},
            }
            (root / "first.json").write_text(json.dumps(first))
            (root / "second.json").write_text(json.dumps(second))
            manifest = {
                "api_version": "worldfixture.world-manifest/v1",
                "world": {"id": "test.world", "version": "v1"},
                "fragments": ["first.json", "second.json"],
            }
            source = root / "world.json"
            source.write_text(json.dumps(manifest))

            with self.assertRaisesRegex(WorldError, "fragment conflict at clock.timezone"):
                load_world(source)

    def test_build_is_byte_reproducible(self) -> None:
        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            first_path = Path(first)
            second_path = Path(second)
            first_manifest = build_world(SOURCE, first_path)
            second_manifest = build_world(SOURCE, second_path)

            self.assertEqual(first_manifest, second_manifest)
            first_files = {path.relative_to(first_path): path.read_bytes() for path in first_path.rglob("*") if path.is_file()}
            second_files = {path.relative_to(second_path): path.read_bytes() for path in second_path.rglob("*") if path.is_file()}
            self.assertEqual(first_files, second_files)

    def test_bundle_is_byte_reproducible_and_safe_to_extract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / "first.tar"
            second = Path(directory) / "second.tar"
            first_result = bundle_world(SOURCE, first)
            second_result = bundle_world(SOURCE, second)

            self.assertEqual(first_result, second_result)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual(first_result["artifact_sha256"], hashlib.sha256(first.read_bytes()).hexdigest())
            self.assertEqual(first_result["artifact_size"], first.stat().st_size)

            with tarfile.open(first, "r") as archive:
                names = archive.getnames()
                self.assertEqual(sorted(names), names)
                self.assertIn("manifest.json", names)
                self.assertIn("packs/work.json", names)
                self.assertTrue(all(not name.startswith("/") and ".." not in Path(name).parts for name in names))
                self.assertTrue(all(member.uid == 0 and member.gid == 0 and member.mtime == 0 for member in archive.getmembers()))

    def test_manifest_verifies_every_output(self) -> None:
        with tempfile.TemporaryDirectory() as output:
            output_path = Path(output)
            manifest = build_world(SOURCE, output_path)
            for relative, expected in manifest["files"].items():
                data = (output_path / relative).read_bytes()
                self.assertEqual(expected["size"], len(data))
                self.assertEqual(expected["sha256"], hashlib.sha256(data).hexdigest())

            self.assertEqual(
                ["communication", "finance", "identity", "software", "support", "work"],
                manifest["packs"],
            )
            self.assertEqual("prebuilt", manifest["build_mode"])
            self.assertTrue((output_path / "packs/work.json").is_file())

    def test_identity_is_the_same_across_vendor_projections(self) -> None:
        compiled = compile_world(source_world())
        projections = compiled["projections"]

        google_user = projections["google"]["users"][0]
        slack_user = next(user for user in projections["slack"]["users"] if user["worldfixture_person_id"] == "maya-chen")
        github_user = next(user for user in projections["github"]["users"] if user["worldfixture_person_id"] == "maya-chen")
        mail_user = next(user for user in projections["mail"]["users"] if user["id"] == "maya-chen")

        self.assertEqual("Maya Chen", google_user["name"])
        self.assertEqual(google_user["name"], slack_user["real_name"])
        self.assertEqual(google_user["name"], github_user["name"])
        self.assertEqual(google_user["email"], slack_user["email"])
        self.assertEqual(google_user["email"], github_user["email"])
        self.assertEqual(google_user["email"], mail_user["email"])

    def test_lumen_story_crosses_mail_chat_finance_model_and_agent(self) -> None:
        compiled = compile_world(source_world())
        world = compiled["world"]
        projections = compiled["projections"]

        invoice = next(item for item in world["finance"]["resolved"]["invoices"] if item["id"] == "inv-4471")
        self.assertEqual("open", invoice["status"])
        self.assertEqual(41200, invoice["amount_cents"])

        google_refs = [message.get("worldfixture_entity_refs", {}) for message in projections["google"]["messages"]]
        self.assertTrue(any(refs.get("invoice_id") == "inv-4471" for refs in google_refs))

        slack_refs = [
            message.get("worldfixture_entity_refs", {})
            for channel in projections["slack"]["channels"]
            for message in channel["messages"]
        ]
        self.assertTrue(any(refs.get("invoice_id") == "inv-4471" for refs in slack_refs))

        model_facts = projections["model"]["facts"]
        self.assertIn("Invoice 4471 is 412.00 USD and is open.", [fact["text"] for fact in model_facts])

        agent_grounding = projections["agent"]["grounding"]
        agent_invoice = next(item for item in agent_grounding if item["entity_id"] == "inv-4471")
        self.assertEqual("open", agent_invoice["value"]["status"])
        self.assertIn("Does not claim the fix is merged", projections["agent"]["goals"][0]["success_evidence"])

    def test_finance_history_balances_and_keeps_authored_open_invoice(self) -> None:
        compiled = compile_world(source_world())
        finance = compiled["world"]["finance"]["resolved"]
        debit = sum(entry["debit_cents"] for entry in finance["ledger_entries"])
        credit = sum(entry["credit_cents"] for entry in finance["ledger_entries"])

        self.assertEqual(debit, credit)
        self.assertGreaterEqual(len(finance["invoices"]), 49)
        self.assertGreaterEqual(len(finance["ledger_entries"]), 240)
        self.assertFalse(any(payment["invoice_id"] == "inv-4471" for payment in finance["payments"]))

    def test_work_pack_has_authored_cross_application_records(self) -> None:
        compiled = compile_world(source_world())
        work = compiled["packs"]["work"]

        self.assertEqual(4, len(work["projects"]))
        self.assertGreaterEqual(len(work["tasks"]), 14)
        self.assertGreaterEqual(len(work["time_entries"]), 10)

        cleanup = next(task for task in work["tasks"] if task["id"] == "task-cancel-cleanup")
        self.assertEqual("project-release-28", cleanup["project_id"])
        self.assertEqual("blocked", cleanup["status"])
        self.assertIn("partial object", cleanup["description"])

        lumen = next(project for project in work["projects"] if project["id"] == "project-lumen-renewal")
        self.assertEqual("lumen", lumen["customer_id"])
        self.assertIn("maya-chen", lumen["member_ids"])

    def test_timeline_keeps_observation_separate_from_future_effect(self) -> None:
        compiled = compile_world(source_world())
        agent = compiled["projections"]["agent"]
        payment = next(event for event in agent["timeline"] if event["id"] == "arrival-lumen-payment")
        rule = next(rule for rule in agent["causal_rules"] if rule["id"] == "rule-invoice-payment")

        self.assertEqual("finance.invoice.paid", payment["payload"]["event"])
        self.assertIn("finance.bank-transaction.created", rule["emits"])
        self.assertNotIn("fraud", json.dumps(compiled["projections"]))

    def test_http_targets_tell_the_same_company_story(self) -> None:
        targets = compile_world(source_world())["projections"]["http-targets"]

        self.assertEqual("worldfixture.http-targets/v1", targets["api_version"])
        self.assertEqual("Northstar Relay", targets["organization"]["name"])
        feed_items = targets["feeds"][0]["items"]
        self.assertEqual(6, len(feed_items))
        self.assertEqual(
            [90, 20, 540],
            [item["available_after_seconds"] for item in feed_items[3:]],
        )
        self.assertEqual(
            "The 48k sample completed; the scheduled 52k run failed again.",
            feed_items[3]["summary"],
        )
        self.assertEqual(
            [200, 200, 503, 200],
            next(item for item in targets["probes"] if item["mode"] == "flapping")["statuses"],
        )
        self.assertEqual(
            41200,
            next(
                item
                for item in targets["metrics"]
                if item["name"] == "northstar_lumen_invoice_cents"
            )["value"],
        )
        self.assertIn("/api/v1/status", targets["api"]["document"]["paths"])
        lumen = next(page for page in targets["pages"] if page["path"] == "/notes/lumen-export")
        self.assertIn("Invoice 4471 is open", lumen["sections"][0]["body"])
        self.assertNotIn("fix is merged", json.dumps(targets).lower())

    def test_http_target_arrivals_use_the_timeline_schedule(self) -> None:
        source = source_world()
        expected = {
            "arrival-priya-sample-result": 91,
            "arrival-lucas-load-test": 242,
            "arrival-lumen-payment": 543,
        }

        for event in source["timeline"]:
            if event["id"] in expected:
                event["after_seconds"] = expected[event["id"]]

        feed_items = compile_world(source)["projections"]["http-targets"]["feeds"][0]["items"]
        self.assertEqual(list(expected.values()), [item["available_after_seconds"] for item in feed_items[3:]])

    def test_rebase_moves_history_that_sits_far_from_the_anchor(self) -> None:
        """A world's whole history moves, not just the part near the anchor.

        `_rebase_text` shifts dates within 35 days of the anchor and leaves the
        rest, so that rebasing does not rewrite a date inside authored prose
        that refers to something real. Applied to structured fields it did
        something else: it moved the recent part of a world's history and froze
        the rest.

        Measured on the larger world, whose mail spans 749 days: 301 of 3,069
        messages moved and 2,146 finished AFTER the world's own new anchor --
        most of the mail in the world's future, which is not a world.

        A field whose whole value is a date now shifts by the full delta
        wherever it sits. Prose keeps the window.
        """
        source = ROOT / "worlds/business.saas-company.v3/world.json"
        if not source.is_file():
            self.skipTest("no v3 world source")

        world, _provenance = load_world(source)
        original_anchor = datetime.fromisoformat(world["clock"]["anchor"].replace("Z", "+00:00"))
        target = original_anchor - timedelta(days=364)
        rebased = rebase_world(world, target)

        new_anchor = rebased["clock"]["anchor"]
        mail = rebased["communication"]["mail"]
        ahead = [message for message in mail if message["sent_at"] > new_anchor]
        self.assertLessEqual(
            len(ahead),
            len(mail) // 100,
            f"{len(ahead)} of {len(mail)} messages sit after the world's own anchor",
        )

        # Every message moved by exactly one delta -- not zero, and not two,
        # which is the bug this world's size would otherwise have hidden.
        before = {message["id"]: message["sent_at"] for message in world["communication"]["mail"]}
        deltas = set()
        for message in mail:
            was = datetime.fromisoformat(before[message["id"]].replace("Z", "+00:00"))
            now = datetime.fromisoformat(message["sent_at"].replace("Z", "+00:00"))
            deltas.add((now - was).days)
        self.assertEqual(1, len(deltas), f"messages moved by different amounts: {sorted(deltas)}")

    def test_rebase_moves_reviewed_dates_and_recomputes_finance(self) -> None:
        target = datetime.fromisoformat("2026-11-30T09:00:00+00:00")
        source = source_world()
        source["organizations"][0]["contract_started"] = "2026-08-01"
        rebased = rebase_world(source, target)
        compiled = compile_world(rebased)

        self.assertEqual("2026-11-27T09:00:00Z", rebased["clock"]["anchor"])
        invoice = next(item for item in rebased["finance"]["anchor_invoices"] if item["id"] == "inv-4471")
        self.assertEqual("2026-12-06", invoice["due_on"])
        self.assertIn("due 6 December", json.dumps(rebased))
        self.assertIn("2026-12-06", json.dumps(compiled["world"]["communication"]["resolved_mail"]))
        self.assertEqual("2026-08-01", rebased["organizations"][0]["contract_started"])
        self.assertEqual(
            [item["after_seconds"] for item in source_world()["timeline"]],
            [item["after_seconds"] for item in rebased["timeline"]],
        )

    def test_current_emulator_overlay_uses_existing_tokens_and_seed_shapes(self) -> None:
        overlay = compile_world(source_world())["projections"]["emulator-overlay"]

        self.assertEqual("maya@northstar-relay.worldfixture.test", overlay["tokens"]["demo_token"]["login"])
        self.assertEqual("mayac", overlay["tokens"]["github_token"]["login"])
        # The Slack emulator matches a token by its own id or the user name. The
        # world's canonical slack_id is neither, so the token names the person.
        self.assertEqual("mayac", overlay["tokens"]["slack_token"]["login"])
        self.assertEqual("maya@northstar-relay.worldfixture.test", overlay["tokens"]["linear_token"]["login"])
        self.assertEqual("maya@northstar-relay.worldfixture.test", overlay["tokens"]["clerk_token"]["login"])
        self.assertEqual("mayac", overlay["tokens"]["vercel_token"]["login"])
        self.assertEqual("maya@northstar-relay.worldfixture.test", overlay["tokens"]["microsoft_token"]["login"])
        self.assertEqual("maya@northstar-relay.worldfixture.test", overlay["tokens"]["notion_token"]["login"])
        self.assertIn("interact:agents", overlay["tokens"]["notion_token"]["scopes"])
        self.assertEqual(
            "jon@northstar-relay.worldfixture.test",
            overlay["tokens"]["notion_token_jon-bell"]["login"],
        )
        self.assertIn("interact:agents", overlay["tokens"]["notion_token_jon-bell"]["scopes"])
        self.assertEqual("maya@northstar-relay.worldfixture.test", overlay["tokens"]["apple_token"]["login"])
        self.assertEqual("mayac", overlay["tokens"]["mongoatlas_token"]["login"])
        self.assertNotIn("worldfixture_entity_refs", overlay["google"]["messages"][0])
        self.assertEqual(
            {"name", "real_name", "email", "profile", "presence"},
            set(overlay["slack"]["users"][0]),
        )
        self.assertEqual(
            {"owner", "name", "description", "language", "topics", "auto_init", "issues"},
            set(overlay["github"]["repos"][0]),
        )
        self.assertEqual(14, len(overlay["linear"]["issues"]))
        self.assertEqual("Northstar Relay", overlay["clerk"]["organizations"][0]["name"])
        self.assertEqual("Northstar Relay", overlay["vercel"]["teams"][0]["name"])
        self.assertEqual(4, len(overlay["stripe"]["customers"]))
        self.assertEqual("Northstar Relay", overlay["twilio"]["account"]["friendly_name"])
        # Buckets belong to the S3 service, not the AWS vendor. See
        # `test_the_aws_overlay_yields_s3_to_the_service_that_owns_it`.
        self.assertNotIn("s3", overlay["aws"])
        self.assertEqual(4, len(overlay["resend"]["contacts"]))
        self.assertEqual("Northstar Relay", overlay["mongoatlas"]["projects"][0]["name"])
        self.assertEqual("Northstar Relay", overlay["notion"]["workspace"]["name"])
        self.assertEqual(
            {"bucket": "northstar-relay-documents", "prefix": "notion/uploads"},
            overlay["notion"]["object_store"],
        )
        self.assertEqual("Projects", overlay["notion"]["databases"][0]["title"])
        self.assertEqual("Projects", overlay["notion"]["data_sources"][0]["name"])
        self.assertEqual("Active projects", overlay["notion"]["views"][0]["name"])
        self.assertEqual(2, len(overlay["notion"]["agents"]))
        self.assertTrue(any(page["title"] == "Release 2.8" for page in overlay["notion"]["pages"]))
        project_page = next(page for page in overlay["notion"]["pages"] if "worldfixture_project_id" in page)
        self.assertEqual(project_page["title"], project_page["properties"]["Name"]["title"][0]["plain_text"])
        self.assertEqual("status", project_page["properties"]["Status"]["type"])
        self.assertEqual("people", project_page["properties"]["Owner"]["type"])
        self.assertEqual("date", project_page["properties"]["Target"]["type"])
        self.assertNotIn("worldfixture_task_id", overlay["linear"]["issues"][0])

    def test_notion_identifiers_are_stable_inside_a_world_and_distinct_between_worlds(self) -> None:
        first_world = source_world()
        repeated = compile_world(copy.deepcopy(first_world))["projections"]["notion"]
        first = compile_world(first_world)["projections"]["notion"]
        second_world = copy.deepcopy(first_world)
        second_world["id"] = "business.another-company"
        second_world["organizations"][0]["slug"] = "another-company"
        second = compile_world(second_world)["projections"]["notion"]

        self.assertEqual(first["workspace"]["id"], repeated["workspace"]["id"])
        self.assertNotEqual(first["workspace"]["id"], second["workspace"]["id"])
        self.assertNotEqual(first["pages"][0]["id"], second["pages"][0]["id"])
        self.assertEqual(first["agents"][0]["id"], repeated["agents"][0]["id"])
        self.assertNotEqual(first["agents"][0]["id"], second["agents"][0]["id"])
        self.assertNotEqual(first["object_store"]["bucket"], second["object_store"]["bucket"])

    def test_notion_agents_come_only_from_agentic_goals_and_keep_actor_access(self) -> None:
        world = source_world()
        notion = compile_world(world)["projections"]["notion"]
        actor_id = world["agentic"]["actor_id"]
        notion_actor_id = next(
            item["id"] for item in notion["users"] if item["worldfixture_person_id"] == actor_id
        )

        self.assertEqual(len(world["agentic"]["goals"]), len(notion["agents"]))
        for goal in world["agentic"]["goals"]:
            agent = next(item for item in notion["agents"] if item["name"] == goal["title"])
            self.assertEqual(goal["instructions"], agent["description"])
            self.assertTrue(agent["instructions"].startswith(goal["instructions"]))
            for constraint in world["agentic"]["constraints"]:
                self.assertIn(f"- {constraint}", agent["instructions"])
            for evidence in goal["success_evidence"]:
                self.assertIn(f"- {evidence}", agent["instructions"])
            self.assertEqual(notion_actor_id, agent["created_by"])
            self.assertEqual([notion_actor_id], agent["accessible_by"])
            self.assertEqual([notion_actor_id], agent["editable_by"])
            self.assertIsNone(agent["default_response"])

        without_goals = copy.deepcopy(world)
        without_goals["agentic"]["goals"] = []
        self.assertEqual([], compile_world(without_goals)["projections"]["notion"]["agents"])

    def test_more_vendor_projections_keep_the_same_people_and_work(self) -> None:
        projections = compile_world(source_world())["projections"]

        clerk_maya = next(user for user in projections["clerk"]["users"] if user["worldfixture_person_id"] == "maya-chen")
        okta_maya = next(user for user in projections["okta"]["users"] if user["worldfixture_person_id"] == "maya-chen")
        linear_maya = next(user for user in projections["linear"]["users"] if user["worldfixture_person_id"] == "maya-chen")
        vercel_maya = projections["vercel"]["users"][0]
        microsoft_maya = next(user for user in projections["microsoft"]["users"] if user["worldfixture_person_id"] == "maya-chen")
        apple_maya = projections["apple"]["users"][0]

        self.assertEqual(["maya@northstar-relay.worldfixture.test"], clerk_maya["email_addresses"])
        self.assertEqual("maya@northstar-relay.worldfixture.test", okta_maya["email"])
        self.assertEqual("maya@northstar-relay.worldfixture.test", linear_maya["email"])
        self.assertEqual("maya@northstar-relay.worldfixture.test", vercel_maya["email"])
        self.assertEqual("maya@northstar-relay.worldfixture.test", microsoft_maya["email"])
        self.assertEqual("maya@northstar-relay.worldfixture.test", apple_maya["email"])

        blocked = next(issue for issue in projections["linear"]["issues"] if issue["worldfixture_task_id"] == "task-cancel-cleanup")
        self.assertEqual("In Progress", blocked["state"])
        self.assertIn("blocked", blocked["labels"])
        self.assertIn("Release 2.8", blocked["description"])

        lumen = next(customer for customer in projections["stripe"]["customers"] if customer["worldfixture_customer_id"] == "lumen")
        self.assertEqual("priya@lumen-labs.worldfixture.test", lumen["email"])

    def test_every_emulated_vendor_uses_the_same_world(self) -> None:
        projections = compile_world(source_world())["projections"]
        overlay = projections["emulator-overlay"]

        self.assertEqual("maya@northstar-relay.worldfixture.test", projections["microsoft"]["users"][0]["email"])
        self.assertEqual("maya@northstar-relay.worldfixture.test", projections["apple"]["users"][0]["email"])
        self.assertEqual("northstar-relay.worldfixture.test", projections["resend"]["domains"][0]["name"])
        self.assertEqual("Northstar Relay", projections["mongoatlas"]["projects"][0]["name"])
        self.assertEqual("Northstar Relay Support", projections["twilio"]["phone_numbers"][0]["friendly_name"])
        self.assertEqual("worldfixture_twilio_test_token", projections["twilio"]["account"]["auth_token"])
        self.assertEqual(
            {"northstar-relay-documents", "northstar-relay-exports"},
            {bucket["name"] for bucket in projections["aws"]["s3"]["buckets"]},
        )
        self.assertIn("priya@lumen-labs.worldfixture.test", {contact["email"] for contact in projections["resend"]["contacts"]})
        self.assertEqual(
            {"customers", "invoices", "support_cases", "tasks"},
            set(projections["mongoatlas"]["databases"][0]["collections"]),
        )

        vendor_names = {
            "apple",
            "aws",
            "clerk",
            "github",
            "google",
            "linear",
            "microsoft",
            "mongoatlas",
            "notion",
            "okta",
            "resend",
            "slack",
            "stripe",
            "twilio",
            "vercel",
        }
        self.assertTrue(vendor_names.issubset(overlay))
        self.assertEqual("maya@northstar-relay.worldfixture.test", overlay["tokens"]["microsoft_token"]["login"])
        self.assertEqual("maya@northstar-relay.worldfixture.test", overlay["tokens"]["apple_token"]["login"])
        self.assertNotIn("worldfixture_person_id", overlay["microsoft"]["users"][0])
        self.assertNotIn("worldfixture_organization_id", overlay["aws"])

        resend_priya = next(contact for contact in projections["resend"]["contacts"] if contact["worldfixture_person_id"] == "priya-raman")
        self.assertEqual("lumen", resend_priya["worldfixture_customer_id"])
        self.assertEqual("Northstar Relay", projections["twilio"]["account"]["friendly_name"])
        self.assertIn(
            "northstar-relay-exports",
            {bucket["name"] for bucket in projections["aws"]["s3"]["buckets"]},
        )

    def test_the_s3_projection_carries_the_world_documents_as_objects(self) -> None:
        projections = compile_world(source_world())["projections"]
        objects = projections["aws"]["s3"]["objects"]
        documents = source_world()["communication"]["documents"]
        buckets = {bucket["name"] for bucket in projections["aws"]["s3"]["buckets"]}

        self.assertGreater(len(documents), 0)
        self.assertEqual(len(documents), len(objects))
        # A stable order and a declared bucket, so the seeded store is a function
        # of the projection alone.
        self.assertEqual(sorted(objects, key=lambda entry: (entry["bucket"], entry["key"])), objects)
        self.assertTrue({entry["bucket"] for entry in objects}.issubset(buckets))

        lumen = next(entry for entry in objects if entry["worldfixture_document_id"] == "doc-lumen-renewal")
        document = next(record for record in documents if record["id"] == "doc-lumen-renewal")
        self.assertEqual("northstar-relay-documents", lumen["bucket"])
        self.assertEqual("documents/doc-lumen-renewal.md", lumen["key"])
        self.assertEqual(document["content"], lumen["content"])
        self.assertEqual(document["mime_type"], lumen["content_type"])
        # The document's own time, never the build clock.
        self.assertEqual(document["modified_at"], lumen["last_modified"])
        self.assertEqual("david-banerjee", lumen["worldfixture_person_id"])
        # The owner is named the way this projection names an IAM principal: the
        # person's login, not their world id.
        self.assertEqual("davidb", lumen["owner"])
        person = next(record for record in source_world()["people"] if record["id"] == document["owner_id"])
        self.assertEqual(person["github_login"], lumen["owner"])

        # `task-cancel-cleanup` says a cancelled export leaves a partial object in
        # the exports bucket. No world record declares that object, so the compiler
        # does not invent one. This gap belongs to the world data, not here.
        self.assertEqual([], [entry for entry in objects if entry["bucket"] == "northstar-relay-exports"])

    def test_notion_comments_and_files_keep_world_record_ownership(self) -> None:
        world = source_world()
        projections = compile_world(world)["projections"]
        notion = projections["notion"]
        aws_objects = {
            item["worldfixture_document_id"]: item
            for item in projections["aws"]["s3"]["objects"]
        }
        notion_users = {
            item["worldfixture_person_id"]: item
            for item in notion["users"]
        }
        pages = {
            item.get("worldfixture_document_id") or item.get("worldfixture_project_id"): item
            for item in notion["pages"]
        }

        self.assertEqual(len(world["communication"]["documents"]), len(notion["file_uploads"]))
        for document in world["communication"]["documents"]:
            upload = next(item for item in notion["file_uploads"] if item["worldfixture_document_id"] == document["id"])
            s3_object = aws_objects[document["id"]]
            self.assertEqual(notion_users[document["owner_id"]]["id"], upload["created_by"])
            self.assertEqual(s3_object["bucket"], upload["object_bucket"])
            self.assertEqual(s3_object["key"], upload["object_key"])
            self.assertEqual(len(document["content"].encode("utf-8")), upload["content_length"])
            file_blocks = [child for child in pages[document["id"]]["children"] if child["type"] == "file"]
            self.assertEqual(upload["id"], file_blocks[0]["file"]["file_upload"]["id"])

        referenced_messages = [
            (channel, message)
            for channel in world["communication"]["channels"]
            for message in channel.get("messages", [])
            if (message.get("entity_refs", {}).get("document_id") or message.get("entity_refs", {}).get("project_id"))
            if message["author_id"] in notion_users
        ]
        self.assertEqual(len(referenced_messages), len(notion["comments"]))
        for channel, message in referenced_messages:
            comment = next(item for item in notion["comments"] if item["worldfixture_message_id"] == message["id"])
            related_id = message["entity_refs"].get("document_id") or message["entity_refs"].get("project_id")
            self.assertEqual(pages[related_id]["id"], comment["parent"]["page_id"])
            self.assertEqual(notion_users[message["author_id"]]["id"], comment["created_by"])
            self.assertEqual(channel["id"], comment["worldfixture_channel_id"])
            self.assertEqual(message["text"], comment["rich_text"][0]["plain_text"])

    def test_notion_meeting_notes_come_from_calendar_events_and_limit_access_to_attendees(self) -> None:
        world = source_world()
        notion = compile_world(world)["projections"]["notion"]
        users_by_person = {item["worldfixture_person_id"]: item["id"] for item in notion["users"]}
        people_by_email = {item["email"]: item for item in world["people"]}

        self.assertEqual(len(world["communication"]["calendar_events"]), len(notion["meeting_notes"]))
        for event in world["communication"]["calendar_events"]:
            note = next(item for item in notion["meeting_notes"] if item["worldfixture_calendar_event_id"] == event["id"])
            page = next(item for item in notion["pages"] if item.get("worldfixture_calendar_event_id") == event["id"])
            expected_attendees = [
                users_by_person[people_by_email[email]["id"]]
                for email in event["attendees"]
                if email in people_by_email and people_by_email[email]["id"] in users_by_person
            ]
            self.assertEqual(page["id"], note["parent"]["page_id"])
            self.assertEqual(expected_attendees, note["calendar_event"]["attendees"])
            self.assertEqual(expected_attendees, page["accessible_by"])
            self.assertEqual("transcription_not_started", note["status"])
            self.assertNotIn("transcript", note)

        runbook_documents = [item for item in world["communication"]["documents"] if item["name"].lower().startswith("runbook:")]
        skill_pages = [item for item in notion["pages"] if item.get("is_skill")]
        self.assertEqual({item["id"] for item in runbook_documents}, {item["worldfixture_document_id"] for item in skill_pages})

    def test_the_aws_overlay_yields_s3_to_the_service_that_owns_it(self) -> None:
        projections = compile_world(source_world())["projections"]

        # `@emulators/aws` serves /s3/ as well as SeaweedFS, so giving it buckets
        # would put one provider's mutable state behind two route owners. It keeps
        # IAM and SQS, which nothing else implements. The canonical projection
        # stays rich and the S3 service reads it directly.
        self.assertNotIn("s3", projections["emulator-overlay"]["aws"])
        for kept in ("iam", "sqs"):
            self.assertIn(kept, projections["emulator-overlay"]["aws"])
        self.assertIn("objects", projections["aws"]["s3"])
        self.assertTrue(projections["aws"]["s3"]["buckets"])

    def test_rejects_unknown_relationships(self) -> None:
        world = copy.deepcopy(source_world())
        world["finance"]["anchor_invoices"][0]["customer_id"] = "missing-customer"
        with self.assertRaisesRegex(WorldError, "unknown customer"):
            validate_world(world)

    def test_rejects_non_synthetic_addresses(self) -> None:
        world = copy.deepcopy(source_world())
        world["people"][0]["email"] = "maya@example.com"
        with self.assertRaisesRegex(WorldError, "unsafe person email"):
            validate_world(world)


if __name__ == "__main__":
    unittest.main()
