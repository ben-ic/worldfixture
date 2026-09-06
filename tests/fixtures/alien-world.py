#!/usr/bin/env python3
"""Create a repeatable world that does not use a shipped world's vocabulary.

CLI: python3 tests/fixtures/alien-world.py --seed <string> \
    --variant short|long --output <source.json>

This source deliberately has no business profile or invented provider identity.
The current core compiler can preserve it without producing projections. The
image matrix must report that missing provider coverage; a successful build is
not evidence that its records are served.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

REGRESSION_SEED = "coupling-regression-2026-09-05"
VARIANTS = {"short": (4, 30), "long": (2000, 7 * 24 * 60 * 60)}


def generate_world(seed: str, variant: str = "short") -> dict:
    """Return source data; each generated label depends only on its seed/key."""
    if not isinstance(seed, str) or not seed:
        raise ValueError("seed must be a nonempty string")
    if variant not in VARIANTS:
        raise ValueError(f"unknown variant: {variant}")

    markers: set[str] = set()

    def word(key: str) -> str:
        digest = hashlib.sha256(f"{seed}\0{key}".encode()).hexdigest()[:16]
        value = f"x{digest}"
        markers.add(value)
        return value

    token = word("world")
    domain = f"{token}.test"
    organization_id = f"org.{word('organization')}"
    # Dots and digits exercise code that assumes IDs are first-last names.
    person_ids = [f"p.{index:02d}-{word(f'person-{index}')}" for index in range(7)]
    anchor = "2031-02-11T07:13:00Z"
    teams = [word("team-0"), word("team-1")]
    states = [word("state-0"), word("state-1"), word("state-2")]
    currency = ("CHF", "NZD", "SEK")[int(token[1:3], 16) % 3]
    people = [
        {
            "id": person_id,
            "name": word(f"name-{index}").capitalize(),
            "email": f"{word(f'email-{index}')}@{domain}",
            "organization_id": organization_id if index < 5 else None,
            "role": word(f"role-{index}"),
            "team": teams[index % len(teams)],
            "primary": index == 0,
        }
        for index, person_id in enumerate(person_ids)
    ]
    project_id = f"project.{word('project')}"
    channel_id = f"channel.{word('channel')}"
    product_id = f"product.{word('product')}"
    order_id = f"order.{word('order')}"
    post_id = f"post.{word('post')}"
    review_id = f"review.{word('review')}"
    duplicate_title = word("duplicate-title")
    price = 2300 + int(token[-4:], 16) % 4700
    count, duration = VARIANTS[variant]
    timeline = []
    for index in range(count):
        payload = (
            {
                "from_id": person_ids[6],
                "to_id": person_ids[(index // 2) % 5],
                "subject": word(f"arrival-subject-{index}"),
                "body_text": word(f"arrival-body-{index}"),
                "labels": ["INBOX", "UNREAD"],
            }
            if index % 2 == 0
            else {
                "author_id": person_ids[index % 5],
                "channel_id": channel_id,
                "text": word(f"arrival-text-{index}"),
            }
        )
        timeline.append({
            "id": f"arrival.{token}-{index:04d}",
            "after_seconds": index * duration // (count - 1),
            "kind": "incoming-email" if index % 2 == 0 else "chat-message",
            "payload": payload,
        })

    world = {
        "api_version": "worldfixture.world-source/v1",
        "id": f"alien.{token}.{variant}",
        "version": "v1",
        "title": word("title"),
        "synthetic_notice": "All people and records in this test world are synthetic.",
        "scenario": {"id": f"scenario.{token}", "class": "normal", "title": word("scenario")},
        "clock": {"anchor": anchor, "timezone": "UTC", "locale": "en-NZ"},
        "organizations": [{
            "id": organization_id, "name": word("organization-name"),
            "slug": token, "domain": domain, "primary": True,
        }],
        "people": people,
        "communication": {
            "channels": [{
                "id": channel_id, "name": word("channel-name"), "topic": word("topic"),
                "member_ids": person_ids[:5],
                "messages": [{
                    "id": f"message.{token}", "author_id": person_ids[1],
                    "text": word("chat-text"), "timestamp": anchor,
                }],
            }],
            "mail": [{
                "id": f"mail.{token}", "thread_id": f"thread.{token}",
                "from_id": person_ids[5], "to_ids": [person_ids[0]],
                "subject": word("mail-subject"), "body_text": word("mail-body"),
                "sent_at": anchor, "labels": ["INBOX", "UNREAD"],
            }],
            "documents": [{
                "id": f"document.{token}", "name": word("document-name"),
                "owner_id": person_ids[2], "content": word("document-content"),
                "mime_type": "text/markdown", "modified_at": anchor,
            }],
            "calendars": [],
            "calendar_events": [],
        },
        "work": {
            "team": {"key": token[:7].upper(), "name": teams[0]},
            "projects": [{
                "id": project_id, "name": word("project-name"),
                "owner_id": person_ids[0], "member_ids": person_ids[:5],
                "status": states[0],
            }],
            "tasks": [{
                "id": f"task.{token}-{index}", "title": duplicate_title,
                "description": word(f"task-description-{index}"),
                "project_id": project_id, "assignee_id": person_ids[index],
                "reporter_id": person_ids[2], "status": states[index],
                "priority": "normal", "labels": [word("task-label")],
            } for index in range(2)],
        },
        "commerce": {
            "products": [{
                "id": product_id, "name": word("product-name"),
                "sku": word("sku"), "status": "active", "currency": currency,
                "price_cents": price,
            }],
            "orders": [{
                "id": order_id, "number": word("order-number"),
                "shopper_id": person_ids[5], "status": "delivered", "currency": currency,
                "placed_on": anchor[:10],
                "items": [{"product_id": product_id, "quantity": 2, "unit_amount_cents": price}],
                "subtotal_cents": 2 * price, "shipping_cents": 350,
                "discount_cents": 100, "total_cents": 2 * price + 250,
            }],
        },
        "social": {
            "posts": [{
                "id": post_id, "author_id": person_ids[3], "title": word("post-title"),
                "body": word("post-body"), "product_ids": [product_id], "posted_at": anchor,
            }],
            "reviews": [{
                "id": review_id, "author_id": person_ids[5], "product_id": product_id,
                "order_id": order_id, "rating": 4, "title": word("review-title"),
                "body": word("review-body"), "posted_at": anchor, "verified_buyer": True,
            }],
            "comments": [{
                "id": f"comment.{token}", "author_id": person_ids[4],
                "parent_id": review_id, "parent_kind": "review",
                "body": word("comment-body"), "posted_at": anchor,
            }],
        },
        "timeline": timeline,
    }
    world["fixture"] = {"seed": seed, "variant": variant, "markers": sorted(markers)}
    return world


def source_bytes(seed: str, variant: str = "short") -> bytes:
    return (json.dumps(generate_world(seed, variant), indent=2, sort_keys=True) + "\n").encode()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", required=True, help="Nonempty reproducible seed string")
    parser.add_argument("--variant", choices=tuple(VARIANTS), required=True)
    parser.add_argument("--output", type=Path, required=True, help="Generated source JSON path")
    args = parser.parse_args()
    if not args.seed:
        parser.error("--seed must not be empty")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(source_bytes(args.seed, args.variant))


if __name__ == "__main__":
    main()
