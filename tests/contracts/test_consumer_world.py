"""The consumer world, and the compiler capability it needed.

`business.operations/v1` was written for a company that sells to companies. A
brand that sells to people needs two things that profile did not have: a catalog
with an order book, and the public activity -- posts, reviews, comments -- that
a consumer brand carries about itself. Both are optional records on the same
profile rather than a parallel one, so everything the existing world already
projects keeps working for the new one.

These tests hold three claims:

1. The optional records are validated, not merely copied. An order that states a
   total its own lines do not add up to is refused.
2. A world that declares none of them compiles exactly as before, which is what
   keeps the v2 parity fixture honest.
3. The reviewed consumer world validates, builds deterministically, and carries
   no other world's names in its projections.
"""

from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path

from worldfixture_compiler import WorldError, build_world, load_world, validate_world
from worldfixture_compiler.compiler import PACK_SOURCES, compile_world, prune_world

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "worlds/consumer.retail-brand.v1/world.json"
BUSINESS_SOURCE = ROOT / "worlds/business.saas-company.v2/world.json"


def consumer_world() -> dict:
    return load_world(SOURCE)[0]


class CommerceAndSocialRecordsTest(unittest.TestCase):
    """The rules the new collections are held to."""

    def setUp(self) -> None:
        self.world = consumer_world()

    def test_an_order_total_that_disagrees_with_its_lines_is_refused(self) -> None:
        world = copy.deepcopy(self.world)
        order = world["commerce"]["orders"][0]
        order["total_cents"] += 100

        with self.assertRaisesRegex(WorldError, f"order {order['id']} states total"):
            validate_world(world)

    def test_an_order_subtotal_that_disagrees_with_its_lines_is_refused(self) -> None:
        world = copy.deepcopy(self.world)
        order = world["commerce"]["orders"][0]
        order["subtotal_cents"] += 100
        order["total_cents"] += 100

        with self.assertRaisesRegex(WorldError, f"order {order['id']} states subtotal"):
            validate_world(world)

    def test_an_order_line_naming_a_product_the_world_does_not_have_is_refused(self) -> None:
        world = copy.deepcopy(self.world)
        world["commerce"]["orders"][0]["items"][0]["product_id"] = "prod-does-not-exist"

        with self.assertRaisesRegex(WorldError, "has unknown product"):
            validate_world(world)

    def test_an_order_placed_by_nobody_is_refused(self) -> None:
        world = copy.deepcopy(self.world)
        world["commerce"]["orders"][0]["shopper_id"] = "someone-else"

        with self.assertRaisesRegex(WorldError, "has unknown shopper"):
            validate_world(world)

    def test_a_review_of_a_product_the_world_does_not_sell_is_refused(self) -> None:
        world = copy.deepcopy(self.world)
        world["social"]["reviews"][0]["product_id"] = "prod-does-not-exist"

        with self.assertRaisesRegex(WorldError, "has unknown product"):
            validate_world(world)

    def test_a_review_rating_outside_one_to_five_is_refused(self) -> None:
        world = copy.deepcopy(self.world)
        world["social"]["reviews"][0]["rating"] = 6

        with self.assertRaisesRegex(WorldError, "has invalid rating"):
            validate_world(world)

    def test_a_comment_with_nothing_to_hang_from_is_refused(self) -> None:
        world = copy.deepcopy(self.world)
        world["social"]["comments"][0]["parent_id"] = "post-does-not-exist"

        with self.assertRaisesRegex(WorldError, "has no post or review to hang from"):
            validate_world(world)

    def test_a_catalog_product_may_not_take_a_subscription_plan_name(self) -> None:
        """Both become one Stripe product, so two of the same name is one record
        silently standing for two different things."""
        world = copy.deepcopy(self.world)
        plan = world["finance"]["customers"][0]["service"]
        world["commerce"]["products"][0]["name"] = plan

        with self.assertRaisesRegex(WorldError, "is named after subscription plan"):
            compile_world(world)


class OptionalRecordsAreOptionalTest(unittest.TestCase):
    """A world with no catalog is unchanged by the fact that one can exist."""

    def test_a_world_without_commerce_or_social_declares_neither_pack(self) -> None:
        compiled = compile_world(load_world(BUSINESS_SOURCE)[0])

        self.assertNotIn("commerce", compiled["packs"])
        self.assertNotIn("social", compiled["packs"])

    def test_a_world_without_a_catalog_projects_only_its_subscription_plans(self) -> None:
        world = load_world(BUSINESS_SOURCE)[0]
        stripe = compile_world(world)["projections"]["stripe"]
        plans = {customer["service"] for customer in world["finance"]["customers"]}

        self.assertEqual(plans, {product["name"] for product in stripe["products"]})
        self.assertEqual(len(world["finance"]["customers"]), len(stripe["prices"]))


class ConsumerWorldTest(unittest.TestCase):
    """The reviewed world itself."""

    def setUp(self) -> None:
        self.world = consumer_world()

    def test_the_source_is_valid(self) -> None:
        validate_world(self.world)

    def test_the_world_carries_a_catalog_an_order_book_and_public_activity(self) -> None:
        compiled = compile_world(self.world)

        self.assertIn("commerce", compiled["packs"])
        self.assertIn("social", compiled["packs"])
        self.assertTrue(compiled["packs"]["commerce"]["products"])
        self.assertTrue(compiled["packs"]["commerce"]["orders"])
        for collection in ("posts", "reviews", "comments"):
            self.assertTrue(compiled["packs"]["social"][collection], collection)

    def test_every_catalog_product_is_purchasable_through_stripe(self) -> None:
        stripe = compile_world(self.world)["projections"]["stripe"]
        priced = {price.get("worldfixture_product_id") for price in stripe["prices"]}

        for product in self.world["commerce"]["products"]:
            with self.subTest(product=product["id"]):
                self.assertIn(product["id"], priced)

    def test_the_world_stays_small_enough_to_start_quickly(self) -> None:
        """The larger business world takes about two minutes to start, nearly
        all of it mail. This world exists to be the fast one, so the mailbox and
        message counts are part of its contract rather than an accident."""
        compiled = compile_world(self.world)
        mail = compiled["projections"]["mail"]

        self.assertLessEqual(len(mail["users"]), 60, "one mailbox is created per person")
        self.assertLessEqual(len(mail["messages"]), 400, "every message is delivered over LMTP at start")

    def test_every_address_and_domain_is_inside_the_reserved_test_tld(self) -> None:
        for organization in self.world["organizations"]:
            with self.subTest(organization=organization["id"]):
                self.assertTrue(organization["domain"].endswith(".worldfixture.test"))
        for person in self.world["people"]:
            with self.subTest(person=person["id"]):
                self.assertTrue(person["email"].endswith(".worldfixture.test"))

    def test_no_projection_carries_another_world_s_names(self) -> None:
        """A second world found four of these: a Slack bot, an issue-tracker
        team, a database cluster and an Okta group prefix, all named after the
        first world because nothing else had ever been compiled."""
        projections = compile_world(self.world)["projections"]
        rendered = json.dumps(projections).lower()

        # `"nstar"` is quoted because `unstarted`, a Linear workflow state
        # name, contains the same five letters and is not a leak.
        for name in ("northstar", '"nstar"', "lumen", "saas-company"):
            with self.subTest(name=name):
                self.assertNotIn(name, rendered)

    def test_the_site_counts_the_world_rather_than_restating_it(self) -> None:
        http_targets = compile_world(self.world)["projections"]["http-targets"]
        values = {metric["name"]: metric["value"] for metric in http_targets["metrics"]}

        self.assertEqual(len(self.world["commerce"]["orders"]), values["marlow_pine_orders_total"])
        self.assertEqual(len(self.world["social"]["reviews"]), values["marlow_pine_reviews_published"])
        self.assertEqual(
            sum(order["total_cents"] for order in self.world["commerce"]["orders"]),
            values["marlow_pine_order_value_cents"],
        )

    def test_the_same_source_builds_the_same_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = build_world(SOURCE, root / "first")
            second = build_world(SOURCE, root / "second")

            self.assertEqual(first, second)
            for name in first["files"]:
                self.assertEqual(
                    (root / "first" / name).read_bytes(),
                    (root / "second" / name).read_bytes(),
                    name,
                )

    def test_dropping_a_domain_leaves_no_reference_pointing_at_nothing(self) -> None:
        """`prune_world` validates its own result, so a domain whose closure is
        wrong raises here rather than producing a world that only looks whole."""
        every = set(PACK_SOURCES)
        for pack in sorted(every - {"identity"}):
            with self.subTest(dropped=pack):
                pruned = prune_world(self.world, every - {pack})
                validate_world(pruned)

    def test_dropping_the_catalog_takes_the_orders_and_reviews_with_it(self) -> None:
        pruned = prune_world(self.world, set(PACK_SOURCES) - {"commerce"})

        self.assertEqual([], pruned["commerce"]["products"])
        self.assertEqual([], pruned["commerce"]["orders"])
        self.assertEqual([], pruned["social"]["reviews"])
        # A comment that answered a review it no longer has is not a comment.
        self.assertTrue(
            all(comment["parent_id"].startswith("post-") for comment in pruned["social"]["comments"])
        )


if __name__ == "__main__":
    unittest.main()
