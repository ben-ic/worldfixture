"""The compiler core must not require one profile's records.

A world is data, not an agent requirement, and a minimal world contains only
its schema and its records. These tests hold the core to that: no organization,
person, GitHub login, Slack id, or primary person is required unless a world
declares a profile that needs them.
"""

from __future__ import annotations

import copy
import json
import os
import tempfile
import time
import unittest
from datetime import date, timedelta
from pathlib import Path

from worldfixture_compiler import PROFILES, WorldError, build_world, validate_world
from worldfixture_compiler.compiler import _rebase_text, _slack_ts, compile_world

MINIMAL_WORLD = {
    "api_version": "worldfixture.world-source/v1",
    "id": "product.marketplace-users",
    "version": "v1",
    "title": "Marketplace users",
    "synthetic_notice": "Every record in this world is synthetic and describes no real person.",
    "scenario": {"id": "normal-operations", "class": "normal", "title": "A population with no services"},
    "clock": {"anchor": "2026-09-02T09:00:00Z", "timezone": "UTC", "locale": "en"},
    "records": [
        {"id": "user-1", "role": "buyer", "experience": "new"},
        {"id": "user-2", "role": "seller", "experience": "expert"},
    ],
    "timeline": [{
        "id": "arrival-population-review", "after_seconds": 1, "kind": "application-event",
        "payload": {"kind": "marketplace.population.review.requested", "data": {"record_ids": ["user-1", "user-2"]}},
    }],
}


class CompilerCoreTest(unittest.TestCase):
    def test_a_world_without_a_profile_needs_no_people_or_provider_identities(self) -> None:
        validate_world(copy.deepcopy(MINIMAL_WORLD))

    def test_a_world_without_a_profile_compiles_to_records_and_timeline_only(self) -> None:
        compiled = compile_world(copy.deepcopy(MINIMAL_WORLD))

        self.assertEqual({}, compiled["packs"])
        self.assertEqual({}, compiled["projections"])
        self.assertEqual(MINIMAL_WORLD["records"], compiled["world"]["records"])

    def test_a_profile_less_world_builds_one_deterministic_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "world.json"
            source.write_text(json.dumps(MINIMAL_WORLD))

            first = build_world(source, root / "first")
            second = build_world(source, root / "second")

            self.assertEqual(first, second)
            # `files` records everything the manifest attests to; the manifest
            # cannot carry its own digest.
            self.assertEqual({"timeline.json", "world.json"}, set(first["files"]))
            self.assertIsNone(first["profile"])
            self.assertEqual([], first["packs"])
            self.assertTrue((root / "first/manifest.json").is_file())

    def test_the_core_rejects_an_unknown_profile_instead_of_ignoring_it(self) -> None:
        world = copy.deepcopy(MINIMAL_WORLD)
        world["profile"] = "business.operations/v99"

        with self.assertRaisesRegex(WorldError, "unsupported world profile"):
            validate_world(world)

    def test_profile_does_not_require_unrelated_business_records(self) -> None:
        world = copy.deepcopy(MINIMAL_WORLD)
        world["profile"] = "business.operations/v1"

        validate_world(world)
        self.assertEqual({}, compile_world(world)["packs"])

    def test_the_core_still_enforces_the_world_envelope(self) -> None:
        for key, value, message in (
            ("api_version", "droplive.world-source/v1", "unsupported api_version"),
            ("id", "Bad Id", "invalid world id"),
            ("version", "1", "invalid world version"),
            ("synthetic_notice", "too short", "synthetic_notice is too short"),
        ):
            with self.subTest(key=key):
                world = copy.deepcopy(MINIMAL_WORLD)
                world[key] = value
                with self.assertRaisesRegex(WorldError, message):
                    validate_world(world)

    def test_the_core_keeps_every_address_in_the_reserved_test_domain(self) -> None:
        # `.test` is reserved by RFC 2606, so no world can address a real host.
        # The compiler core names no product's test domain.
        from worldfixture_compiler.compiler import TEST_DOMAIN_SUFFIX

        self.assertEqual(".test", TEST_DOMAIN_SUFFIX)

        source = Path(__file__).resolve().parents[2] / "compiler/worldfixture_compiler/compiler.py"
        self.assertNotIn("droplive.test", source.read_text())

    def test_the_profile_registry_has_no_plugin_loader(self) -> None:
        # One real profile exists. A second one has to show what a shared
        # extension interface needs before that interface is designed.
        self.assertEqual({"business.operations/v1"}, set(PROFILES))
        self.assertEqual({"validate", "compile"}, set(PROFILES["business.operations/v1"]))

    def test_exported_legacy_compile_callback_preserves_reviewed_provider_contracts(self) -> None:
        from worldfixture_compiler import load_world
        from worldfixture_compiler.compiler import canonical_json, sha256

        root = Path(__file__).resolve().parents[2]
        world, _ = load_world(root / "worlds/business.saas-company.v2/world.json")
        for field in ("operator_teams", "operator_ids", "operator_limit", "queues", "service_roles"):
            world["software"].pop(field, None)
        world["communication"].pop("bots", None)
        world["work"].pop("team", None)
        original = copy.deepcopy(world)
        projections = PROFILES["business.operations/v1"]["compile"](world)["projections"]
        self.assertEqual(original, world)
        baseline = json.loads((root / "tests/parity/coupling-artifacts.baseline.json").read_text())
        reviewed = next(row for row in baseline["worlds"] if row["id"] == "business.saas-company" and row["version"] == "v2")
        # Compare complete provider bytes with the independent, original audit
        # record. This covers the old operator cap, queues, roles and team.
        for provider in ("aws", "linear"):
            with self.subTest(provider=provider):
                body = canonical_json(projections[provider])
                self.assertEqual(reviewed["files"][f"projections/{provider}.json"],
                                 {"sha256": sha256(body), "size": len(body)})
        self.assertEqual([{"name": "northstar-helper"}], projections["slack"]["bots"])
        self.assertEqual(projections["slack"]["bots"], projections["emulator-overlay"]["slack"]["bots"])




class SlackIdentityTest(unittest.TestCase):
    """Every world person must be able to act as themselves in Slack.

    The emulator resolves a token by its own user id or by the user name. It
    mints its own ids when it seeds, so a token that names the world's canonical
    `slack_id` resolves to whatever holds that id in the emulator - which is the
    upstream default admin, not the person. Tokens therefore name the person.
    """

    @classmethod
    def setUpClass(cls) -> None:
        from worldfixture_compiler import load_world

        root = Path(__file__).resolve().parents[2]
        world, _provenance = load_world(root / "worlds/business.saas-company.v2/world.json")
        compiled = compile_world(world)
        cls.overlay = compiled["projections"]["emulator-overlay"]
        cls.slack = compiled["projections"]["slack"]

    def test_the_primary_token_names_the_person_and_not_a_world_id(self) -> None:
        login = self.overlay["tokens"]["slack_token"]["login"]

        self.assertEqual("mayac", login)
        self.assertNotIn(login, {user["id"] for user in self.slack["users"]})

    def test_every_slack_person_gets_their_own_token(self) -> None:
        tokens = {name: token for name, token in self.overlay["tokens"].items() if name.startswith("slack_token_")}
        names = {user["name"] for user in self.slack["users"]}

        self.assertEqual(10, len(tokens))
        self.assertEqual(names, {token["login"] for token in tokens.values()})

    def test_two_people_get_two_different_identities(self) -> None:
        maya = self.overlay["tokens"]["slack_token_maya-chen"]["login"]
        jon = self.overlay["tokens"]["slack_token_jon-bell"]["login"]

        self.assertNotEqual(maya, jon)
        self.assertEqual("mayac", maya)
        self.assertEqual("jonbell", jon)


class SlackHistoryTest(unittest.TestCase):
    """The world's authored Slack history has to reach the emulator overlay.

    `SlackSeedConfig` has no message field, so the composer inserts these
    through the emulator's public store after seeding. The overlay still has to
    carry them, keyed the way the emulator resolves a user: by name.
    """

    @classmethod
    def setUpClass(cls) -> None:
        from worldfixture_compiler import load_world

        root = Path(__file__).resolve().parents[2]
        world, _provenance = load_world(root / "worlds/business.saas-company.v2/world.json")
        compiled = compile_world(world)
        cls.channels = {c["name"]: c for c in compiled["projections"]["emulator-overlay"]["slack"]["channels"]}
        cls.source = {c["name"]: c for c in compiled["projections"]["slack"]["channels"]}

    def test_every_authored_message_reaches_the_overlay(self) -> None:
        for name, channel in self.source.items():
            with self.subTest(channel=name):
                self.assertEqual(len(channel["messages"]), len(self.channels[name]["messages"]))

    def test_an_author_is_named_not_given_a_world_slack_id(self) -> None:
        for name, channel in self.channels.items():
            for message in channel["messages"]:
                with self.subTest(channel=name):
                    self.assertFalse(message["user"].startswith("U0"), message["user"])

    def test_timestamps_are_derived_from_the_authored_time_and_ordered(self) -> None:
        from worldfixture_compiler.compiler import _slack_ts

        lumen = self.channels["lumen-renewal"]["messages"]
        stamps = [message["ts"] for message in lumen]

        self.assertEqual(stamps, sorted(stamps))
        self.assertEqual(_slack_ts(self.source["lumen-renewal"]["messages"][0]["timestamp"], 1), stamps[0])

    def test_the_world_keeps_its_own_general_topic(self) -> None:
        # Upstream self-seeds a `general` channel; the world declares its own.
        self.assertEqual(
            "Company updates and questions for everyone",
            self.channels["general"]["topic"],
        )


class GitHubIssueTest(unittest.TestCase):
    """A reference the world makes across services has to resolve.

    Cross-service references have to agree, and the world exercises that
    directly: a Slack message names issue 322 by number, so the GitHub emulator
    has to be able to answer for it.
    """

    @classmethod
    def setUpClass(cls) -> None:
        from worldfixture_compiler import load_world

        root = Path(__file__).resolve().parents[2]
        world, _provenance = load_world(root / "worlds/business.saas-company.v2/world.json")
        compiled = compile_world(world)
        cls.overlay = compiled["projections"]["emulator-overlay"]["github"]
        cls.canonical = compiled["projections"]["github"]
        cls.slack = compiled["projections"]["slack"]

    def test_every_authored_issue_reaches_the_emulator_overlay(self) -> None:
        canonical = sum(len(repo.get("issues", [])) for repo in self.canonical["repos"])
        overlay = sum(len(repo.get("issues", [])) for repo in self.overlay["repos"])

        self.assertEqual(3, canonical)
        self.assertEqual(canonical, overlay)

    def test_the_issue_slack_names_by_number_is_projected(self) -> None:
        mentioned = [
            message
            for channel in self.slack["channels"]
            for message in channel["messages"]
            if (message.get("entity_refs") or message.get("worldfixture_entity_refs") or {}).get("issue_id")
            == "issue-322"
        ]
        self.assertTrue(mentioned, "the world should still name issue-322 from Slack")

        numbers = {issue["number"] for repo in self.overlay["repos"] for issue in repo["issues"]}
        self.assertIn(322, numbers)

    def test_an_issue_author_is_a_login_the_workspace_knows(self) -> None:
        logins = {user["login"] for user in self.overlay["users"]}
        for repo in self.overlay["repos"]:
            for issue in repo["issues"]:
                with self.subTest(number=issue["number"]):
                    self.assertIn(issue["author"], logins)
                    for assignee in issue["assignees"]:
                        self.assertIn(assignee, logins)


class SlackMembershipTest(unittest.TestCase):
    """Upstream seeding puts every user in every channel, erasing the world's own.

    The world differentiates membership, and an overlay that drops `member_ids`
    lets the emulator replace it with the whole workspace.
    """

    @classmethod
    def setUpClass(cls) -> None:
        from worldfixture_compiler import load_world

        root = Path(__file__).resolve().parents[2]
        world, _provenance = load_world(root / "worlds/business.saas-company.v2/world.json")
        compiled = compile_world(world)
        cls.overlay = {c["name"]: c for c in compiled["projections"]["emulator-overlay"]["slack"]["channels"]}
        cls.source = {c["name"]: c for c in compiled["projections"]["slack"]["channels"]}
        cls.people = compiled["projections"]["slack"]["users"]

    def test_the_overlay_carries_the_world_s_own_membership(self) -> None:
        for name, channel in self.source.items():
            with self.subTest(channel=name):
                self.assertEqual(len(channel["member_ids"]), len(self.overlay[name]["members"]))

    def test_membership_is_not_simply_the_whole_workspace(self) -> None:
        sizes = {name: len(c["members"]) for name, c in self.overlay.items()}
        self.assertLess(min(sizes.values()), len(self.people), f"every channel holds everyone: {sizes}")

    def test_members_are_named_so_the_emulator_can_resolve_them(self) -> None:
        names = {user["name"] for user in self.people}
        for name, channel in self.overlay.items():
            with self.subTest(channel=name):
                self.assertTrue(set(channel["members"]).issubset(names))



class RebaseTest(unittest.TestCase):
    """A rebase must move every reviewed date by exactly one delta.

    The timestamp and date substitutions run in sequence over the same string,
    so a date pattern without a lookahead re-matches the date half of a
    timestamp the first pass already moved and shifts it twice. The world then
    loses its internal order — mail arrives after the invoice it discusses is
    due — while every individual date still looks plausible.
    """

    TARGET = "2026-09-04T09:00:00+00:00"
    DELTA_DAYS = 14

    @classmethod
    def setUpClass(cls) -> None:
        from datetime import datetime

        from worldfixture_compiler import load_world
        from worldfixture_compiler.compiler import rebase_world

        root = Path(__file__).resolve().parents[2]
        cls.source, _ = load_world(root / "worlds/business.saas-company.v2/world.json")
        cls.rebased = rebase_world(cls.source, datetime.fromisoformat(cls.TARGET))

    def _shift(self, before: str, after: str) -> int:
        from datetime import date

        return (date.fromisoformat(after[:10]) - date.fromisoformat(before[:10])).days

    def test_a_timestamp_moves_by_one_delta_not_two(self) -> None:
        pairs = [
            ("mail sent_at", self.source["communication"]["mail"][0]["sent_at"],
             self.rebased["communication"]["mail"][0]["sent_at"]),
            ("calendar start", self.source["communication"]["calendar_events"][0]["start"],
             self.rebased["communication"]["calendar_events"][0]["start"]),
        ]
        for label, before, after in pairs:
            with self.subTest(field=label):
                self.assertEqual(self.DELTA_DAYS, self._shift(before, after))

    def test_a_plain_date_moves_by_the_same_delta(self) -> None:
        before = self.source["finance"]["anchor_invoices"][0]["due_on"]
        after = self.rebased["finance"]["anchor_invoices"][0]["due_on"]

        self.assertEqual(self.DELTA_DAYS, self._shift(before, after))

    def test_mail_still_precedes_the_invoice_it_discusses(self) -> None:
        # The ordering the double shift destroyed, stated as the invariant it is.
        invoice = next(i for i in self.rebased["finance"]["anchor_invoices"] if i["id"] == "inv-4471")
        sent = [m["sent_at"][:10] for m in self.rebased["communication"]["mail"]]

        self.assertTrue(sent, "the world should still author mail")
        self.assertLess(max(sent), invoice["due_on"], "mail must not postdate the invoice due date")


class CapabilityOwnershipTest(unittest.TestCase):
    """One provider's mutable state must have one route owner in a run.

    Two of these look alike and are not. SeaweedFS and `@emulators/aws` both
    serve S3, so only one may be given buckets. Cyrus and the Google emulator
    both carry a person's mail, but they are different capabilities: Cyrus is
    the world's own mail over SMTP and IMAP, and Google exists so an application
    can exercise the Gmail API and Sign in with Google. A run selects the
    surface its target actually integrates against.
    """

    @classmethod
    def setUpClass(cls) -> None:
        from worldfixture_compiler import load_world

        root = Path(__file__).resolve().parents[2]
        world, _provenance = load_world(root / "worlds/business.saas-company.v2/world.json")
        cls.projections = compile_world(world)["projections"]

    def test_the_aws_vendor_is_not_given_s3(self) -> None:
        # `@emulators/aws` serves /s3/. SeaweedFS is the S3 authority, so the
        # vendor must not receive buckets and become a second owner.
        self.assertNotIn("s3", self.projections["emulator-overlay"]["aws"])

    def test_the_aws_vendor_keeps_declared_iam_and_omits_undeclared_sqs(self) -> None:
        self.assertIn("iam", self.projections["emulator-overlay"]["aws"])
        self.assertNotIn("sqs", self.projections["emulator-overlay"]["aws"])

    def test_the_s3_service_still_gets_buckets_and_objects(self) -> None:
        s3 = self.projections["aws"]["s3"]

        self.assertTrue(s3["buckets"])
        self.assertTrue(s3["objects"])

    def test_mail_and_gmail_are_separate_surfaces_not_rival_owners(self) -> None:
        # Both project the same person's mail on purpose: one is the mailbox,
        # the other is the API an application integrates against.
        self.assertTrue(self.projections["mail"]["messages"])
        self.assertTrue(self.projections["google"]["messages"])


if __name__ == "__main__":
    unittest.main()


class MinimalWorldTest(unittest.TestCase):
    """The starter world in `examples/minimal-world` has to keep working.

    It is what the README points somebody at when they want a world of their own,
    and a template that does not compile is worse than no template. It also pins
    the smallest set of domains this profile can be authored against: when that
    set changes, this fails and the template and its README get updated with it.
    """

    SOURCE = Path(__file__).resolve().parents[2] / "examples/minimal-world/world.json"

    def test_the_starter_world_compiles(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            manifest = build_world(self.SOURCE, Path(directory) / "artifact")

        self.assertEqual("demo.minimal", manifest["world_id"])
        self.assertEqual("v1", manifest["world_version"])
        self.assertTrue(manifest["synthetic"])

    def test_the_starter_world_is_deterministic(self) -> None:
        digests = []
        for _ in range(2):
            with tempfile.TemporaryDirectory() as directory:
                digests.append(build_world(self.SOURCE, Path(directory) / "artifact")["artifact_sha256"])

        self.assertEqual(digests[0], digests[1])

    def test_independent_empty_domains_can_be_omitted(self) -> None:
        """Validation answers "will this build?", so it has to know what build needs.

        The validator read these domains with `.get(...)` and the compiler indexed
        them, so a world could validate cleanly and then die in `build` on a bare
        `KeyError` -- which the compiler's command line does not catch, so the
        author got a traceback.
        """
        source = json.loads(self.SOURCE.read_text())
        fragment = json.loads((self.SOURCE.parent / source["fragments"][0]).read_text())

        for domain in ("communication", "finance", "software", "support", "work", "agentic", "stories"):
            with self.subTest(domain=domain):
                without = copy.deepcopy(fragment)
                del without["contributes"][domain]
                if domain == "communication":
                    # A source with no channel cannot retain its chat arrival.
                    # This independent fixture asks the connected application
                    # to review the existing project instead.
                    without["contributes"]["timeline"] = [{
                        "id": "arrival-project-review", "after_seconds": 30, "kind": "application-event",
                        "payload": {"kind": "project.review.requested", "data": {"project_id": "project-exports"}},
                    }]
                with tempfile.TemporaryDirectory() as directory:
                    written = Path(directory)
                    (written / "fragments").mkdir()
                    (written / "fragments/core.json").write_text(json.dumps(without))
                    (written / "world.json").write_text(json.dumps(source))
                    build_world(written / "world.json", written / "artifact")
                    compiled = json.loads((written / "artifact/world.json").read_text())
                    self.assertNotIn(domain, compiled)


class ProseRebaseTest(unittest.TestCase):
    """Rebasing prose has to move the dates it claims to move, and only those.

    `_rebase_text` rewrites the dates a world's authored prose mentions so that a
    rebased world reads the way it runs. Three faults were measured against it,
    each of them silent: a date on the far side of a year boundary was never
    moved, an ordinal lost its suffix, and a number that is not a day failed the
    whole build.
    """

    ANCHOR = date(2027, 1, 5)
    WEEK = timedelta(days=7)

    def test_a_december_date_rebases_under_a_january_anchor(self) -> None:
        # `date(anchor.year, ...)` read "30 December" under a 5 January 2027
        # anchor as 2027-12-30, eleven months ahead, so it fell outside the
        # +/-35 day window and the sentence was left alone while every date
        # around it moved.
        self.assertEqual(
            "the export ran on 6 January and failed",
            _rebase_text("the export ran on 30 December and failed", self.ANCHOR, self.WEEK),
        )

    def test_a_date_a_year_from_the_anchor_is_still_left_alone(self) -> None:
        # The window is what keeps rebasing out of prose about something real
        # and fixed. Reading the year from the nearest candidate must not widen
        # it: the candidates are a year apart and the window is 70 days wide, so
        # at most one of them can ever fall inside.
        text = "the company was founded on 30 December"

        self.assertEqual(text, _rebase_text(text, date(2027, 7, 1), self.WEEK))

    def test_an_ordinal_keeps_a_suffix_that_fits_the_shifted_day(self) -> None:
        # The suffix was captured as group 2 and discarded, so "the 3rd March"
        # rebased to "the 10 March". `_ordinal` was written for exactly this and
        # was called from nowhere.
        self.assertEqual(
            "the 10th March review",
            _rebase_text("the 3rd March review", date(2027, 3, 3), self.WEEK),
        )
        # The suffix follows the shifted day, not the authored one.
        self.assertEqual(
            "due 21st March",
            _rebase_text("due 14th March", date(2027, 3, 14), self.WEEK),
        )

    def test_prose_that_is_not_a_date_does_not_fail_the_build(self) -> None:
        # Each of these raised a bare `ValueError: day 31 must be in range
        # 1..28` out of `date()`, which failed the build and named no world,
        # file or field. The pattern matches any one or two digit number before
        # a month name, so "62 June" is ordinary prose rather than a typo, and
        # refusing it would refuse a world that is not wrong.
        for text in ("due 31 February", "we shipped 62 June units", "logged 2026-02-30 in the audit"):
            with self.subTest(text=text):
                self.assertEqual(text, _rebase_text(text, date(2026, 2, 20), self.WEEK))


@unittest.skipUnless(hasattr(time, "tzset"), "the host cannot change its zone in-process")
class SlackTimestampTest(unittest.TestCase):
    """One world source compiles to one artifact, on any machine."""

    def test_an_authored_time_without_an_offset_is_read_as_utc(self) -> None:
        # `_slack_ts` parsed a `Z`-less authored time into a naive datetime and
        # called `.timestamp()`, which reads the HOST's zone. Building the v2
        # world with the `Z` removed from one channel message gave
        # artifact_sha256 c5c554ef under TZ=UTC, cde8b503 under TZ=Asia/Tokyo
        # and 377d0209 under TZ=US/Pacific: three artifacts from one source, on
        # a compiler whose whole contract is one world, one digest.
        original = os.environ.get("TZ")
        stamps = set()
        try:
            for zone in ("UTC", "Asia/Tokyo", "US/Pacific"):
                os.environ["TZ"] = zone
                time.tzset()
                stamps.add(_slack_ts("2026-08-20T09:00:00", 1))
        finally:
            if original is None:
                os.environ.pop("TZ", None)
            else:
                os.environ["TZ"] = original
            time.tzset()

        self.assertEqual({_slack_ts("2026-08-20T09:00:00Z", 1)}, stamps)
