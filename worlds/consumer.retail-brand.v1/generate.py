#!/usr/bin/env python3
"""Generate the fragments for `consumer.retail-brand:v1`.

WHY A SECOND WORLD. `business.saas-company` is a company that sells to other
companies: the records that matter are accounts, renewals, releases and
invoices. A consumer brand has a different shape. Its customers are people who
buy one thing at a time, its money arrives as orders rather than contracts, and
a large part of what it knows about itself is public -- reviews, comments and a
journal anyone can read. A world with only the first shape cannot exercise the
second.

WHY IT IS SMALL ON PURPOSE. The larger business world takes about two minutes to
start, almost all of it mail: 161 mailboxes and 3,069 messages delivered over
LMTP. This world is sized to start in seconds with every part running, so it can
be the world a test suite or a first-time reader uses. Forty-one people, about
one hundred and sixty messages.

WHY A GENERATOR AND NOT HAND-WRITTEN JSON. The order book and the billing
history are the two collections a consumer world needs volume in, and volume
written by hand grows dangling references. Everything that carries a storyline
-- posts, reviews, comments, support cases, mail threads, issues -- is written
out longhand below, because that prose is the world. Only the order lines and
one marketing send are composed, and they are composed from one seeded
generator, so running this twice produces byte-identical fragments.

This generator writes the three base fragments only. The manifest and the
hand-authored google-mailboxes.json and finance-settlements.json fragments stay
unchanged. Explicit payment dates, refunds, and one-time orders live in the
finance fragment; generated order and Club totals do not include them.

WHAT MAKES IT COHERENT RATHER THAN MERELY POPULATED. Five storylines run through
it: a collection launching a week from the anchor with one item short, a glaze
fault in a discontinued mug that the brand decided to announce before anyone
asked, a subscription renewal that charged two members twice, a mis-scanned
pallet that left eleven orders shipped with no tracking, and a verified-buyer
badge that does not work for guest checkout. Each one owns its products, orders,
reviews, cases, issues, channel threads, mail and share of the timeline.

    python3 worlds/consumer.retail-brand.v1/generate.py
"""

from __future__ import annotations

import json
import random
from datetime import datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
ANCHOR = datetime(2027, 3, 18, 9, 0)  # Thursday
SEED = 20270318

BRAND_DOMAIN = "marlowandpine.worldfixture.test"


def iso(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def day(offset: int) -> str:
    """An ISO day `offset` days from the anchor. Negative is the past."""
    return (ANCHOR + timedelta(days=offset)).date().isoformat()


def stamp(days_before: float, hour: int, minute: int = 0) -> str:
    moment = ANCHOR - timedelta(days=days_before)
    return iso(moment.replace(hour=hour, minute=minute, second=0, microsecond=0))


def money(cents: int) -> str:
    return f"{cents // 100}.{cents % 100:02d}"


# ---------------------------------------------------------------------------
# Organizations
#
# Two of these are consumer email providers, not employers. A world of shoppers
# still has to say where each person's address lives, and the profile asks every
# person for an organization. Saying "Everyday Mail" is true; inventing a company
# for each shopper would not be.
# ---------------------------------------------------------------------------

ORGANIZATIONS = [
    {
        "id": "marlow-pine",
        "name": "Marlow & Pine",
        "slug": "marlow-pine",
        "domain": BRAND_DOMAIN,
        "primary": True,
        "summary": "A direct-to-consumer homeware brand selling stoneware, linens and a monthly pantry box.",
    },
    {
        "id": "harrow-works",
        "name": "Harrow Works",
        "slug": "harrow-works",
        "domain": "harrow-works.worldfixture.test",
        "summary": "The pottery that produces Marlow & Pine stoneware.",
    },
    {
        "id": "swiftline-logistics",
        "name": "Swiftline Logistics",
        "slug": "swiftline-logistics",
        "domain": "swiftline.worldfixture.test",
        "summary": "The third-party warehouse that picks, packs and ships every order.",
    },
    {
        "id": "bramble-studio",
        "name": "Bramble Studio",
        "slug": "bramble-studio",
        "domain": "bramble-studio.worldfixture.test",
        "summary": "The creative studio on retainer for photography and campaign design.",
    },
    {
        "id": "everyday-mail",
        "name": "Everyday Mail",
        "slug": "everyday-mail",
        "domain": "everyday.worldfixture.test",
        "summary": "A consumer email provider. Shoppers hold personal addresses here; it is not their employer.",
    },
    {
        "id": "penny-post",
        "name": "Penny Post",
        "slug": "penny-post",
        "domain": "pennypost.worldfixture.test",
        "summary": "A second consumer email provider, for the same reason as Everyday Mail.",
    },
]


# ---------------------------------------------------------------------------
# People
# ---------------------------------------------------------------------------

# (id, name, role, team, location, status, emoji)
STAFF = [
    ("iris-mendel", "Iris Mendel", "Founder and CEO", "leadership", "Brooklyn", "Drop review until 14:00", ":clipboard:"),
    ("callum-reid", "Callum Reid", "Head of operations", "operations", "Portland", "On the pallet trace", ":package:"),
    ("sana-devi", "Sana Devi", "Customer experience lead", "support", "Austin", "Replying to mug replacements", ":love_letter:"),
    ("otto-lindqvist", "Otto Lindqvist", "Customer experience specialist", "support", "Chicago", "Tracking follow-ups", ":mag:"),
    ("bea-morrow", "Bea Morrow", "Head of marketing", "marketing", "Brooklyn", "Writing the crazing note", ":pencil2:"),
    ("felix-arana", "Felix Arana", "Lifecycle marketing manager", "marketing", "Denver", "Club send on hold", ":pause_button:"),
    ("yuki-tanabe", "Yuki Tanabe", "Community manager", "marketing", "Seattle", "Reading review replies", ":speech_balloon:"),
    ("mira-halvorsen", "Mira Halvorsen", "Head of product", "product", "Minneapolis", "Fieldstone go or no-go", ":thinking_face:"),
    ("gus-ferreira", "Gus Ferreira", "Senior engineer, storefront", "engineering", "Oakland", "Preorder badge fix", ":wrench:"),
    ("anya-kowalski", "Anya Kowalski", "Software engineer", "engineering", "Pittsburgh", "Review sort", ":bar_chart:"),
    ("tomas-brekke", "Tomas Brekke", "Software engineer, payments", "engineering", "Boston", "Renewal retry", ":credit_card:"),
    ("rosa-delgado", "Rosa Delgado", "Finance and planning lead", "finance", "Santa Fe", "Credit notes", ":abacus:"),
    ("kit-nwosu", "Kit Nwosu", "Supply and inventory planner", "operations", "Providence", "Counting bowls", ":bowl_with_spoon:"),
    ("lena-fischer", "Lena Fischer", "Studio and photography", "marketing", "Hudson", "Reshooting the jug", ":camera:"),
]

# (id, name, role, organization, location)
PARTNERS = [
    ("harriet-vance", "Harriet Vance", "Production manager", "harrow-works", "Asheville"),
    ("desmond-oyelaran", "Desmond Oyelaran", "Fulfilment account manager", "swiftline-logistics", "Columbus"),
    ("juno-park", "Juno Park", "Creative director", "bramble-studio", "Los Angeles"),
]

# (id, name, city). Every second shopper is on the second mail provider, so an
# application that groups by domain sees more than one.
SHOPPERS = [
    ("alma-reyes", "Alma Reyes", "Tucson"),
    ("bennett-cho", "Bennett Cho", "Sacramento"),
    ("clara-voight", "Clara Voight", "Madison"),
    ("dmitri-sokolov", "Dmitri Sokolov", "Cleveland"),
    ("esme-fontaine", "Esme Fontaine", "New Orleans"),
    ("franklin-obi", "Franklin Obi", "Atlanta"),
    ("greta-lindholm", "Greta Lindholm", "Duluth"),
    ("hugo-marchetti", "Hugo Marchetti", "Providence"),
    ("imogen-bell", "Imogen Bell", "Asheville"),
    ("jonas-wirth", "Jonas Wirth", "Milwaukee"),
    ("kaia-nakamura", "Kaia Nakamura", "Honolulu"),
    ("leo-santoro", "Leo Santoro", "Philadelphia"),
    ("maren-oduya", "Maren Oduya", "Houston"),
    ("nils-bergstrom", "Nils Bergstrom", "Boise"),
    ("orla-brennan", "Orla Brennan", "Buffalo"),
    ("paavo-virtanen", "Paavo Virtanen", "Fargo"),
    ("quinn-abara", "Quinn Abara", "Baltimore"),
    ("rania-haddad", "Rania Haddad", "Dearborn"),
    ("soren-mikkelsen", "Soren Mikkelsen", "Tacoma"),
    ("tilda-nyberg", "Tilda Nyberg", "Burlington"),
    ("umberto-rossi", "Umberto Rossi", "Kansas City"),
    ("vera-pahlsson", "Vera Pahlsson", "Spokane"),
    ("wes-agyeman", "Wes Agyeman", "Charlotte"),
    ("zoya-petrosyan", "Zoya Petrosyan", "Glendale"),
]


def people_records() -> list[dict]:
    people: list[dict] = []
    for index, (person_id, name, role, team, location, status, emoji) in enumerate(STAFF, start=1):
        people.append(
            {
                "id": person_id,
                "name": name,
                "email": f"{name.split()[0].lower()}@{BRAND_DOMAIN}",
                "organization_id": "marlow-pine",
                "role": role,
                "team": team,
                "location": location,
                "status": status,
                "status_emoji": emoji,
                **({"primary": True} if person_id == "iris-mendel" else {}),
            }
        )
    for index, (person_id, name, role, organization_id, location) in enumerate(PARTNERS, start=1):
        domain = next(item["domain"] for item in ORGANIZATIONS if item["id"] == organization_id)
        people.append(
            {
                "id": person_id,
                "name": name,
                "email": f"{name.split()[0].lower()}@{domain}",
                "organization_id": organization_id,
                "role": role,
                "team": "partner",
                "location": location,
            }
        )
    for index, (person_id, name, city) in enumerate(SHOPPERS, start=1):
        organization_id = "everyday-mail" if index % 2 else "penny-post"
        domain = next(item["domain"] for item in ORGANIZATIONS if item["id"] == organization_id)
        people.append(
            {
                "id": person_id,
                "name": name,
                "email": f"{person_id.replace('-', '.')}@{domain}",
                "organization_id": organization_id,
                "role": "Shopper",
                "team": "shopper",
                "location": city,
            }
        )
    return people


PEOPLE = people_records()
SHOPPER_IDS = [person_id for person_id, _name, _city in SHOPPERS]
NAME_BY_ID = {person["id"]: person["name"] for person in PEOPLE}


def first_name(person_id: str) -> str:
    return NAME_BY_ID[person_id].split()[0]


# ---------------------------------------------------------------------------
# Catalog
# ---------------------------------------------------------------------------

PRODUCTS = [
    {
        "id": "prod-fieldstone-mug",
        "sku": "FS-MUG-01",
        "name": "Fieldstone mug",
        "collection": "Fieldstone",
        "category": "stoneware",
        "summary": "A twelve-ounce stoneware mug in the new Fieldstone glaze.",
        "price_cents": 2800,
        "currency": "USD",
        "status": "active",
        "launched_on": day(-24),
    },
    {
        "id": "prod-fieldstone-bowl",
        "sku": "FS-BWL-01",
        "name": "Fieldstone serving bowl",
        "collection": "Fieldstone",
        "category": "stoneware",
        "summary": "A wide serving bowl, thrown and glazed in small batches.",
        "price_cents": 7400,
        "currency": "USD",
        "status": "preorder",
        "launched_on": day(7),
    },
    {
        "id": "prod-fieldstone-plate",
        "sku": "FS-PLT-01",
        "name": "Fieldstone dinner plate",
        "collection": "Fieldstone",
        "category": "stoneware",
        "summary": "A ten-inch dinner plate with an unglazed foot.",
        "price_cents": 3600,
        "currency": "USD",
        "status": "active",
        "launched_on": day(-24),
    },
    {
        "id": "prod-fieldstone-jug",
        "sku": "FS-JUG-01",
        "name": "Fieldstone water jug",
        "collection": "Fieldstone",
        "category": "stoneware",
        "summary": "A one-litre jug for water or milk, dishwasher safe.",
        "price_cents": 5800,
        "currency": "USD",
        "status": "active",
        "launched_on": day(-24),
    },
    {
        "id": "prod-linen-apron",
        "sku": "LN-APR-02",
        "name": "Washed linen apron",
        "collection": "Kitchen linens",
        "category": "linen",
        "summary": "A cross-back apron in washed European linen.",
        "price_cents": 6400,
        "currency": "USD",
        "status": "active",
        "launched_on": day(-620),
    },
    {
        "id": "prod-linen-napkins",
        "sku": "LN-NAP-04",
        "name": "Linen napkin set of four",
        "collection": "Kitchen linens",
        "category": "linen",
        "summary": "Four hemmed napkins that soften with every wash.",
        "price_cents": 4200,
        "currency": "USD",
        "status": "active",
        "launched_on": day(-620),
    },
    {
        "id": "prod-linen-runner",
        "sku": "LN-RUN-01",
        "name": "Linen table runner",
        "collection": "Kitchen linens",
        "category": "linen",
        "summary": "A two-metre runner for a long table.",
        "price_cents": 4800,
        "currency": "USD",
        "status": "active",
        "launched_on": day(-410),
    },
    {
        "id": "prod-cast-skillet",
        "sku": "CK-SKL-10",
        "name": "Cast iron skillet",
        "collection": "Cookware",
        "category": "cookware",
        "summary": "A pre-seasoned ten-inch skillet, made in Ohio.",
        "price_cents": 8900,
        "currency": "USD",
        "status": "active",
        "launched_on": day(-800),
    },
    {
        "id": "prod-oak-board",
        "sku": "WD-BRD-01",
        "name": "Oak serving board",
        "collection": "Table",
        "category": "wood",
        "summary": "A white oak board finished with food-safe oil.",
        "price_cents": 5200,
        "currency": "USD",
        "status": "active",
        "launched_on": day(-540),
    },
    {
        "id": "prod-beeswax-wrap",
        "sku": "PT-WRP-03",
        "name": "Beeswax wrap set",
        "collection": "Pantry",
        "category": "pantry",
        "summary": "Three cotton wraps in small, medium and large.",
        "price_cents": 2400,
        "currency": "USD",
        "status": "active",
        "launched_on": day(-300),
    },
    {
        "id": "prod-sea-salt",
        "sku": "PT-SLT-01",
        "name": "Flaked sea salt tin",
        "collection": "Pantry",
        "category": "pantry",
        "summary": "A refillable tin of flaked sea salt.",
        "price_cents": 1600,
        "currency": "USD",
        "status": "active",
        "launched_on": day(-300),
    },
    {
        "id": "prod-olive-oil",
        "sku": "PT-OIL-01",
        "name": "Cold-pressed olive oil",
        "collection": "Pantry",
        "category": "pantry",
        "summary": "A 500ml tin from a single grove, pressed each November.",
        "price_cents": 3200,
        "currency": "USD",
        "status": "active",
        "launched_on": day(-300),
    },
    {
        "id": "prod-harbour-mug",
        "sku": "HB-MUG-01",
        "name": "Harbour mug (first run)",
        "collection": "Harbour",
        "category": "stoneware",
        "summary": "The first stoneware mug Marlow & Pine sold. Withdrawn after the glaze fault.",
        "price_cents": 2600,
        "currency": "USD",
        "status": "retired",
        "launched_on": day(-500),
    },
    {
        "id": "prod-candle-pair",
        "sku": "HM-CND-02",
        "name": "Bayberry candle pair",
        "collection": "Home",
        "category": "home",
        "summary": "Two hand-poured bayberry candles, made once a year.",
        "price_cents": 3400,
        "currency": "USD",
        "status": "sold-out",
        "launched_on": day(-140),
    },
]

PRODUCT_BY_ID = {product["id"]: product for product in PRODUCTS}


# ---------------------------------------------------------------------------
# Orders
#
# Fifty-two composed orders give the world a believable order book. Ten more are
# written out because they carry a storyline: the withdrawn mug, the preorders
# taken on the bowl, and the pallet Swiftline mis-scanned.
# ---------------------------------------------------------------------------

GENERIC_POOL = [
    "prod-fieldstone-mug",
    "prod-fieldstone-plate",
    "prod-fieldstone-jug",
    "prod-linen-apron",
    "prod-linen-napkins",
    "prod-linen-runner",
    "prod-cast-skillet",
    "prod-oak-board",
    "prod-beeswax-wrap",
    "prod-sea-salt",
    "prod-olive-oil",
    "prod-candle-pair",
]

CITY_BY_SHOPPER = {person_id: city for person_id, _name, city in SHOPPERS}

# The eleven orders on the pallet Swiftline scanned as shipped without reading
# the tracking labels. Named here so support mail, the case and the order book
# agree on which ones they are.
PALLET_ORDER_IDS = [f"order-100{index:02d}" for index in (7, 11, 15, 19, 23, 27, 31, 35, 39, 43, 47)]


def order_line(product_id: str, quantity: int) -> dict:
    return {
        "product_id": product_id,
        "quantity": quantity,
        "unit_amount_cents": PRODUCT_BY_ID[product_id]["price_cents"],
    }


def totals(order: dict) -> dict:
    subtotal = sum(item["quantity"] * item["unit_amount_cents"] for item in order["items"])
    shipping = 0 if subtotal >= 7500 else 795
    discount = order.pop("discount_cents", 0)
    order["subtotal_cents"] = subtotal
    order["shipping_cents"] = shipping
    order["discount_cents"] = discount
    order["total_cents"] = subtotal + shipping - discount
    order["currency"] = "USD"
    return order


def composed_orders() -> list[dict]:
    rng = random.Random(SEED)
    orders = []
    for index in range(52):
        number = 10001 + index
        order_id = f"order-{number}"
        shopper_id = SHOPPER_IDS[(index * 7) % len(SHOPPER_IDS)]
        days_ago = 4 + (index * 3) // 2
        line_count = 1 + (index % 3 == 0) + (index % 7 == 0)
        chosen = rng.sample(GENERIC_POOL, line_count)
        # The candle pair sold out ninety days ago; it cannot appear in a newer
        # order, and the Fieldstone pieces did not exist before their launch.
        chosen = [
            item
            for item in chosen
            if not (item == "prod-candle-pair" and days_ago < 90)
            if not (item.startswith("prod-fieldstone") and days_ago > 24)
        ] or ["prod-sea-salt"]
        if days_ago >= 24:
            status = "returned" if index % 17 == 0 else "delivered"
        elif days_ago >= 12:
            status = "shipped"
        elif days_ago >= 6:
            status = "packed"
        else:
            status = "placed"
        order = {
            "id": order_id,
            "number": f"MP-{number}",
            "shopper_id": shopper_id,
            "placed_on": day(-days_ago),
            "status": status,
            "channel": "storefront-mobile" if index % 3 else "storefront",
            "shipping_city": CITY_BY_SHOPPER[shopper_id],
            "items": [order_line(item, 2 if item == "prod-sea-salt" and index % 5 == 0 else 1) for item in chosen],
            "discount_cents": 500 if index % 11 == 0 else 0,
        }
        if status in {"shipped", "delivered", "returned"}:
            order["shipped_on"] = day(-days_ago + 2)
        if order_id in PALLET_ORDER_IDS:
            order["status"] = "shipped"
            order["fulfilment_note"] = "Scanned onto the 12 March pallet. No carrier movement since."
        orders.append(totals(order))
    return orders


AUTHORED_ORDERS = [
    totals(
        {
            "id": "order-10101",
            "number": "MP-10101",
            "shopper_id": "clara-voight",
            "placed_on": day(-186),
            "status": "delivered",
            "shipped_on": day(-184),
            "channel": "storefront",
            "shipping_city": "Madison",
            "items": [order_line("prod-harbour-mug", 2)],
            "note": "One of the affected Harbour mug orders.",
        }
    ),
    totals(
        {
            "id": "order-10102",
            "number": "MP-10102",
            "shopper_id": "franklin-obi",
            "placed_on": day(-172),
            "status": "delivered",
            "shipped_on": day(-170),
            "channel": "storefront-mobile",
            "shipping_city": "Atlanta",
            "items": [order_line("prod-harbour-mug", 4), order_line("prod-sea-salt", 1)],
            "note": "One of the affected Harbour mug orders.",
        }
    ),
    totals(
        {
            "id": "order-10103",
            "number": "MP-10103",
            "shopper_id": "nils-bergstrom",
            "placed_on": day(-165),
            "status": "delivered",
            "shipped_on": day(-163),
            "channel": "storefront",
            "shipping_city": "Boise",
            "items": [order_line("prod-harbour-mug", 2), order_line("prod-oak-board", 1)],
            "note": "One of the affected Harbour mug orders.",
        }
    ),
    totals(
        {
            "id": "order-10104",
            "number": "MP-10104",
            "shopper_id": "rania-haddad",
            "placed_on": day(-158),
            "status": "returned",
            "shipped_on": day(-156),
            "channel": "storefront",
            "shipping_city": "Dearborn",
            "items": [order_line("prod-harbour-mug", 1)],
            "note": "Returned for crazing before the fault was understood.",
        }
    ),
    totals(
        {
            "id": "order-10105",
            "number": "MP-10105",
            "shopper_id": "wes-agyeman",
            "placed_on": day(-151),
            "status": "refunded",
            "shipped_on": day(-149),
            "channel": "storefront-mobile",
            "shipping_city": "Charlotte",
            "items": [order_line("prod-harbour-mug", 2)],
            "note": "Refunded for crazing before the fault was understood.",
        }
    ),
    totals(
        {
            "id": "order-10106",
            "number": "MP-10106",
            "shopper_id": "imogen-bell",
            "placed_on": day(-144),
            "status": "delivered",
            "shipped_on": day(-142),
            "channel": "storefront",
            "shipping_city": "Asheville",
            "items": [order_line("prod-harbour-mug", 3)],
            "note": "One of the affected Harbour mug orders.",
        }
    ),
    totals(
        {
            "id": "order-10201",
            "number": "MP-10201",
            "shopper_id": "alma-reyes",
            "placed_on": day(-3),
            "status": "placed",
            "channel": "storefront",
            "shipping_city": "Tucson",
            "items": [order_line("prod-fieldstone-bowl", 1), order_line("prod-fieldstone-mug", 2)],
            "note": "Preorder. Ships when the second kiln run passes inspection.",
        }
    ),
    totals(
        {
            "id": "order-10202",
            "number": "MP-10202",
            "shopper_id": "kaia-nakamura",
            "placed_on": day(-2),
            "status": "placed",
            "channel": "storefront-mobile",
            "shipping_city": "Honolulu",
            "items": [order_line("prod-fieldstone-bowl", 1)],
            "note": "Preorder. Ships when the second kiln run passes inspection.",
        }
    ),
    totals(
        {
            "id": "order-10203",
            "number": "MP-10203",
            "shopper_id": "soren-mikkelsen",
            "placed_on": day(-2),
            "status": "placed",
            "channel": "storefront",
            "shipping_city": "Tacoma",
            "items": [order_line("prod-fieldstone-bowl", 2), order_line("prod-fieldstone-plate", 4)],
            "note": "Preorder. Ships when the second kiln run passes inspection.",
        }
    ),
    totals(
        {
            "id": "order-10204",
            "number": "MP-10204",
            "shopper_id": "zoya-petrosyan",
            "placed_on": day(-1),
            "status": "placed",
            "channel": "storefront-mobile",
            "shipping_city": "Glendale",
            "items": [order_line("prod-fieldstone-bowl", 1), order_line("prod-linen-napkins", 1)],
            "note": "Preorder. Ships when the second kiln run passes inspection.",
        }
    ),
]


def order_records() -> list[dict]:
    return sorted(composed_orders() + AUTHORED_ORDERS, key=lambda order: order["id"])


ORDERS = order_records()


# ---------------------------------------------------------------------------
# Public activity
# ---------------------------------------------------------------------------

POSTS = [
    {
        "id": "post-fieldstone-preview",
        "author_id": "bea-morrow",
        "title": "Fieldstone arrives on 25 March",
        "body": (
            "Fieldstone is four pieces: a mug, a plate, a jug and a serving bowl. Everything is "
            "thrown at Harrow Works and glazed in batches of about two hundred. The bowl is the "
            "hardest of the four to get right, and the first run is short, so it opens as a preorder "
            "rather than as stock we do not have."
        ),
        "posted_at": stamp(6, 15, 0),
        "tags": ["fieldstone", "launch"],
        "product_ids": ["prod-fieldstone-mug", "prod-fieldstone-plate", "prod-fieldstone-jug", "prod-fieldstone-bowl"],
    },
    {
        "id": "post-harbour-crazing",
        "author_id": "iris-mendel",
        "title": "The Harbour mug is crazing, and we are replacing it",
        "body": (
            "About forty Harbour mugs from the first run develop fine cracks in the glaze after a "
            "few dishwasher cycles. It is a glaze fit problem, not a safety problem, and it is ours. "
            "We are writing to everyone who bought one. You do not need to send it back and you do "
            "not need a receipt."
        ),
        "posted_at": stamp(2, 11, 30),
        "tags": ["quality", "harbour"],
        "product_ids": ["prod-harbour-mug"],
    },
    {
        "id": "post-kiln-visit",
        "author_id": "lena-fischer",
        "title": "Two days at Harrow Works",
        "body": (
            "Photographs from the second Fieldstone firing: the glaze bucket, the kiln log, and "
            "Harriet holding the one bowl in twelve that came out with a crawl mark. The rejected "
            "pieces are why the bowl is short."
        ),
        "posted_at": stamp(9, 16, 20),
        "tags": ["fieldstone", "making"],
        "product_ids": ["prod-fieldstone-bowl"],
    },
    {
        "id": "post-pantry-march",
        "author_id": "felix-arana",
        "title": "What is in the March pantry box",
        "body": (
            "Flaked sea salt, the November olive oil, and a set of beeswax wraps. Boxes went out on "
            "the 4th for members billed on the 1st, and on the 11th for everyone else."
        ),
        "posted_at": stamp(14, 9, 45),
        "tags": ["pantry-club"],
        "product_ids": ["prod-sea-salt", "prod-olive-oil", "prod-beeswax-wrap"],
    },
    {
        "id": "post-club-billing",
        "author_id": "rosa-delgado",
        "title": "Two members were charged twice in March",
        "body": (
            "A renewal retry ran after the first attempt had already succeeded but had not been "
            "recorded. Two members paid twice. We found it in the March reconciliation, not from a "
            "complaint, and both credits are issued this week."
        ),
        "posted_at": stamp(1, 17, 10),
        "tags": ["pantry-club", "billing"],
        "product_ids": [],
    },
    {
        "id": "post-linen-care",
        "author_id": "yuki-tanabe",
        "title": "How to wash linen so it gets better",
        "body": (
            "Warm water, no fabric softener, and take it out of the dryer damp. Linen sheds its "
            "stiffness in about six washes and then stays that way for years."
        ),
        "posted_at": stamp(27, 10, 0),
        "tags": ["care", "linen"],
        "product_ids": ["prod-linen-apron", "prod-linen-napkins", "prod-linen-runner"],
    },
    {
        "id": "post-shipping-honestly",
        "author_id": "callum-reid",
        "title": "Where your order actually is",
        "body": (
            "Orders leave Swiftline in Columbus. A label is created when the box is packed and the "
            "first scan happens when the carrier collects, which can be a day later. If the tracking "
            "page has not moved in three days, that is a real problem and we want to hear about it."
        ),
        "posted_at": stamp(20, 13, 15),
        "tags": ["shipping"],
        "product_ids": [],
    },
    {
        "id": "post-verified-reviews",
        "author_id": "mira-halvorsen",
        "title": "Reviews now say whether the writer bought the thing",
        "body": (
            "Every review on a product page carries a verified badge if we can match it to an order. "
            "Guest checkout does not match yet, so some genuine buyers are still unbadged. We would "
            "rather show that than badge everyone."
        ),
        "posted_at": stamp(11, 12, 0),
        "tags": ["storefront", "reviews"],
        "product_ids": [],
    },
]


# (id, product, author, rating, title, body, days_before, hour, order_id, verified)
REVIEW_SOURCE = [
    ("review-harbour-01", "prod-harbour-mug", "clara-voight", 2, "Cracked all over after a month",
     "I loved this mug for about four weeks. Now the whole glaze is covered in tiny cracks. It only ever went in the dishwasher.",
     34, 19, "order-10101", True),
    ("review-harbour-02", "prod-harbour-mug", "franklin-obi", 2, "Same crazing as the other reviews",
     "Four mugs, three crazed. The fourth one I have been washing by hand and it is still fine, which tells you something.",
     21, 8, "order-10102", True),
    ("review-harbour-03", "prod-harbour-mug", "nils-bergstrom", 2, "Beautiful until it was not",
     "Fine cracks through the glaze after six weeks. Not sharp, not leaking, just clearly wrong for the price.",
     16, 21, "order-10103", True),
    ("review-harbour-04", "prod-harbour-mug", "imogen-bell", 4, "Mine are fine, but I hand wash",
     "Three mugs, no cracks, but I never put them in the dishwasher. Reading the other reviews I think that is the difference.",
     12, 7, "order-10106", True),
    ("review-fieldstone-01", "prod-fieldstone-mug", "alma-reyes", 5, "Heavier than it looks, in a good way",
     "The handle is wide enough for two fingers and the glaze is matte without being chalky. I ordered two more.",
     18, 9, None, True),
    ("review-fieldstone-02", "prod-fieldstone-mug", "leo-santoro", 5, "Holds heat properly",
     "Coffee is still warm twenty minutes later. The base is unglazed so it grips the table.",
     14, 20, None, True),
    ("review-fieldstone-03", "prod-fieldstone-plate", "greta-lindholm", 4, "Lovely, slightly uneven",
     "Two of the four sit very slightly proud. Told it is normal for thrown pieces and I believe them, but worth saying.",
     10, 18, None, True),
    ("review-fieldstone-04", "prod-fieldstone-jug", "quinn-abara", 5, "The pour is clean",
     "No dribble down the side, which is the only thing I care about in a jug.",
     8, 12, None, False),
    ("review-linen-apron-01", "prod-linen-apron", "esme-fontaine", 5, "Third year, still going",
     "Washed weekly since 2025. The straps have softened and nothing has torn.",
     60, 11, None, True),
    ("review-linen-apron-02", "prod-linen-apron", "maren-oduya", 4, "Runs long",
     "I am five foot two and it reaches my shins. Still lovely, just size down if you can.",
     45, 15, None, True),
    ("review-linen-napkins-01", "prod-linen-napkins", "tilda-nyberg", 5, "Better after washing",
     "Stiff out of the box, perfect after three washes. Exactly as the care post said.",
     38, 17, None, True),
    ("review-linen-napkins-02", "prod-linen-napkins", "dmitri-sokolov", 3, "Good but they wrinkle instantly",
     "That is linen and I knew that. Still, if you want a flat napkin this is not it.",
     29, 13, None, True),
    ("review-linen-runner-01", "prod-linen-runner", "orla-brennan", 5, "Right length for a long table",
     "Two metres covers our table with a proper drop at both ends.",
     52, 10, None, True),
    ("review-skillet-01", "prod-cast-skillet", "hugo-marchetti", 5, "Seasoning was real",
     "Eggs did not stick on the first use, which has never happened to me with a new pan.",
     70, 8, None, True),
    ("review-skillet-02", "prod-cast-skillet", "paavo-virtanen", 4, "Heavy",
     "It is cast iron so of course it is heavy, but the handle is short and that makes it worse. Cooks beautifully.",
     41, 19, None, True),
    ("review-skillet-03", "prod-cast-skillet", "vera-pahlsson", 5, "Replaced three non-stick pans",
     "Bought in October, used most days since. No complaints at all.",
     33, 16, None, False),
    ("review-oak-board-01", "prod-oak-board", "bennett-cho", 5, "Grain is gorgeous",
     "No two look the same. Mine has a knot near the handle and I like it more for that.",
     48, 14, None, True),
    ("review-oak-board-02", "prod-oak-board", "jonas-wirth", 4, "Needs oiling more than they say",
     "Every six weeks in a dry house, not every three months. Easy enough.",
     24, 9, None, True),
    ("review-beeswax-01", "prod-beeswax-wrap", "kaia-nakamura", 4, "Works for cheese, not for onions",
     "The smell of onion never quite leaves. For bread and cheese they are excellent.",
     31, 20, None, True),
    ("review-beeswax-02", "prod-beeswax-wrap", "rania-haddad", 5, "Sticky in the right way",
     "Warm them in your hands and they seal properly. Six months in and still tacky.",
     19, 11, None, True),
    ("review-sea-salt-01", "prod-sea-salt", "soren-mikkelsen", 5, "The tin is the point",
     "Salt is salt, but a tin you can open with one hand next to the stove is worth the money.",
     26, 18, None, True),
    ("review-sea-salt-02", "prod-sea-salt", "umberto-rossi", 4, "Flakes are smaller than pictured",
     "Still good, just do not expect the big pyramids in the photograph.",
     15, 12, None, True),
    ("review-olive-oil-01", "prod-olive-oil", "wes-agyeman", 5, "Peppery, in a good way",
     "You can taste that it is this year's. The tin keeps it dark, which matters.",
     22, 10, None, True),
    ("review-olive-oil-02", "prod-olive-oil", "zoya-petrosyan", 3, "Lovely oil, slow delivery",
     "Three weeks from order to door. The oil is excellent and I would buy it again, but say so on the page.",
     13, 21, None, True),
    ("review-candle-01", "prod-candle-pair", "alma-reyes", 5, "Wish I had bought four",
     "Sold out before I could reorder. Burned evenly for about nine hours each.",
     55, 19, None, True),
    ("review-candle-02", "prod-candle-pair", "greta-lindholm", 4, "Scent is faint",
     "Pleasant but subtle. If you want a room-filling candle this is not that.",
     37, 16, None, True),
]


def review_records() -> list[dict]:
    reviews = []
    for review_id, product_id, author_id, rating, title, body, days_before, hour, order_id, verified in REVIEW_SOURCE:
        review = {
            "id": review_id,
            "product_id": product_id,
            "author_id": author_id,
            "rating": rating,
            "title": title,
            "body": body,
            "posted_at": stamp(days_before, hour),
            "status": "published",
            "verified_buyer": verified,
        }
        if order_id is not None:
            review["order_id"] = order_id
        reviews.append(review)
    return sorted(reviews, key=lambda review: review["id"])


# (id, parent, author, days_before, hour, body)
COMMENT_SOURCE = [
    ("comment-harbour-01", "review-harbour-01", "sana-devi", 33, 10,
     "This is a glaze fault in the first Harbour run and it is ours. A replacement is on its way and you do not need to return anything."),
    ("comment-harbour-02", "review-harbour-02", "sana-devi", 20, 9,
     "Hand washing does slow it down, but it should not be the price of keeping a mug. All four are being replaced."),
    ("comment-harbour-03", "review-harbour-03", "sana-devi", 15, 14,
     "Replacement sent this morning. We are writing to everyone who bought from that run rather than waiting to be asked."),
    ("comment-harbour-04", "review-harbour-04", "yuki-tanabe", 11, 11,
     "You are right that it is the dishwasher. The published note explains the fit problem behind it."),
    ("comment-post-crazing-01", "post-harbour-crazing", "clara-voight", 2, 13,
     "Thank you for saying which run it was. I assumed I had done something wrong."),
    ("comment-post-crazing-02", "post-harbour-crazing", "franklin-obi", 2, 15,
     "Replacement arrived before I read this. Well handled."),
    ("comment-post-crazing-03", "post-harbour-crazing", "vera-pahlsson", 1, 8,
     "Does this affect the Fieldstone mugs? Different glaze or the same one?"),
    ("comment-post-crazing-04", "post-harbour-crazing", "iris-mendel", 1, 9,
     "Different glaze and a different clay body. Fieldstone went through thirty dishwasher cycles before we listed it."),
    ("comment-post-fieldstone-01", "post-fieldstone-preview", "alma-reyes", 5, 20,
     "Preordered the bowl. Any sense of how long the wait is?"),
    ("comment-post-fieldstone-02", "post-fieldstone-preview", "mira-halvorsen", 5, 21,
     "The second kiln run is on 27 March. If it passes inspection, preorders ship the following week. We will not give a date before that."),
    ("comment-post-fieldstone-03", "post-fieldstone-preview", "soren-mikkelsen", 4, 12,
     "Two bowls and four plates ordered. The plate photograph sold it."),
    ("comment-post-kiln-01", "post-kiln-visit", "greta-lindholm", 8, 18,
     "The crawl mark photograph is more convincing than any product shot."),
    ("comment-post-kiln-02", "post-kiln-visit", "lena-fischer", 8, 19,
     "Harriet let us stay for the unloading, which is the part nobody photographs."),
    ("comment-post-pantry-01", "post-pantry-march", "tilda-nyberg", 13, 8,
     "Box arrived on the 6th. The olive oil is the best one you have sent."),
    ("comment-post-pantry-02", "post-pantry-march", "hugo-marchetti", 12, 17,
     "Mine has not arrived and I am billed on the 1st. Should I be worried?"),
    ("comment-post-pantry-03", "post-pantry-march", "otto-lindqvist", 12, 18,
     "Yours went out on the 11th with the second wave. That was our error in the split, not the warehouse's."),
    ("comment-post-billing-01", "post-club-billing", "bennett-cho", 1, 18,
     "I had not noticed. Credit received, thank you for finding it first."),
    ("comment-post-billing-02", "post-club-billing", "maren-oduya", 0, 8,
     "Still showing two charges on my statement. Is the credit separate?"),
    ("comment-post-billing-03", "post-club-billing", "rosa-delgado", 0, 9,
     "Separate, and issued on the 18th. It appears as a credit note against the March invoice rather than a reversal."),
    ("comment-post-shipping-01", "post-shipping-honestly", "quinn-abara", 19, 14,
     "Mine has not moved in five days. Is that the pallet problem?"),
    ("comment-post-shipping-02", "post-shipping-honestly", "callum-reid", 19, 15,
     "It is. Eleven orders were scanned onto a pallet without their labels being read. We are tracing each one individually."),
    ("comment-post-reviews-01", "post-verified-reviews", "jonas-wirth", 10, 16,
     "My review is unbadged and I definitely bought it. Guest checkout, so that explains it."),
]


def comment_records() -> list[dict]:
    return sorted(
        (
            {
                "id": comment_id,
                "parent_id": parent_id,
                "parent_kind": "post" if parent_id.startswith("post-") else "review",
                "author_id": author_id,
                "posted_at": stamp(days_before, hour),
                "body": body,
            }
            for comment_id, parent_id, author_id, days_before, hour, body in COMMENT_SOURCE
        ),
        key=lambda comment: comment["id"],
    )


# ---------------------------------------------------------------------------
# Finance: the Pantry Club subscription
# ---------------------------------------------------------------------------

# (shopper, plan, monthly cents, invoice day, due day)
CLUB_MEMBERS = [
    ("alma-reyes", "standard", 3900, 1, 10),
    ("bennett-cho", "large", 6400, 1, 10),
    ("clara-voight", "standard", 3900, 5, 15),
    ("esme-fontaine", "standard", 3900, 5, 15),
    ("franklin-obi", "large", 6400, 8, 18),
    ("greta-lindholm", "standard", 3900, 8, 18),
    ("hugo-marchetti", "large", 6400, 1, 10),
    ("imogen-bell", "standard", 3900, 12, 22),
    ("jonas-wirth", "standard", 3900, 12, 22),
    ("kaia-nakamura", "large", 6400, 15, 25),
    ("leo-santoro", "standard", 3900, 15, 25),
    ("maren-oduya", "large", 6400, 1, 10),
    ("orla-brennan", "standard", 3900, 20, 28),
    ("quinn-abara", "standard", 3900, 20, 28),
    ("rania-haddad", "large", 6400, 5, 15),
    ("soren-mikkelsen", "standard", 3900, 25, 5),
    ("tilda-nyberg", "large", 6400, 25, 5),
    ("vera-pahlsson", "standard", 3900, 12, 22),
]

PLAN_NAMES = {
    "standard": "Pantry Club standard box",
    "large": "Pantry Club large box",
}

ORGANIZATION_BY_PERSON = {person["id"]: person["organization_id"] for person in PEOPLE}


def customer_records() -> list[dict]:
    customers = []
    for index, (shopper_id, plan, cents, invoice_day, due_day) in enumerate(CLUB_MEMBERS, start=1):
        customers.append(
            {
                "id": f"club-{shopper_id}",
                "name": NAME_BY_ID[shopper_id],
                "contact_id": shopper_id,
                "organization_id": ORGANIZATION_BY_PERSON[shopper_id],
                "service": PLAN_NAMES[plan],
                "monthly_amount_cents": cents,
                "invoice_day": invoice_day,
                "due_day": due_day,
                "number_suffix": f"{index:02d}",
            }
        )
    return customers


CUSTOMERS = customer_records()

SUPPLIERS = [
    {
        "id": "supplier-harrow-works",
        "name": "Harrow Works",
        "contact_id": "harriet-vance",
        "organization_id": "harrow-works",
        "service": "Stoneware production run",
        "monthly_amount_cents": 185000,
        "bill_day": 8,
    },
    {
        "id": "supplier-swiftline",
        "name": "Swiftline Logistics",
        "contact_id": "desmond-oyelaran",
        "organization_id": "swiftline-logistics",
        "service": "Pick, pack and storage",
        "monthly_amount_cents": 96000,
        "bill_day": 12,
    },
    {
        "id": "supplier-bramble",
        "name": "Bramble Studio",
        "contact_id": "juno-park",
        "organization_id": "bramble-studio",
        "service": "Creative retainer",
        "monthly_amount_cents": 42000,
        "bill_day": 20,
    },
]

# The four invoices the world is actually talking about. Every open one is due
# after the anchor, which is what keeps a rebased world honest about them.
ANCHOR_INVOICES = [
    {
        "id": "inv-2031",
        "number": "2031",
        "customer_id": "club-orla-brennan",
        "issued_on": day(-6),
        "due_on": day(10),
        "amount_cents": 3900,
        "currency": "USD",
        "status": "open",
        "description": "Pantry Club standard box — March",
    },
    {
        "id": "inv-2032",
        "number": "2032",
        "customer_id": "club-hugo-marchetti",
        "issued_on": day(-46),
        "due_on": day(-8),
        "amount_cents": 6400,
        "currency": "USD",
        "status": "overdue",
        "description": "Pantry Club large box — February. Card expired; retry declined twice.",
    },
    {
        "id": "inv-2033",
        "number": "2033",
        "customer_id": "club-maren-oduya",
        "issued_on": day(-17),
        "due_on": day(4),
        "amount_cents": 6400,
        "currency": "USD",
        "status": "open",
        "description": "Pantry Club large box — March. Charged twice; credit note pending.",
    },
    {
        "id": "inv-2034",
        "number": "2034",
        "customer_id": "club-bennett-cho",
        "issued_on": day(-17),
        "due_on": day(4),
        "amount_cents": 6400,
        "currency": "USD",
        "status": "open",
        "description": "Pantry Club large box — March. Charged twice; credit note issued 18 March.",
    },
]


# ---------------------------------------------------------------------------
# Software
# ---------------------------------------------------------------------------



# ---------------------------------------------------------------------------
# Support
# ---------------------------------------------------------------------------

CASES = [
    {
        "id": "case-crazing-batch",
        "title": "Harbour mug glaze crazing in the first run",
        "customer_id": "club-clara-voight",
        "contact_id": "clara-voight",
        "owner_id": "sana-devi",
        "opened_at": stamp(33, 9, 40),
        "priority": "high",
        "state": "replacing",
        "next_action": "Send the last eleven replacements and close each review reply.",
        "order_id": "order-10101",
    },
    {
        "id": "case-missing-tracking",
        "title": "Eleven orders shipped with no carrier movement",
        "customer_id": "club-quinn-abara",
        "contact_id": "quinn-abara",
        "owner_id": "otto-lindqvist",
        "opened_at": stamp(5, 11, 15),
        "priority": "high",
        "state": "engineering",
        "next_action": "Get the pallet trace from Swiftline, then write to all eleven with a real answer.",
        "order_id": "order-10023",
    },
    {
        "id": "case-double-charge",
        "title": "Two Pantry Club members charged twice in March",
        "customer_id": "club-maren-oduya",
        "contact_id": "maren-oduya",
        "owner_id": "rosa-delgado",
        "opened_at": stamp(2, 16, 5),
        "priority": "high",
        "state": "finance",
        "next_action": "Issue the second credit note and reply on the public thread.",
    },
    {
        "id": "case-late-box",
        "title": "March pantry box arrived a week late for the 1st-of-month members",
        "customer_id": "club-hugo-marchetti",
        "contact_id": "hugo-marchetti",
        "owner_id": "otto-lindqvist",
        "opened_at": stamp(12, 10, 30),
        "priority": "normal",
        "state": "resolved",
        "next_action": "None. The split error is fixed for April.",
    },
    {
        "id": "case-preorder-question",
        "title": "When does the Fieldstone bowl preorder ship",
        "customer_id": "club-alma-reyes",
        "contact_id": "alma-reyes",
        "owner_id": "sana-devi",
        "opened_at": stamp(3, 14, 20),
        "priority": "normal",
        "state": "waiting-on-us",
        "next_action": "Answer after the 27 March kiln inspection. Do not give a date before it.",
        "order_id": "order-10201",
    },
    {
        "id": "case-expired-card",
        "title": "February renewal declined twice on an expired card",
        "customer_id": "club-hugo-marchetti",
        "contact_id": "hugo-marchetti",
        "owner_id": "rosa-delgado",
        "opened_at": stamp(8, 9, 0),
        "priority": "normal",
        "state": "waiting-on-customer",
        "next_action": "Second reminder on 22 March, then pause the membership rather than retry again.",
    },
]


# ---------------------------------------------------------------------------
# Work
# ---------------------------------------------------------------------------

PROJECTS = [
    {
        "id": "project-fieldstone-drop",
        "name": "Fieldstone drop",
        "summary": "Launch four Fieldstone pieces on 25 March with the serving bowl on preorder.",
        "owner_id": "mira-halvorsen",
        "member_ids": ["mira-halvorsen", "bea-morrow", "kit-nwosu", "gus-ferreira", "lena-fischer"],
        "status": "in-progress",
        "start_on": day(-40),
        "target_on": day(7),
    },
    {
        "id": "project-harbour-response",
        "name": "Harbour mug replacement",
        "summary": "Replace every mug from the first Harbour run and say publicly why.",
        "owner_id": "sana-devi",
        "member_ids": ["sana-devi", "otto-lindqvist", "iris-mendel", "bea-morrow"],
        "status": "in-progress",
        "start_on": day(-35),
        "target_on": day(4),
        "customer_id": "club-clara-voight",
    },
    {
        "id": "project-club-billing-fix",
        "name": "Pantry Club billing correction",
        "summary": "Fix the renewal retry, issue both credit notes, and link credits to invoices.",
        "owner_id": "rosa-delgado",
        "member_ids": ["rosa-delgado", "tomas-brekke"],
        "status": "in-progress",
        "start_on": day(-3),
        "target_on": day(11),
    },
    {
        "id": "project-fulfilment-recovery",
        "name": "Pallet trace and tracking guard",
        "summary": "Find the eleven parcels, then stop the order service from believing an empty scan.",
        "owner_id": "callum-reid",
        "member_ids": ["callum-reid", "otto-lindqvist", "gus-ferreira"],
        "status": "in-progress",
        "start_on": day(-5),
        "target_on": day(5),
    },
]

# (id, project, title, description, assignee, reporter, status, priority, due offset, labels)
TASK_SOURCE = [
    ("task-preorder-badge", "project-fieldstone-drop", "Fix the preorder badge on collection tiles",
     "Invalidate the availability cache when a product status changes. Ship before the 25th.",
     "gus-ferreira", "mira-halvorsen", "in-progress", "urgent", 3, ["storefront", "fieldstone"]),
    ("task-bowl-count", "project-fieldstone-drop", "Confirm the sellable bowl count",
     "Harrow Works rejected nineteen of the first hundred and twelve. Get the number we can actually promise.",
     "kit-nwosu", "mira-halvorsen", "in-progress", "high", 1, ["inventory"]),
    ("task-drop-email", "project-fieldstone-drop", "Write the drop announcement",
     "Lead with the four pieces. Say the bowl is a preorder and why, in the first paragraph.",
     "bea-morrow", "mira-halvorsen", "review", "high", 4, ["marketing"]),
    ("task-jug-reshoot", "project-fieldstone-drop", "Reshoot the jug on a light ground",
     "The current photograph makes the glaze read grey. It is closer to oatmeal.",
     "lena-fischer", "bea-morrow", "done", "normal", -2, ["studio"]),
    ("task-backorder-hold", "project-fieldstone-drop", "Hold preorder stock against the second kiln run",
     "Issue 218. A walk-up order must not take a bowl a preorder has paid for.",
     "gus-ferreira", "kit-nwosu", "ready", "high", 6, ["orders"]),
    ("task-replacement-list", "project-harbour-response", "Finish the replacement list",
     "Six orders from the affected run are still unsent. No returns required, no receipts required.",
     "otto-lindqvist", "sana-devi", "in-progress", "high", 2, ["support"]),
    ("task-crazing-note", "project-harbour-response", "Publish the crazing note",
     "Say what the fault is, that it is not a safety problem, and that it is ours.",
     "iris-mendel", "bea-morrow", "done", "high", -2, ["marketing", "quality"]),
    ("task-review-replies", "project-harbour-response", "Reply to every two-star Harbour review",
     "Reply on the review itself, not by mail. The replies are part of the public record.",
     "sana-devi", "yuki-tanabe", "in-progress", "normal", 3, ["support", "reviews"]),
    ("task-idempotency-key", "project-club-billing-fix", "Set the idempotency key on the renewal charge",
     "Issue 215. The key is already in the provider call signature and is not being passed.",
     "tomas-brekke", "rosa-delgado", "in-progress", "urgent", 2, ["billing"]),
    ("task-credit-notes", "project-club-billing-fix", "Issue both March credit notes",
     "One is out. The second is waiting on the reconciliation line for the duplicate charge.",
     "rosa-delgado", "rosa-delgado", "in-progress", "high", 1, ["finance"]),
    ("task-credit-links", "project-club-billing-fix", "Link a credit note to the invoice it corrects",
     "Issue 216. A credit with no reference reads like an unrelated refund.",
     "tomas-brekke", "rosa-delgado", "backlog", "normal", 14, ["billing"]),
    ("task-billing-post", "project-club-billing-fix", "Say publicly that two members were charged twice",
     "Before anyone asks. Name the number affected and what happens next.",
     "rosa-delgado", "iris-mendel", "done", "high", -1, ["marketing"]),
    ("task-pallet-trace", "project-fulfilment-recovery", "Get the pallet trace from Swiftline",
     "Eleven orders, one pallet, 12 March. Desmond has the yard log.",
     "callum-reid", "callum-reid", "in-progress", "urgent", 0, ["fulfilment"]),
    ("task-tracking-guard", "project-fulfilment-recovery", "Reject a shipment scan with no tracking number",
     "Issue 213. The service must not tell someone their parcel has shipped on an empty scan.",
     "gus-ferreira", "callum-reid", "ready", "high", 5, ["orders"]),
    ("task-eleven-emails", "project-fulfilment-recovery", "Write to all eleven affected orders",
     "One message each, with the real position. Not a status page link.",
     "otto-lindqvist", "callum-reid", "blocked", "high", 2, ["support"]),
    ("task-review-sort", "project-fieldstone-drop", "Add a most-helpful sort to product reviews",
     "Issue 212. Not a launch blocker; queued behind the badge work.",
     "anya-kowalski", "yuki-tanabe", "backlog", "normal", 21, ["reviews"]),
]

# (id, task, person, days before anchor, minutes, note)


def task_records() -> list[dict]:
    return [
        {
            "id": task_id,
            "project_id": project_id,
            "title": title,
            "description": description,
            "assignee_id": assignee,
            "reporter_id": reporter,
            "status": status,
            "priority": priority,
            "due_on": day(due_offset),
            "labels": labels,
        }
        for task_id, project_id, title, description, assignee, reporter, status, priority, due_offset, labels in TASK_SOURCE
    ]




# ---------------------------------------------------------------------------
# Communication
# ---------------------------------------------------------------------------

STAFF_IDS = [person_id for person_id, *_rest in STAFF]

CHANNEL_SOURCE = [
    (
        "channel-general",
        "general",
        "Company updates and questions for everyone",
        STAFF_IDS,
        [
            ("chat-general-01", "iris-mendel", 3, 9, 15,
             "The Harbour note goes out tomorrow morning. It says the fault is ours and that nobody has to return anything. If you disagree with either half, say so today.",
             {"document_id": "doc-crazing-response"}),
            ("chat-general-02", "callum-reid", 2, 8, 40,
             "Eleven orders are sitting on a Swiftline pallet with no carrier scan. I am not sending a holding message until I know where the parcels are.",
             {}),
            ("chat-general-03", "rosa-delgado", 1, 17, 20,
             "March reconciliation found two duplicate Pantry Club charges. Both members have been contacted, one credit is issued, the second follows this week.",
             {"project_id": "project-club-billing-fix"}),
            ("chat-general-04", "mira-halvorsen", 0, 9, 5,
             "Fieldstone go or no-go is at 11:00 tomorrow. The question is the bowl, not the collection.",
             {}),
        ],
    ),
    (
        "channel-fieldstone",
        "fieldstone-drop",
        "The 25 March collection launch",
        ["mira-halvorsen", "bea-morrow", "kit-nwosu", "gus-ferreira", "lena-fischer", "iris-mendel", "yuki-tanabe"],
        [
            ("chat-fieldstone-01", "kit-nwosu", 6, 10, 30,
             "Second kiln run: 112 bowls fired, 19 rejected for crawl marks. That is 93 sellable against 140 preorder units if we open it as stock.",
             {"project_id": "project-fieldstone-drop"}),
            ("chat-fieldstone-02", "mira-halvorsen", 6, 10, 45,
             "Then it is a preorder. I would rather take the money late than take it for a bowl that does not exist.",
             {}),
            ("chat-fieldstone-03", "gus-ferreira", 5, 14, 12,
             "Preorder badge is wrong on the collection grid — issue 210. The product page is correct. Cache, not logic.",
             {}),
            ("chat-fieldstone-04", "bea-morrow", 4, 11, 0,
             "Draft one of the announcement is up. The preorder explanation is in the first paragraph, not the footer.",
             {"document_id": "doc-fieldstone-launch"}),
            ("chat-fieldstone-05", "lena-fischer", 3, 16, 30,
             "Jug reshot on the light ground. The old shot read grey; this one reads oatmeal, which is what it is.",
             {}),
            ("chat-fieldstone-06", "kit-nwosu", 1, 9, 50,
             "Harriet has the third run booked for 27 March. She will not promise a yield and I am not going to ask her to.",
             {}),
            ("chat-fieldstone-07", "iris-mendel", 0, 8, 55,
             "Decision tomorrow: launch four pieces with the bowl on preorder. Nobody is proposing we hold the collection.",
             {"project_id": "project-fieldstone-drop"}),
        ],
    ),
    (
        "channel-customer-care",
        "customer-care",
        "Support threads that need more than one person",
        ["sana-devi", "otto-lindqvist", "iris-mendel", "yuki-tanabe", "rosa-delgado", "callum-reid"],
        [
            ("chat-care-01", "sana-devi", 12, 9, 20,
             "Three two-star Harbour reviews now, all describing the same crazing. I am replying on the reviews rather than by mail so the answer is public.",
             {"project_id": "project-harbour-response"}),
            ("chat-care-02", "otto-lindqvist", 11, 15, 40,
             "Replacement list is at 34 of 40. Six orders have addresses older than a year and I am mailing those to confirm before sending.",
             {}),
            ("chat-care-03", "yuki-tanabe", 10, 12, 5,
             "Jonas asked why his review is unbadged. He bought as a guest. That is issue 211, not a mistake on his part.",
             {}),
            ("chat-care-04", "otto-lindqvist", 4, 10, 10,
             "Quinn asked about the pallet on the shipping post. I said eleven orders and that we are tracing each one. No date, because we do not have one.",
             {}),
            ("chat-care-05", "sana-devi", 2, 13, 45,
             "Alma wants a ship date for the bowl preorder. Answer after the 27th, not before.",
             {}),
            ("chat-care-06", "rosa-delgado", 0, 8, 30,
             "Maren says her statement still shows two charges. The credit is a separate line, issued today. I have replied on the public thread as well.",
             {}),
        ],
    ),
    (
        "channel-fulfilment",
        "fulfilment",
        "Swiftline, inventory and everything in a box",
        ["callum-reid", "kit-nwosu", "otto-lindqvist", "gus-ferreira", "iris-mendel"],
        [
            ("chat-fulfilment-01", "callum-reid", 5, 11, 20,
             "Swiftline sent eleven shipment scans on the 12th with an empty tracking field. The order service took them and told eleven people their parcel had shipped.",
             {"project_id": "project-fulfilment-recovery"}),
            ("chat-fulfilment-02", "gus-ferreira", 5, 11, 35,
             "A scan with no tracking number should be rejected outright. Issue 213. I can ship the guard this week; it does not find the parcels.",
             {}),
            ("chat-fulfilment-03", "callum-reid", 1, 16, 50,
             "Desmond pulled the yard log. Eight of eleven are located and were never collected. Three are still unaccounted for.",
             {}),
            ("chat-fulfilment-04", "otto-lindqvist", 0, 9, 10,
             "I have the eleven names. I am not sending anything until Callum can tell each of them something true.",
             {}),
        ],
    ),
    (
        "channel-storefront",
        "storefront",
        "The shop, the product pages and the reviews",
        ["gus-ferreira", "anya-kowalski", "mira-halvorsen", "yuki-tanabe", "tomas-brekke"],
        [
            ("chat-storefront-01", "anya-kowalski", 9, 13, 0,
             "Verified-buyer badges are live. Matching is on account id, so guest orders never match — issue 211.",
             {}),
            ("chat-storefront-02", "mira-halvorsen", 9, 13, 20,
             "Ship it unbadged rather than badge everyone. An unbadged real buyer is a smaller lie than a badged stranger.",
             {}),
            ("chat-storefront-03", "anya-kowalski", 7, 10, 45,
             "Email matching needs a decision on case folding and plus-addressing before I touch it.",
             {}),
            ("chat-storefront-04", "gus-ferreira", 2, 15, 30,
             "1.4 MB of unused CSS on every product page — issue 217. After the drop.",
             {}),
        ],
    ),
    (
        "channel-pantry-club",
        "pantry-club",
        "The subscription box: boxes, renewals and members",
        ["felix-arana", "rosa-delgado", "kit-nwosu", "otto-lindqvist", "iris-mendel", "tomas-brekke"],
        [
            ("chat-club-01", "felix-arana", 14, 9, 30,
             "March boxes are out. Members billed on the 1st shipped on the 4th; everyone else on the 11th. The split was mine and it was wrong.",
             {}),
            ("chat-club-02", "rosa-delgado", 2, 16, 15,
             "Two duplicate charges in the March run. Both from a retry after a timeout. Tomas has the reproduction.",
             {"project_id": "project-club-billing-fix"}),
            ("chat-club-03", "tomas-brekke", 2, 16, 40,
             "The idempotency key is in the call signature and we never set it. Issue 215. One line, plus a test that kills the connection mid-charge.",
             {}),
            ("chat-club-04", "felix-arana", 1, 10, 20,
             "Holding the April teaser send until the credits are out. A promotional email on top of a double charge is not a good look.",
             {}),
            ("chat-club-05", "rosa-delgado", 0, 9, 45,
             "Hugo's February renewal declined twice on an expired card. Second reminder on the 22nd, then pause rather than retry a third time.",
             {}),
        ],
    ),
]


def channel_records() -> list[dict]:
    channels = []
    for channel_id, name, topic, members, messages in CHANNEL_SOURCE:
        channels.append(
            {
                "id": channel_id,
                "name": name,
                "topic": topic,
                "member_ids": members,
                "messages": [
                    {
                        "id": message_id,
                        "author_id": author_id,
                        "text": text,
                        "timestamp": stamp(days_before, hour, minute),
                        "entity_refs": refs,
                    }
                    for message_id, author_id, days_before, hour, minute, text, refs in messages
                ],
            }
        )
    return channels


DOCUMENTS = [
    {
        "id": "doc-fieldstone-launch",
        "name": "Fieldstone launch plan.md",
        "owner_id": "mira-halvorsen",
        "mime_type": "text/markdown",
        "modified_at": stamp(1, 18, 10),
        "content": (
            "# Fieldstone, 25 March\n\n"
            "Four pieces: mug, plate, jug, serving bowl.\n\n"
            "## The bowl\n\n"
            "Second kiln run produced 93 sellable bowls against 140 units of demand at the last two\n"
            "drops. It opens as a preorder. The announcement says so in the first paragraph.\n\n"
            "## Open before launch\n\n"
            "- Issue 210: preorder badge is wrong on the collection grid.\n"
            "- Issue 218: preorder stock is not held against the third kiln run.\n\n"
            "## Do not\n\n"
            "Do not give a preorder ship date before the 27 March inspection."
        ),
    },
    {
        "id": "doc-crazing-response",
        "name": "Harbour mug crazing — response plan.md",
        "owner_id": "sana-devi",
        "mime_type": "text/markdown",
        "modified_at": stamp(3, 16, 40),
        "content": (
            "# Harbour mug, first run\n\n"
            "About forty mugs from the first Harbour run craze after repeated dishwasher cycles. The\n"
            "glaze and the clay body move at different rates. It is a fit fault, not a safety fault.\n\n"
            "## What we do\n\n"
            "Replace every mug from that run. No return, no receipt, no proof of the fault.\n\n"
            "## What we say\n\n"
            "That it is ours, which run it was, and that Fieldstone uses a different glaze and a\n"
            "different body and went through thirty dishwasher cycles before listing.\n\n"
            "## Status\n\n"
            "34 of 40 replacements sent. Six addresses need confirming first."
        ),
    },
    {
        "id": "doc-club-billing",
        "name": "Pantry Club duplicate charge — what we know.md",
        "owner_id": "rosa-delgado",
        "mime_type": "text/markdown",
        "modified_at": stamp(1, 17, 55),
        "content": (
            "# March duplicate charges\n\n"
            "Two members were charged twice: club-bennett-cho and club-maren-oduya.\n\n"
            "## Cause\n\n"
            "The charge succeeded at the provider and the response timed out locally. The retry sent a\n"
            "second charge with no idempotency key. Issue 215.\n\n"
            "## Position\n\n"
            "Found in reconciliation, not reported by a member. Both were told before the public post.\n"
            "One credit note is issued; the second follows this week. Issue 216 means a credit note does\n"
            "not yet reference the invoice it corrects, so say the invoice number in the message."
        ),
    },
    {
        "id": "doc-review-badges",
        "name": "Runbook: verified-buyer badges.md",
        "owner_id": "anya-kowalski",
        "mime_type": "text/markdown",
        "modified_at": stamp(9, 14, 25),
        "content": (
            "# Runbook: verified-buyer badges\n\n"
            "A review is badged when its author's account id matches an order for the same product.\n\n"
            "## Known gap\n\n"
            "Guest checkout writes no account id, so a guest buyer is never badged. Issue 211.\n\n"
            "## Do not\n\n"
            "Do not badge on self-declared purchase. An unbadged real buyer is a smaller problem than\n"
            "a badged stranger.\n\n"
            "## Backfill\n\n"
            "Rerun the matcher after any change; it is idempotent and takes about forty seconds."
        ),
    },
]

CALENDARS = [
    {"id": "calendar-primary", "name": "Iris Mendel", "primary": True},
    {"id": "calendar-company", "name": "Marlow & Pine", "primary": False},
    {"id": "calendar-care", "name": "Customer care", "primary": False},
]


def staff_email(person_id: str) -> str:
    return next(person["email"] for person in PEOPLE if person["id"] == person_id)


CALENDAR_EVENTS = [
    {
        "id": "event-fieldstone-go-no-go",
        "calendar_id": "calendar-company",
        "summary": "Fieldstone go or no-go",
        "description": "Decide whether the serving bowl opens as a preorder or holds the collection.",
        "start": iso((ANCHOR + timedelta(days=1)).replace(hour=11, minute=0)),
        "end": iso((ANCHOR + timedelta(days=1)).replace(hour=11, minute=45)),
        "attendees": [staff_email(person) for person in ("iris-mendel", "mira-halvorsen", "kit-nwosu", "bea-morrow")],
    },
    {
        "id": "event-club-billing-review",
        "calendar_id": "calendar-company",
        "summary": "Pantry Club billing review",
        "description": "Credit notes, the retry fix, and what April's run needs before it opens.",
        "start": iso((ANCHOR + timedelta(days=2)).replace(hour=15, minute=0)),
        "end": iso((ANCHOR + timedelta(days=2)).replace(hour=15, minute=30)),
        "attendees": [staff_email(person) for person in ("rosa-delgado", "tomas-brekke", "felix-arana")],
    },
    {
        "id": "event-swiftline-weekly",
        "calendar_id": "calendar-company",
        "summary": "Swiftline weekly",
        "description": "Pallet trace, the eleven orders, and the empty-scan guard.",
        "start": iso((ANCHOR + timedelta(days=5)).replace(hour=14, minute=0)),
        "end": iso((ANCHOR + timedelta(days=5)).replace(hour=14, minute=30)),
        "attendees": [staff_email(person) for person in ("callum-reid", "otto-lindqvist")]
        + ["desmond@swiftline.worldfixture.test"],
    },
    {
        "id": "event-studio-shoot",
        "calendar_id": "calendar-primary",
        "summary": "Fieldstone shoot, day two",
        "description": "Jug reshoot on the light ground and the bowl detail frames.",
        "start": iso((ANCHOR - timedelta(days=3)).replace(hour=10, minute=0)),
        "end": iso((ANCHOR - timedelta(days=3)).replace(hour=16, minute=0)),
        "attendees": [staff_email(person) for person in ("lena-fischer", "bea-morrow", "iris-mendel")],
    },
]


# (id, thread, from, to, subject, snippet, body, days_before, hour, labels, refs)
MAIL_SOURCE = [
    ("mail-clara-crazing", "thread-harbour-clara", "clara-voight", ["sana-devi"],
     "My Harbour mugs have cracked all over",
     "Fine cracks through the whole glaze after about a month of dishwasher use.",
     "Hello,\n\nI bought two Harbour mugs in September and both have fine cracks all through the glaze. "
     "They only ever went in the dishwasher, nothing else. I am not asking for money back, I would just "
     "like to know whether they are still safe to drink from.\n\nClara",
     34, 9, ["INBOX", "UNREAD", "Support"], {"order_id": "order-10101"}),
    ("mail-sana-crazing-reply", "thread-harbour-clara", "sana-devi", ["clara-voight"],
     "Re: My Harbour mugs have cracked all over",
     "It is a glaze fit fault in the first run. Replacements are on the way and you keep the originals.",
     "Hello Clara,\n\nThey are safe to drink from. What you are seeing is crazing: the glaze and the clay "
     "body shrink at slightly different rates, and repeated dishwasher cycles open fine cracks in the "
     "glaze. It is a fault in our first Harbour run and it is ours.\n\nTwo replacements are going out "
     "today. Please keep the originals; there is nothing to return and no receipt needed.\n\nSana",
     33, 11, ["SENT", "Support"], {"order_id": "order-10101"}),
    ("mail-franklin-crazing", "thread-harbour-franklin", "franklin-obi", ["sana-devi"],
     "Three of four mugs crazed",
     "Three of the four have crazed. The one I hand wash has not.",
     "Hi,\n\nFour mugs from October. Three have crazed, the fourth is fine and it is the one I have never "
     "put in the dishwasher. I have left a review saying so.\n\nFranklin",
     21, 8, ["INBOX", "UNREAD", "Support"], {"order_id": "order-10102"}),
    ("mail-quinn-tracking", "thread-tracking-quinn", "quinn-abara", ["otto-lindqvist"],
     "Tracking has not moved in five days",
     "The page says shipped on 12 March and there has been no scan since.",
     "Hello,\n\nMy order says it shipped on 12 March and the tracking page has not changed since. I am not "
     "in a hurry but I would like to know whether it is actually moving.\n\nQuinn",
     5, 10, ["INBOX", "UNREAD", "Support"], {"order_id": "order-10023"}),
    ("mail-otto-tracking-reply", "thread-tracking-quinn", "otto-lindqvist", ["quinn-abara"],
     "Re: Tracking has not moved in five days",
     "Your parcel is one of eleven on a pallet that was scanned but not collected. We are tracing it.",
     "Hello Quinn,\n\nIt is not moving, and I would rather tell you that than send you back to the tracking "
     "page. Your parcel is one of eleven that were scanned onto a pallet at our warehouse on 12 March "
     "without the carrier collecting them. We are working through the yard log now.\n\nI will write again "
     "when I can tell you where your parcel is, not before.\n\nOtto",
     4, 16, ["SENT", "Support"], {"order_id": "order-10023"}),
    ("mail-maren-double-charge", "thread-club-maren", "maren-oduya", ["rosa-delgado"],
     "Two charges for the March box",
     "My statement shows the Pantry Club charge twice on the same day.",
     "Hello,\n\nI have two Pantry Club charges on 1 March, same amount, same day. I saw your post so I "
     "assume this is the known problem, but the credit has not reached my statement yet.\n\nMaren",
     1, 12, ["INBOX", "UNREAD", "Finance"], {"invoice_id": "inv-2033"}),
    ("mail-rosa-credit-reply", "thread-club-maren", "rosa-delgado", ["maren-oduya"],
     "Re: Two charges for the March box",
     "Credit note issued today against invoice 2033. It appears as a separate line, not a reversal.",
     "Hello Maren,\n\nYes, this is the fault we published. The credit note is issued today against invoice "
     "2033 for 64.00 USD. It will appear as its own line rather than as a reversal of the original charge, "
     "which is confusing and is something we are fixing.\n\nWe found this in our own reconciliation rather "
     "than from a complaint, which is why you heard from us first.\n\nRosa",
     0, 9, ["SENT", "Finance"], {"invoice_id": "inv-2033"}),
    ("mail-bennett-credit", "thread-club-bennett", "rosa-delgado", ["bennett-cho"],
     "You were charged twice in March, and it is corrected",
     "A credit note for 64.00 USD is issued against invoice 2034.",
     "Hello Bennett,\n\nYour Pantry Club renewal charged twice on 1 March. A retry ran after the first "
     "charge had already succeeded. That is our bug and the credit note for 64.00 USD is issued today "
     "against invoice 2034.\n\nNothing is needed from you.\n\nRosa",
     2, 10, ["SENT", "Finance"], {"invoice_id": "inv-2034"}),
    ("mail-hugo-card", "thread-club-hugo", "rosa-delgado", ["hugo-marchetti"],
     "Your February Pantry Club renewal did not go through",
     "The card on file has expired. We will pause rather than keep retrying.",
     "Hello Hugo,\n\nThe February renewal was declined twice; the card on file expired in January. Invoice "
     "2032 for 64.00 USD is open.\n\nYou can update the card whenever suits. If we have not heard by 22 "
     "March we will pause the membership rather than retry a third time.\n\nRosa",
     8, 9, ["SENT", "Finance"], {"invoice_id": "inv-2032"}),
    ("mail-alma-preorder", "thread-preorder-alma", "alma-reyes", ["sana-devi"],
     "When does the Fieldstone bowl ship?",
     "Happy to wait, would just like a rough idea.",
     "Hello,\n\nI preordered the serving bowl and two mugs. I am happy to wait, I would just like a rough "
     "idea so I know whether it is weeks or months.\n\nAlma",
     3, 14, ["INBOX", "UNREAD", "Support"], {"order_id": "order-10201"}),
    ("mail-sana-preorder-reply", "thread-preorder-alma", "sana-devi", ["alma-reyes"],
     "Re: When does the Fieldstone bowl ship?",
     "The third kiln run is on 27 March. We will not give a date before it is inspected.",
     "Hello Alma,\n\nWeeks rather than months, but I am not going to give you a date yet. The third kiln "
     "run is on 27 March and we will not know the sellable count until it is inspected.\n\nI will write to "
     "you the day we know, whether the news is good or not. Your mugs can ship now if you would rather not "
     "wait for the bowl.\n\nSana",
     2, 15, ["SENT", "Support"], {"order_id": "order-10201"}),
    ("mail-harriet-kiln", "thread-harrow-run", "harriet-vance", ["kit-nwosu", "mira-halvorsen"],
     "Second Fieldstone run: 93 of 112",
     "Nineteen bowls rejected for crawl marks. Third run booked for 27 March.",
     "Kit, Mira,\n\nSecond run out of the kiln. 112 bowls fired, 19 rejected for crawl marks along the "
     "rim, 93 sellable. The glaze is thicker on the bowl than on the plate and that is where it is "
     "catching.\n\nThird run is booked for 27 March. I am not going to promise a yield.\n\nHarriet",
     6, 9, ["INBOX", "Suppliers"], {}),
    ("mail-kit-kiln-reply", "thread-harrow-run", "kit-nwosu", ["harriet-vance"],
     "Re: Second Fieldstone run: 93 of 112",
     "Understood. We are opening the bowl as a preorder rather than as stock.",
     "Harriet,\n\nThank you for the honest number. We are opening the bowl as a preorder rather than "
     "pretending we have stock. Please do not thin the glaze to raise the yield; the thickness is what the "
     "collection looks like.\n\nKit",
     6, 11, ["SENT", "Suppliers"], {}),
    ("mail-desmond-pallet", "thread-swiftline-pallet", "desmond-oyelaran", ["callum-reid"],
     "Pallet 4471: eight of eleven located",
     "Eight parcels were scanned and never collected. Three are unaccounted for.",
     "Callum,\n\nYard log for 12 March. Pallet 4471 was scanned as outbound but the carrier collection "
     "did not happen; the driver refused the load because the manifest did not match. Eight of the eleven "
     "parcels are still in bay 3. Three are not on the pallet and I do not yet know where they are.\n\nI "
     "am not going to guess. I will have the remaining three by Friday.\n\nDesmond",
     1, 16, ["INBOX", "UNREAD", "Suppliers"], {}),
    ("mail-callum-pallet-reply", "thread-swiftline-pallet", "callum-reid", ["desmond-oyelaran"],
     "Re: Pallet 4471: eight of eleven located",
     "Ship the eight today. Do not send a scan for the three until they exist.",
     "Desmond,\n\nShip the eight today with real tracking numbers. For the three, please do not send us a "
     "shipment scan until there is a parcel and a tracking number attached to it — an empty scan is what "
     "told eleven people their order had shipped.\n\nCallum",
     1, 17, ["SENT", "Suppliers"], {}),
    ("mail-juno-shoot", "thread-bramble-shoot", "juno-park", ["lena-fischer", "bea-morrow"],
     "Fieldstone frames delivered",
     "Jug on the light ground plus the bowl detail set. Two hundred and eleven frames.",
     "Lena, Bea,\n\nFieldstone day two is delivered: the jug on the light ground, the bowl rim details, "
     "and the full table set. 211 frames in the shared folder.\n\nThe jug reads much closer to the real "
     "glaze now. The grey cast was the ground, not the camera.\n\nJuno",
     2, 13, ["INBOX", "Suppliers"], {}),
    ("mail-iris-crazing-note", "thread-harbour-note", "iris-mendel", ["bea-morrow", "sana-devi"],
     "Harbour note: my draft",
     "It says which run, that it is a fit fault, and that it is ours. No hedging.",
     "Bea, Sana,\n\nDraft attached to the response plan. Three things it has to do: name the run, explain "
     "that crazing is a glaze fit fault and not a safety problem, and say plainly that it is ours.\n\nIt "
     "must not say 'in rare cases' or 'a small number of customers may'. Forty mugs is forty mugs.\n\nIris",
     3, 18, ["SENT", "Marketing"], {}),
    ("mail-bea-note-reply", "thread-harbour-note", "bea-morrow", ["iris-mendel"],
     "Re: Harbour note: my draft",
     "Agreed. One change: say the Fieldstone glaze is different, because people will ask.",
     "Iris,\n\nAgreed on all three. One addition: say that Fieldstone uses a different glaze and a "
     "different clay body and went through thirty dishwasher cycles before we listed it. Someone will ask "
     "it in the comments within the hour and it is better said first.\n\nBea",
     3, 19, ["SENT", "Marketing"], {}),
    ("mail-jonas-badge", "thread-badge-jonas", "jonas-wirth", ["yuki-tanabe"],
     "My review is not marked as verified",
     "I did buy the board. Guest checkout, if that matters.",
     "Hi,\n\nMy review of the oak board is not showing the verified badge. I did buy it, in December, "
     "though I checked out as a guest rather than making an account.\n\nJonas",
     10, 15, ["INBOX", "UNREAD", "Support"], {}),
    ("mail-yuki-badge-reply", "thread-badge-jonas", "yuki-tanabe", ["jonas-wirth"],
     "Re: My review is not marked as verified",
     "Guest orders do not match yet. That is our gap, not a doubt about you.",
     "Hello Jonas,\n\nYou are right and the badge is wrong. We match reviews to orders by account, and a "
     "guest order has no account to match. Your review stands as it is until we can match on the order "
     "email instead.\n\nWe would rather show an honest gap than badge everyone.\n\nYuki",
     10, 16, ["SENT", "Support"], {}),
    ("mail-felix-hold", "thread-club-april", "felix-arana", ["rosa-delgado", "iris-mendel"],
     "Holding the April teaser send",
     "A promotional email on top of a double charge is not a good look.",
     "Rosa, Iris,\n\nI am holding the April Pantry Club teaser until both credit notes are out. Sending a "
     "promotional email to a list that contains two people we charged twice is not something I want to "
     "explain afterwards.\n\nFelix",
     1, 10, ["SENT", "Marketing"], {}),
    ("mail-mira-drop-brief", "thread-fieldstone-brief", "mira-halvorsen", ["iris-mendel"],
     "Fieldstone: the decision I am bringing tomorrow",
     "Launch four pieces, bowl on preorder, no ship date until the 27th.",
     "Iris,\n\nWhat I am bringing to the go or no-go: launch all four pieces on the 25th with the serving "
     "bowl as a preorder. 93 sellable bowls against roughly 140 units of expected demand.\n\nThe two open "
     "issues are 210, the badge on the collection grid, and 218, preorder stock not held against the third "
     "run. 210 blocks the launch. 218 blocks taking walk-up orders after it.\n\nNo ship date for the "
     "preorder until the 27 March inspection.\n\nMira",
     1, 20, ["INBOX", "Product"], {"project_id": "project-fieldstone-drop"}),
    ("mail-otto-replacements", "thread-harbour-addresses", "otto-lindqvist", ["sana-devi"],
     "Six replacement addresses need confirming",
     "Six of the forty orders have addresses older than a year.",
     "Sana,\n\n34 of 40 replacements are sent. The remaining six have shipping addresses more than a year "
     "old, so I am mailing each of them to confirm before sending rather than posting a mug to an address "
     "someone has moved out of.\n\nOtto",
     2, 11, ["SENT", "Support"], {}),
    ("mail-tilda-thanks", "thread-club-tilda", "tilda-nyberg", ["felix-arana"],
     "The March box was the best one yet",
     "The olive oil especially. Please keep sourcing from that grove.",
     "Hello,\n\nJust to say the March box was the best one you have sent. The olive oil especially — "
     "please keep sourcing from that grove.\n\nTilda",
     13, 8, ["INBOX", "Customers"], {}),
    ("mail-greta-plate", "thread-support-greta", "greta-lindholm", ["otto-lindqvist"],
     "Two of my Fieldstone plates sit unevenly",
     "Two of four rock very slightly. Is that expected?",
     "Hello,\n\nTwo of my four Fieldstone plates rock very slightly on a flat table. Not enough to spill "
     "anything, but I noticed. Is that expected for thrown pieces or should I send them back?\n\nGreta",
     10, 17, ["INBOX", "Support"], {}),
    ("mail-otto-plate-reply", "thread-support-greta", "otto-lindqvist", ["greta-lindholm"],
     "Re: Two of my Fieldstone plates sit unevenly",
     "Expected within about a millimetre. Beyond that we replace them.",
     "Hello Greta,\n\nA little movement is expected: the plates are thrown and the foot is trued by hand. "
     "Our tolerance is about a millimetre. If yours rock more than that, or if it bothers you at all, say "
     "the word and we will replace them.\n\nOtto",
     10, 18, ["SENT", "Support"], {}),
]

# One lifecycle send, to the members whose plan includes the March pantry box.
# It is composed rather than written out twenty times, which is exactly what a
# marketing tool does.
CAMPAIGN_RECIPIENTS = [member for member, plan, *_rest in CLUB_MEMBERS if plan == "standard"]


def campaign_mail() -> list[dict]:
    messages = []
    for index, shopper_id in enumerate(CAMPAIGN_RECIPIENTS, start=1):
        messages.append(
            {
                "id": f"mail-campaign-march-{index:02d}",
                "thread_id": f"thread-campaign-march-{index:02d}",
                "from_id": "felix-arana",
                "to_ids": [shopper_id],
                "subject": "Inside the March pantry box",
                "snippet": "Flaked sea salt, the November olive oil, and a set of beeswax wraps.",
                "body_text": (
                    f"Hello {first_name(shopper_id)},\n\n"
                    "This month's box: a refillable tin of flaked sea salt, the November olive oil from "
                    "the grove at Vall d'Or, and a set of three beeswax wraps.\n\n"
                    "Fieldstone, our new stoneware collection, opens on 25 March. Club members see it a "
                    "day early.\n\n"
                    "Felix\nMarlow & Pine"
                ),
                "sent_at": stamp(15, 8, min(59, index * 2)),
                "labels": ["SENT", "Marketing"],
                "customer_id": f"club-{shopper_id}",
            }
        )
    return messages


def mail_records() -> list[dict]:
    messages = []
    for (
        mail_id,
        thread_id,
        from_id,
        to_ids,
        subject,
        snippet,
        body,
        days_before,
        hour,
        labels,
        refs,
    ) in MAIL_SOURCE:
        message = {
            "id": mail_id,
            "thread_id": thread_id,
            "from_id": from_id,
            "to_ids": to_ids,
            "subject": subject,
            "snippet": snippet,
            "body_text": body,
            "sent_at": stamp(days_before, hour),
            "labels": labels,
        }
        # `project_id` is a story reference, not a mail projection field; only
        # the three the projection carries are copied onto the message itself.
        for key in ("invoice_id", "customer_id", "order_id"):
            if key in refs:
                message[key] = refs[key]
        messages.append(message)
    messages.extend(campaign_mail())
    return sorted(messages, key=lambda message: (message["sent_at"], message["id"]))


# ---------------------------------------------------------------------------
# The live timeline
# ---------------------------------------------------------------------------

TIMELINE = [
    {
        "id": "arrival-desmond-three-found",
        "after_seconds": 45,
        "kind": "incoming-email",
        "payload": {
            "from_id": "desmond-oyelaran",
            "to_id": "callum-reid",
            "thread_id": "thread-swiftline-pallet",
            "subject": "Re: Pallet 4471: the last three",
            "snippet": "All three were re-labelled onto a returns pallet by mistake. They ship today.",
            "body_text": (
                "Callum,\n\nFound them. All three were re-labelled onto a returns pallet on the 13th by "
                "someone covering the bay. Nothing was lost. They go out today with real tracking "
                "numbers.\n\nThe manifest mismatch that started this was ours as well.\n\nDesmond"
            ),
            "labels": ["INBOX", "UNREAD", "Suppliers"],
        },
    },
    {
        "id": "arrival-chat-pallet-closed",
        "after_seconds": 75,
        "kind": "chat-message",
        "payload": {
            "author_id": "callum-reid",
            "channel_id": "channel-fulfilment",
            "text": "All eleven located. The last three were re-labelled onto a returns pallet. Otto, you can write to them with something true now.",
        },
    },
    {
        "id": "arrival-chat-eleven-sent",
        "after_seconds": 130,
        "kind": "chat-message",
        "payload": {
            "author_id": "otto-lindqvist",
            "channel_id": "channel-fulfilment",
            "text": "Eleven messages out, one each, with the parcel's actual position and a tracking number. No status page link.",
        },
    },
    {
        "id": "arrival-kiln-inspection",
        "after_seconds": 180,
        "kind": "incoming-email",
        "payload": {
            "from_id": "harriet-vance",
            "to_id": "kit-nwosu",
            "thread_id": "thread-harrow-run",
            "subject": "Third run: 104 of 118",
            "snippet": "Fourteen rejected. The rim crawl is down to the glaze thickness on the second dip.",
            "body_text": (
                "Kit,\n\nThird run: 118 fired, 14 rejected, 104 sellable. The crawl was the second glaze "
                "dip going on too heavy at the rim; we thinned only that dip and left the body coat "
                "alone.\n\nThat is 197 sellable bowls in total. I still will not promise a yield for the "
                "fourth run.\n\nHarriet"
            ),
            "labels": ["INBOX", "UNREAD", "Suppliers"],
        },
    },
    {
        "id": "arrival-chat-preorder-covered",
        "after_seconds": 215,
        "kind": "chat-message",
        "payload": {
            "author_id": "kit-nwosu",
            "channel_id": "channel-fieldstone",
            "text": "197 sellable bowls after the third run. Every preorder is covered and there are about fifty left for the drop.",
        },
    },
    {
        "id": "arrival-orla-payment",
        "after_seconds": 385,
        "kind": "stripe-payment",
        "payload": {
            "customer_id": "club-orla-brennan",
            "amount_cents": 3900,
            "currency": "usd",
            "description": "Pantry Club standard box — March",
            "invoice_id": "inv-2031",
        },
    },
    {
        "id": "arrival-hugo-payment",
        "after_seconds": 420,
        "kind": "stripe-payment",
        "payload": {
            "customer_id": "club-hugo-marchetti",
            "amount_cents": 6400,
            "currency": "usd",
            "description": "Pantry Club large box — February, on a replacement card",
            "invoice_id": "inv-2032",
        },
    },
    {
        "id": "arrival-chat-hugo-paid",
        "after_seconds": 450,
        "kind": "chat-message",
        "payload": {
            "author_id": "rosa-delgado",
            "channel_id": "channel-pantry-club",
            "text": "Hugo updated his card and February is settled. No pause needed. Both March credit notes are out as well.",
        },
    },
    {
        "id": "arrival-reconciliation-object",
        "after_seconds": 500,
        "kind": "s3-object",
        "payload": {
            "bucket": "marlow-pine-documents",
            "key": "finance/march-club-reconciliation.csv",
            "content_type": "text/csv",
            "content": (
                "invoice,customer,charged_cents,expected_cents,credit_cents\n"
                "inv-2033,club-maren-oduya,12800,6400,6400\n"
                "inv-2034,club-bennett-cho,12800,6400,6400\n"
            ),
        },
    },
    {
        "id": "arrival-alma-preorder-reply",
        "after_seconds": 545,
        "kind": "incoming-email",
        "payload": {
            "from_id": "alma-reyes",
            "to_id": "sana-devi",
            "thread_id": "thread-preorder-alma",
            "subject": "Re: When does the Fieldstone bowl ship?",
            "snippet": "Happy to wait for the bowl. Please hold the mugs and send it all together.",
            "body_text": (
                "Hello Sana,\n\nThank you for not making up a date. I would rather wait and get everything "
                "in one box, so please hold the mugs and send them with the bowl.\n\nAlma"
            ),
            "labels": ["INBOX", "UNREAD", "Support"],
        },
    },
    {
        "id": "arrival-chat-drop-decision",
        "after_seconds": 600,
        "kind": "chat-message",
        "payload": {
            "author_id": "mira-halvorsen",
            "channel_id": "channel-fieldstone",
            "text": "Decision: all four pieces launch on the 25th, bowl included as normal stock now that the third run covers the preorders. Issue 218 still ships before we take walk-up orders.",
        },
    },
]


# ---------------------------------------------------------------------------
# Stories, facts, agent and site
# ---------------------------------------------------------------------------

STORIES = [
    {
        "id": "story-fieldstone-drop",
        "title": "A collection launching with one piece short",
        "summary": "Fieldstone opens on 25 March. The serving bowl's first two kiln runs produced 93 sellable pieces against about 140 units of demand, so it opens as a preorder rather than as stock that does not exist.",
        "state": "active",
        "entity_refs": ["prod-fieldstone-bowl", "project-fieldstone-drop", "doc-fieldstone-launch"],
    },
    {
        "id": "story-harbour-crazing",
        "title": "A glaze fault the brand announced first",
        "summary": "About forty Harbour mugs from the first run craze in the dishwasher. Marlow & Pine is replacing every one without a return or a receipt, and said so publicly before the reviews forced it.",
        "state": "active",
        "entity_refs": ["prod-harbour-mug", "case-crazing-batch", "post-harbour-crazing", "review-harbour-01", "doc-crazing-response"],
    },
    {
        "id": "story-club-double-charge",
        "title": "Two members charged twice, found in reconciliation",
        "summary": "A renewal retry with no idempotency key charged two Pantry Club members twice in March. Finance found it, not the members. One credit note is issued and the second follows.",
        "state": "active",
        "entity_refs": ["case-double-charge", "inv-2033", "inv-2034", "doc-club-billing"],
    },
    {
        "id": "story-pallet-trace",
        "title": "Eleven orders that said shipped and were not",
        "summary": "Swiftline scanned a pallet outbound with no tracking numbers and the order service believed it. Eleven people were told their parcel was on its way. Support is holding the message until there is a true one.",
        "state": "active",
        "entity_refs": ["case-missing-tracking", "project-fulfilment-recovery", "post-shipping-honestly"],
    },
    {
        "id": "story-verified-badges",
        "title": "A badge that is honest about what it cannot prove",
        "summary": "Verified-buyer badges match a review to an order by account id, so guest buyers stay unbadged. The team shipped the gap rather than badging everyone.",
        "state": "active",
        "entity_refs": ["post-verified-reviews", "doc-review-badges"],
    },
]

MODEL_FACTS = [
    {
        "id": "fact-bowl-preorder",
        "kind": "inventory",
        "text": "The Fieldstone serving bowl opens as a preorder because two kiln runs produced 93 sellable bowls against about 140 units of demand.",
    },
    {
        "id": "fact-crazing-scope",
        "kind": "quality",
        "text": "Crazing affects the first Harbour mug run only. It is a glaze fit fault, not a safety fault, and every affected mug is replaced without a return.",
    },
    {
        "id": "fact-double-charge",
        "kind": "finance",
        "text": "Two Pantry Club members were charged twice in March because a renewal retry ran without an idempotency key. Issue 215 is open.",
    },
    {
        "id": "fact-empty-scan",
        "kind": "fulfilment",
        "text": "Eleven orders were marked shipped from a warehouse scan that carried no tracking number. The parcels were never collected.",
    },
    {
        "id": "fact-guest-badge",
        "kind": "storefront",
        "text": "A verified-buyer badge is granted by matching a review author's account to an order, so a genuine buyer who checked out as a guest shows unbadged.",
    },
]

AGENTIC = {
    "actor_id": "iris-mendel",
    "capabilities": [
        "mail.read",
        "mail.send",
        "calendar.read",
        "documents.read",
        "slack.read",
        "slack.post",
        "github.issue.read",
        "github.issue.comment",
        "finance.invoice.read",
        "commerce.order.read",
        "social.review.read",
        "storage.object.read",
    ],
    "constraints": [
        "Treat every record as synthetic",
        "Do not invent orders, payments or ship dates",
        "Use normal application APIs and tools",
        "Cite canonical entity references in evaluation output",
        "Do not expose session credentials",
        "Do not give a customer a date that no kiln run supports",
    ],
    "goals": [
        {
            "id": "goal-drop-decision",
            "title": "Decide how the Fieldstone bowl launches",
            "instructions": (
                "State whether the serving bowl should launch as stock or as a preorder, using the kiln "
                "yields and the open storefront issues as evidence. Name what has to ship before the drop "
                "and what can wait."
            ),
            "success_evidence": [
                "Uses the sellable bowl count rather than the fired count",
                "Names issue 210 as a launch blocker and issue 218 as a post-launch one",
                "Does not give a preorder ship date before the third kiln run",
            ],
        },
        {
            "id": "goal-crazing-letter",
            "title": "Write to a customer whose Harbour mug crazed",
            "instructions": (
                "Draft the reply to a shopper reporting crazing. Say what the fault is, that it is the "
                "first Harbour run, that it is not a safety problem, and that a replacement needs no "
                "return and no receipt."
            ),
            "success_evidence": [
                "Says the mug is safe to drink from",
                "Does not ask for the mug back or for proof of purchase",
                "Does not describe forty mugs as a rare or isolated case",
            ],
        },
        {
            "id": "goal-tracking-answer",
            "title": "Answer the eleven orders with no carrier movement",
            "instructions": (
                "Write to a shopper whose order was marked shipped from an empty scan. Say where the "
                "parcel actually is, what went wrong, and what happens next."
            ),
            "success_evidence": [
                "Does not point the shopper back at the tracking page",
                "States that the parcel was scanned but not collected",
                "Gives a next step rather than an apology only",
            ],
        },
    ],
    "grounding": [
        {"kind": "person", "entity_id": "clara-voight"},
        {"kind": "person", "entity_id": "quinn-abara"},
        {"kind": "organization", "entity_id": "harrow-works"},
        {"kind": "invoice", "entity_id": "inv-2033"},
        {
            "kind": "support-case",
            "entity_id": "case-crazing-batch",
            "fact": {"state": "replacing", "next_action": "Send the last eleven replacements"},
        },
        {
            "kind": "product",
            "entity_id": "prod-fieldstone-bowl",
            "fact": {"status": "preorder", "sellable_after_two_runs": 93},
        },
    ],
    "causal_rules": [
        {
            "id": "rule-order-paid",
            "when": "commerce.order.paid",
            "requires": [
                "order_id",
                "amount_cents"
            ],
            "emits": [
                "finance.ledger.updated",
                "mail.order-confirmation.available"
            ],
            "execution": "descriptive",
            "reason": "Describes a story consequence. No executable provider operation is declared for this rule."
        },
        {
            "id": "rule-review-published",
            "when": "social.review.published",
            "requires": [
                "review_id",
                "product_id"
            ],
            "emits": [
                "social.product-rating.updated",
                "support.case.considered"
            ],
            "execution": "descriptive",
            "reason": "Describes a story consequence. No executable provider operation is declared for this rule."
        },
        {
            "id": "rule-invoice-payment",
            "when": "finance.invoice.paid",
            "requires": [
                "invoice_id",
                "payment_id",
                "amount_cents"
            ],
            "emits": [
                "finance.ledger.updated",
                "mail.payment-receipt.available"
            ],
            "execution": "descriptive",
            "reason": "Describes a story consequence. No executable provider operation is declared for this rule."
        },
        {
            "api_version": "worldfixture.causal-rule/v1",
            "id": "rule-slack-channel-notification",
            "when": "communication.message.sent.v1",
            "requires": [
                "provider_evidence.channel_name",
                "actor_id"
            ],
            "emit": [
                {
                    "type": "mail.notification.requested.v1",
                    "after": "1s",
                    "with": {
                        "recipients": {
                            "lookup": {
                                "collection": "communication.channels",
                                "match": {
                                    "field": "name",
                                    "value": {
                                        "copy": "provider_evidence.channel_name"
                                    }
                                },
                                "select": "member_ids"
                            }
                        },
                        "author": {
                            "copy": "actor_id"
                        },
                        "channel": {
                            "copy": "provider_evidence.channel_name"
                        },
                        "text": {
                            "copy": "provider_evidence.text"
                        }
                    }
                }
            ]
        }
    ],
}

SITE = {
    "openapi_path": "/openapi.json",
    "feed": {
        "path": "/feeds/journal.xml",
        "title": "Marlow & Pine journal",
        "description": "Launches, faults, and how orders actually move, from the synthetic Marlow & Pine world.",
        "items": [
            {
                "id": "feed-fieldstone",
                "path": "/journal/fieldstone",
                "title": "Fieldstone arrives on 25 March",
                "summary": "Four pieces. The serving bowl opens as a preorder because the first two kiln runs were short.",
                "published_at": stamp(6, 15, 0),
            },
            {
                "id": "feed-crazing",
                "path": "/journal/harbour-crazing",
                "title": "The Harbour mug is crazing, and we are replacing it",
                "summary": "About forty mugs from the first run. No return, no receipt, and a plain description of the fault.",
                "published_at": stamp(2, 11, 30),
            },
            {
                "id": "feed-club-billing",
                "path": "/journal/pantry-club-march",
                "title": "Two members were charged twice in March",
                "summary": "A renewal retry ran after the first charge had already succeeded. Found in reconciliation, not by a complaint.",
                "published_at": stamp(1, 17, 10),
            },
            {
                "id": "feed-shipping",
                "path": "/journal/where-your-order-is",
                "title": "Where your order actually is",
                "summary": "A label is not a collection. Eleven orders are currently proving the difference.",
                "published_at": stamp(20, 13, 15),
            },
            {
                "id": "feed-arrival-pallet",
                "path": "/journal/where-your-order-is",
                "title": "All eleven parcels are located",
                "summary": "Eight were never collected and three were re-labelled onto a returns pallet. Every one now has a real tracking number.",
                "published_at": iso(ANCHOR.replace(hour=9, minute=32)),
                "arrival_id": "arrival-chat-pallet-closed",
            },
            {
                "id": "feed-arrival-kiln",
                "path": "/journal/fieldstone",
                "title": "The third kiln run covers every preorder",
                "summary": "104 sellable bowls from 118 fired, which is 197 in total and about fifty spare on drop day.",
                "published_at": iso(ANCHOR.replace(hour=9, minute=36)),
                "arrival_id": "arrival-kiln-inspection",
            },
            {
                "id": "feed-arrival-credits",
                "path": "/journal/pantry-club-march",
                "title": "Both March credit notes are out",
                "summary": "The retry fix is merged and the reconciliation file is published per invoice.",
                "published_at": iso(ANCHOR.replace(hour=9, minute=42)),
                "arrival_id": "arrival-chat-hugo-paid",
            },
        ],
    },
    "pages": [
        {
            "path": "/",
            "title": "Marlow & Pine",
            "heading": "Homeware made in small batches, sold direct",
            "summary": "A direct-to-consumer homeware brand selling stoneware, linens and a monthly pantry box.",
            "sections": [
                {
                    "heading": "This week",
                    "body": "Fieldstone launches on 25 March. The serving bowl opens as a preorder because the kiln runs were short, and we would rather say so than take money for stock we do not have.",
                },
                {
                    "heading": "When something is wrong",
                    "body": "We publish the fault before the reviews do. The Harbour mug crazing note and the March billing note are both on the journal.",
                },
            ],
        },
        {
            "path": "/journal/fieldstone",
            "title": "Fieldstone arrives on 25 March",
            "heading": "Four pieces, one of them short",
            "summary": "Four pieces. The serving bowl opens as a preorder because the first two kiln runs were short.",
            "sections": [
                {
                    "heading": "The numbers",
                    "body": "Two kiln runs produced 93 sellable bowls against roughly 140 units of demand at the last two drops. Nineteen of the second run's 112 were rejected for crawl marks along the rim.",
                },
                {
                    "heading": "What we will not do",
                    "body": "We will not give a preorder ship date before the third run is inspected on 27 March.",
                },
            ],
            "request_variants": [
                "The third kiln run is booked for 27 March and no yield has been promised.",
                "The third run produced 104 sellable bowls, so every preorder is covered.",
            ],
        },
        {
            "path": "/journal/harbour-crazing",
            "title": "The Harbour mug is crazing, and we are replacing it",
            "heading": "A glaze fit fault in the first Harbour run",
            "summary": "About forty mugs from the first run. No return, no receipt, and a plain description of the fault.",
            "sections": [
                {
                    "heading": "What crazing is",
                    "body": "The glaze and the clay body shrink at slightly different rates. Repeated dishwasher cycles open fine cracks in the glaze. It is not a safety problem and the mug is safe to drink from.",
                },
                {
                    "heading": "What happens now",
                    "body": "Every mug from that run is replaced. Nothing to return, no receipt needed. Fieldstone uses a different glaze and a different body and went through thirty dishwasher cycles before we listed it.",
                },
            ],
        },
        {
            "path": "/journal/pantry-club-march",
            "title": "Two members were charged twice in March",
            "heading": "A retry that should never have run",
            "summary": "A renewal retry ran after the first charge had already succeeded. Found in reconciliation, not by a complaint.",
            "sections": [
                {
                    "heading": "The cause",
                    "body": "The charge succeeded at the provider and the response timed out locally. The retry sent a second charge without an idempotency key.",
                },
                {
                    "heading": "The correction",
                    "body": "Both members were told before this note was published. Credit notes are issued against the March invoices; a credit note does not yet reference the invoice it corrects, so the invoice number is stated in the message.",
                },
            ],
        },
        {
            "path": "/journal/where-your-order-is",
            "title": "Where your order actually is",
            "heading": "A label is not a collection",
            "summary": "A label is not a collection. Eleven orders are currently proving the difference.",
            "sections": [
                {
                    "heading": "How it normally works",
                    "body": "Orders leave Swiftline in Columbus. A label is created when the box is packed and the first carrier scan happens on collection, which can be a day later.",
                },
                {
                    "heading": "What went wrong on 12 March",
                    "body": "A pallet was scanned outbound with no tracking numbers and the carrier refused the load. Eleven orders were marked shipped and were still in bay 3.",
                },
            ],
        },
    ],
    "probes": [
        {"path": "/health/api", "name": "Public API", "mode": "stable", "statuses": [200], "body": "ok"},
        {"path": "/health/checkout", "name": "Checkout", "mode": "stable", "statuses": [200], "body": "ok"},
        {
            "path": "/health/order-tracking",
            "name": "Order tracking",
            "mode": "failing",
            "statuses": [503],
            "body": "degraded: eleven orders are marked shipped with no carrier scan",
        },
        {
            "path": "/health/review-badges",
            "name": "Verified-buyer badges",
            "mode": "flapping",
            "statuses": [200, 200, 503, 200],
            "body": "guest orders do not match an account",
        },
    ],
    "status": {
        "status": "degraded",
        "incident": "Eleven orders were marked shipped from a warehouse scan that carried no tracking number.",
        "workaround": "Support is writing to each affected order individually. Do not rely on the tracking page for orders placed before 12 March.",
        "issue": 213,
    },
    "metrics": [
        {
            "name": "marlow_pine_catalog_products_active",
            "help": "Products currently available to buy.",
            "source": {"count": "products", "status": "active"},
        },
        {
            "name": "marlow_pine_orders_total",
            "help": "Orders in the synthetic Marlow & Pine world.",
            "source": {"count": "orders"},
        },
        {
            "name": "marlow_pine_orders_shipped",
            "help": "Orders marked shipped and not yet delivered.",
            "source": {"count": "orders", "status": "shipped"},
        },
        {
            "name": "marlow_pine_order_value_cents",
            "help": "Total value of every order in the world, in cents.",
            "source": {"count": "order_value_cents"},
        },
        {
            "name": "marlow_pine_reviews_published",
            "help": "Published product reviews.",
            "source": {"count": "reviews"},
        },
        {
            "name": "marlow_pine_reviews_three_stars_and_up",
            "help": "Published reviews rated three or better. Against the total, this gives the critical ones.",
            "source": {"count": "reviews", "min_rating": 3},
        },
        {
            "name": "marlow_pine_support_cases_open",
            "help": "Open support cases.",
            "source": {"count": "open_support_cases"},
        },
        {
            "name": "marlow_pine_open_invoice_cents",
            "help": "Open Pantry Club invoice value in cents.",
            "source": {"count": "open_invoice_cents"},
        },
        {
            "name": "marlow_pine_overdue_invoice_cents",
            "help": "Overdue Pantry Club invoice value in cents.",
            "source": {"count": "overdue_invoice_cents"},
        },
        {
            "name": "marlow_pine_people",
            "help": "People known to the synthetic world.",
            "source": {"count": "people"},
        },
    ],
}


# ---------------------------------------------------------------------------
# Writing the fragments
# ---------------------------------------------------------------------------


def write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> None:
    channels = channel_records()
    mail = mail_records()
    reviews = review_records()
    comments = comment_records()
    tasks = task_records()

    write(
        HERE / "backbones/marlow-pine.json",
        {
            "api_version": "worldfixture.world-fragment/v1",
            "id": "backbone.marlow-pine",
            "contributes": {"organizations": ORGANIZATIONS, "people": PEOPLE},
        },
    )

    write(
        HERE / "packs/retail-operations.json",
        {
            "api_version": "worldfixture.world-fragment/v1",
            "id": "pack.retail-operations",
            "contributes": {
                "commerce": {"products": PRODUCTS, "orders": ORDERS},
                "communication": {
                    # Declared rather than inherited: without these three, a
                    # second world is projected with the first world's Slack
                    # bot, issue-tracker team and database cluster.
                    "bots": [{"name": "marlow-helper"}],
                    "calendars": CALENDARS,
                    "calendar_events": CALENDAR_EVENTS,
                    "channels": channels,
                    "documents": DOCUMENTS,
                    "mail": mail,
                },
                "finance": {
                    "billing_owner_id": "rosa-delgado",
                    "currency": "USD",
                    # Six months. Enough for a season of subscription history
                    # without turning mail seeding into the slowest part of a
                    # start, which is the whole point of this world.
                    "history_months": 6,
                    "anchor_invoices": ANCHOR_INVOICES,
                    "customers": CUSTOMERS,
                    "suppliers": SUPPLIERS,
                },
                "social": {"posts": POSTS, "reviews": reviews, "comments": comments},
                "software": {
                    "operator_teams": ["engineering"],
                    "operator_ids": ["iris-mendel"],
                    "operator_limit": None,
                    "database": {
                        "cluster": "marlow-pine-production",
                        "name": "marlowpine",
                        "collections": ["customers", "orders", "products", "reviews", "support_cases"],
                    },
                },
                "support": {"cases": CASES},
                "work": {
                    "team": {"key": "MP", "name": "Marlow & Pine"},
                    "projects": PROJECTS,
                    "tasks": tasks,
                },
            },
        },
    )

    write(
        HERE / "stories/spring-drop.json",
        {
            "api_version": "worldfixture.world-fragment/v1",
            "id": "story.spring-drop",
            "contributes": {
                "agentic": AGENTIC,
                "model_facts": MODEL_FACTS,
                "site": SITE,
                "stories": STORIES,
                "timeline": TIMELINE,
            },
        },
    )

    counts = {
        "organizations": len(ORGANIZATIONS),
        "people": len(PEOPLE),
        "products": len(PRODUCTS),
        "orders": len(ORDERS),
        "posts": len(POSTS),
        "reviews": len(reviews),
        "comments": len(comments),
        "channels": len(channels),
        "chat messages": sum(len(channel["messages"]) for channel in channels),
        "authored mail": len(mail),
        "club members": len(CUSTOMERS),
        "suppliers": len(SUPPLIERS),
        "anchor invoices": len(ANCHOR_INVOICES),
        "support cases": len(CASES),
        "projects": len(PROJECTS),
        "tasks": len(tasks),
        "documents": len(DOCUMENTS),
        "calendar events": len(CALENDAR_EVENTS),
        "timeline arrivals": len(TIMELINE),
        "stories": len(STORIES),
    }
    for name, value in counts.items():
        print(f"{value:>6}  {name}")


if __name__ == "__main__":
    main()
