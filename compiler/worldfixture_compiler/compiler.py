from __future__ import annotations

import calendar
import copy
import hashlib
import io
import json
import re
import tarfile
import tempfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any


ID_PATTERN = re.compile(r"^[a-z][a-z0-9.-]+$")
LOGIN_PATTERN = re.compile(r"^[a-z][a-z0-9-]+$")

# RFC 2606 reserves `.test`. Every world address stays inside it so a world can
# never reach a real mailbox or host. The world author owns the labels in front.
TEST_DOMAIN_SUFFIX = ".test"


# What a world may schedule, and what plays it.
#
# Each kind is delivered by `runtime/src/scheduler.mjs` through a real provider
# interface: chat-message through the Slack Web API, incoming-email over SMTP,
# github-comment through the GitHub issue comments API, stripe-payment through
# Stripe, s3-object through S3, and webhook as an HTTP POST to a subscriber.
# Adding a name here without adding its delivery would let a world declare an
# arrival that nothing can ever play.
TIMELINE_KINDS = frozenset(
    {
        "chat-message",
        "incoming-email",
        "github-comment",
        "stripe-payment",
        "s3-object",
        "application-event",
        "webhook",
    }
)


class WorldError(ValueError):
    pass


def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _merge_fragment(left: Any, right: Any, path: str) -> Any:
    if isinstance(left, dict) and isinstance(right, dict):
        merged = copy.deepcopy(left)
        for key, value in right.items():
            child = f"{path}.{key}" if path else key
            if key in merged:
                merged[key] = _merge_fragment(merged[key], value, child)
            else:
                merged[key] = copy.deepcopy(value)
        return merged
    if isinstance(left, list) and isinstance(right, list):
        return copy.deepcopy(left) + copy.deepcopy(right)
    if left == right:
        return copy.deepcopy(left)
    raise WorldError(f"fragment conflict at {path}")


def load_world(source_path: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    """Resolve one source file and return the world plus authoring provenance."""
    source_path = source_path.resolve()
    source_bytes = source_path.read_bytes()
    source = json.loads(source_bytes)
    if source.get("api_version") == "worldfixture.world-source/v1":
        validate_world(source)
        return source, {
            "source_sha256": sha256(source_bytes),
            "source_files": {
                source_path.name: {"sha256": sha256(source_bytes), "size": len(source_bytes)}
            },
        }

    _require(
        source.get("api_version") == "worldfixture.world-manifest/v1",
        "unsupported source api_version",
    )
    root = source_path.parent
    world = copy.deepcopy(source.get("world", {}))
    world["api_version"] = "worldfixture.world-source/v1"
    fragments = source.get("fragments")
    _require(isinstance(fragments, list) and bool(fragments), "world manifest needs fragments")

    source_files = {
        source_path.name: {"sha256": sha256(source_bytes), "size": len(source_bytes)}
    }
    seen: set[str] = set()
    for index, relative in enumerate(fragments):
        _require(isinstance(relative, str) and bool(relative), f"fragment {index} needs a path")
        fragment_path = (root / relative).resolve()
        _require(fragment_path.is_relative_to(root), f"fragment path leaves world directory: {relative}")
        normalized = fragment_path.relative_to(root).as_posix()
        _require(normalized not in seen, f"duplicate fragment: {normalized}")
        seen.add(normalized)
        body = fragment_path.read_bytes()
        fragment = json.loads(body)
        _require(
            fragment.get("api_version") == "worldfixture.world-fragment/v1",
            f"unsupported fragment api_version: {normalized}",
        )
        _check_id(fragment.get("id"), f"fragment id in {normalized}")
        contributes = fragment.get("contributes")
        _require(isinstance(contributes, dict) and bool(contributes), f"empty fragment: {normalized}")
        world = _merge_fragment(world, contributes, "")
        source_files[normalized] = {"sha256": sha256(body), "size": len(body)}

    world["timeline"] = sorted(
        world.get("timeline", []),
        key=lambda event: (event.get("after_seconds", -1), event.get("id", "")),
    )
    validate_world(world)
    return world, {
        "source_sha256": sha256(canonical_json(source_files)),
        "source_files": source_files,
    }


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise WorldError(message)


def _unique(items: list[dict[str, Any]], field: str, label: str) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for item in items:
        value = item.get(field)
        _require(isinstance(value, str) and bool(value), f"{label} has no {field}")
        _require(value not in result, f"duplicate {label} {field}: {value}")
        result[value] = item
    return result


def _check_id(value: Any, label: str) -> None:
    _require(isinstance(value, str) and bool(ID_PATTERN.fullmatch(value)), f"invalid {label}: {value!r}")


def _check_reserved_test_domain(value: Any, label: str) -> None:
    """Keep every world address inside the reserved, non-routable `.test` TLD.

    RFC 2606 reserves `.test`, so a world can never address a real mailbox or
    host. The world author owns the rest of the suffix. The compiler core does
    not name one product's test domain.
    """
    _require(
        isinstance(value, str) and value.endswith(TEST_DOMAIN_SUFFIX) and len(value) > len(TEST_DOMAIN_SUFFIX),
        f"unsafe {label}: {value!r} must be inside the reserved {TEST_DOMAIN_SUFFIX} domain",
    )


def validate_world(world: dict[str, Any]) -> None:
    """Validate the core world envelope, then the declared world profile."""
    _validate_envelope(world)
    profile = world.get("profile")
    _require(profile is None or profile in PROFILES, f"unsupported world profile: {profile!r}")
    if profile is not None:
        PROFILES[profile]["validate"](world)


def _validate_envelope(world: dict[str, Any]) -> None:
    """Check only what every world has, whatever its records describe.

    The core requires no organization, person, GitHub login, Slack id, or
    primary person. A world profile adds those requirements when a world
    declares one.
    """
    _require(world.get("api_version") == "worldfixture.world-source/v1", "unsupported api_version")
    _check_id(world.get("id"), "world id")
    _require(re.fullmatch(r"v[0-9]+", str(world.get("version", ""))) is not None, "invalid world version")
    _require(len(str(world.get("synthetic_notice", ""))) >= 20, "synthetic_notice is too short")
    scenario = world.get("scenario", {})
    _check_id(scenario.get("id"), "scenario id")
    _require(
        scenario.get("class") in {"normal", "data-quality", "bad-actor", "fraud", "operational-failure"},
        "unsupported scenario class",
    )
    _require(bool(scenario.get("title")), "scenario needs a title")

    try:
        anchor = datetime.fromisoformat(world["clock"]["anchor"].replace("Z", "+00:00"))
    except (KeyError, TypeError, ValueError) as error:
        raise WorldError("clock.anchor must be an ISO-8601 timestamp") from error
    _require(anchor.tzinfo is not None, "clock.anchor must include a timezone")
    rebase = world["clock"].get("rebase", {})
    _require(isinstance(rebase, dict), "clock.rebase must be an object")
    relative_paths = rebase.get("relative_paths", [])
    _require(
        isinstance(relative_paths, list)
        and all(isinstance(path, str) and re.fullmatch(r"[a-z_]+(?:\.[a-z_]+)*", path) for path in relative_paths),
        "clock.rebase.relative_paths must name scenario-relative branches",
    )

    timeline_ids: set[str] = set()
    for event in world.get("timeline", []):
        _check_id(event.get("id"), "timeline id")
        _require(event["id"] not in timeline_ids, f"duplicate timeline id: {event['id']}")
        timeline_ids.add(event["id"])
        _require(
            isinstance(event.get("after_seconds"), int) and event["after_seconds"] >= 0,
            f"invalid timeline offset: {event['id']}",
        )


def _projected_bucket_names(world: dict[str, Any]) -> set[str]:
    """The S3 buckets this profile creates for a world.

    Kept beside the validation that needs it and derived the same way the
    projection derives them, so the two cannot disagree about what exists.
    """
    organizations = world.get("organizations", [])
    primary = next((item for item in organizations if item.get("primary")), None)
    if primary is None:
        return set()
    return {f"{primary['slug']}-documents", f"{primary['slug']}-exports"}


# The domains this profile's compiler indexes directly.
#
# WHY VALIDATION CHECKS FOR THEM. The validator read every one of these with
# `.get(...)` and the compiler reads them with `world[...]`, so a world could
# pass `validate` cleanly and then die in `build` on a bare Python `KeyError`
# -- which is not in the CLI's `except` list, so what reached the author was a
# traceback. Somebody writing a small world hit that seven times in a row.
#
# `validate` exists to answer "will this build?", and it was answering a
# different question. The compiler's requirements are named here rather than
# softened at twenty-three call sites, each of which would need its own opinion
# about what an absent domain projects to.
# Name and expected shape, because `stories` is a list where the rest are objects
# and a check that assumed one shape let the other through to a `KeyError`.
_BUSINESS_OPERATIONS_DOMAINS = (
    ("communication", dict),
    ("finance", dict),
    ("software", dict),
    ("support", dict),
    ("work", dict),
    ("agentic", dict),
    ("stories", list),
)
# `site` is deliberately absent from that list. The v2 world compiles without one
# and the public-site projection handles its absence, so requiring it would
# refuse a world this project itself ships. What the list holds is only what the
# compiler indexes unconditionally, verified against both reviewed worlds.


def _validate_business_operations(world: dict[str, Any]) -> None:
    """Validate the records the `business.operations/v1` profile projects."""
    organizations = _unique(world.get("organizations", []), "id", "organization")
    people = _unique(world.get("people", []), "id", "person")
    _require(bool(organizations), "world needs an organization")
    _require(bool(people), "world needs people")

    missing = [
        f"{name} (an {'object' if shape is dict else 'array'})"
        for name, shape in _BUSINESS_OPERATIONS_DOMAINS
        if not isinstance(world.get(name), shape)
    ]
    _require(
        not missing,
        f"the business.operations/v1 profile needs {', '.join(missing)}; "
        f"declare {'them' if len(missing) > 1 else 'it'} even when empty",
    )


    for organization in organizations.values():
        _check_id(organization["id"], "organization id")
        _check_reserved_test_domain(organization.get("domain"), f"organization domain for {organization['id']}")

    primary_count = 0
    emails: set[str] = set()
    github_logins: set[str] = set()
    slack_ids: set[str] = set()
    for person in people.values():
        _check_id(person["id"], "person id")
        organization_id = person.get("organization_id")
        _require(organization_id in organizations, f"person {person['id']} has unknown organization {organization_id}")
        email = person.get("email")
        _check_reserved_test_domain(email, f"person email for {person['id']}")
        _require(email not in emails, f"duplicate person email: {email}")
        emails.add(email)
        login = person.get("github_login")
        _require(isinstance(login, str) and bool(LOGIN_PATTERN.fullmatch(login)), f"invalid GitHub login for {person['id']}")
        _require(login not in github_logins, f"duplicate GitHub login: {login}")
        github_logins.add(login)
        slack_id = person.get("slack_id")
        _require(isinstance(slack_id, str) and slack_id.startswith("U"), f"invalid Slack id for {person['id']}")
        _require(slack_id not in slack_ids, f"duplicate Slack id: {slack_id}")
        slack_ids.add(slack_id)
        primary_count += int(person.get("primary", False))
    _require(primary_count == 1, "world must have exactly one primary person")

    finance = world.get("finance", {})
    customers = _unique(finance.get("customers", []), "id", "customer")
    suppliers = _unique(finance.get("suppliers", []), "id", "supplier")
    invoices = _unique(finance.get("anchor_invoices", []), "id", "invoice")
    for customer in customers.values():
        _check_id(customer["id"], "customer id")
        _require(customer.get("organization_id") in organizations, f"customer {customer['id']} has unknown organization")
        _require(customer.get("contact_id") in people, f"customer {customer['id']} has unknown contact")
        _require(int(customer.get("monthly_amount_cents", 0)) > 0, f"customer {customer['id']} has invalid amount")
    for supplier in suppliers.values():
        _check_id(supplier["id"], "supplier id")
        _require(supplier.get("organization_id") in organizations, f"supplier {supplier['id']} has unknown organization")
        _require(supplier.get("contact_id") in people, f"supplier {supplier['id']} has unknown contact")
        _require(int(supplier.get("monthly_amount_cents", 0)) > 0, f"supplier {supplier['id']} has invalid amount")
    for invoice in invoices.values():
        _check_id(invoice["id"], "invoice id")
        _require(invoice.get("customer_id") in customers, f"invoice {invoice['id']} has unknown customer")
        _require(int(invoice.get("amount_cents", 0)) > 0, f"invoice {invoice['id']} has invalid amount")

    products, orders = _validate_commerce(world, people)
    _validate_social(world, people, products, orders)

    repositories = _unique(world.get("software", {}).get("repositories", []), "id", "repository")
    for repository in repositories.values():
        _check_id(repository["id"], "repository id")
        _require(repository.get("owner_id") in organizations, f"repository {repository['id']} has unknown owner")
        for member_id in repository.get("member_ids", []):
            _require(member_id in people, f"repository {repository['id']} has unknown member {member_id}")

    projects = _unique(world.get("work", {}).get("projects", []), "id", "project")
    tasks = _unique(world.get("work", {}).get("tasks", []), "id", "task")
    time_entries = _unique(world.get("work", {}).get("time_entries", []), "id", "time entry")
    for project in projects.values():
        _check_id(project["id"], "project id")
        _require(project.get("owner_id") in people, f"project {project['id']} has unknown owner")
        for member_id in project.get("member_ids", []):
            _require(member_id in people, f"project {project['id']} has unknown member {member_id}")
        customer_id = project.get("customer_id")
        _require(customer_id is None or customer_id in customers, f"project {project['id']} has unknown customer")
    for task in tasks.values():
        _check_id(task["id"], "task id")
        _require(task.get("project_id") in projects, f"task {task['id']} has unknown project")
        _require(task.get("assignee_id") in people, f"task {task['id']} has unknown assignee")
        _require(task.get("reporter_id") in people, f"task {task['id']} has unknown reporter")
        _require(task.get("status") in {"backlog", "ready", "in-progress", "blocked", "review", "done"}, f"task {task['id']} has invalid status")
    for entry in time_entries.values():
        _check_id(entry["id"], "time entry id")
        _require(entry.get("task_id") in tasks, f"time entry {entry['id']} has unknown task")
        _require(entry.get("person_id") in people, f"time entry {entry['id']} has unknown person")
        _require(isinstance(entry.get("minutes"), int) and entry["minutes"] > 0, f"time entry {entry['id']} has invalid minutes")

    channels = _unique(world.get("communication", {}).get("channels", []), "id", "channel")
    for channel in channels.values():
        _check_id(channel["id"], "channel id")
        for member_id in channel.get("member_ids", []):
            _require(member_id in people, f"channel {channel['id']} has unknown member {member_id}")
        for message in channel.get("messages", []):
            _check_id(message.get("id"), "chat message id")
            _require(message.get("author_id") in people, f"chat message {message.get('id')} has unknown author")

    mail = _unique(world.get("communication", {}).get("mail", []), "id", "mail")
    for message in mail.values():
        _check_id(message["id"], "mail id")
        _require(message.get("from_id") in people, f"mail {message['id']} has unknown sender")
        for recipient_id in message.get("to_ids", []):
            _require(recipient_id in people, f"mail {message['id']} has unknown recipient {recipient_id}")
        related_invoice = message.get("invoice_id")
        _require(related_invoice is None or related_invoice in invoices, f"mail {message['id']} has unknown invoice")
        related_order = message.get("order_id")
        _require(related_order is None or related_order in orders, f"mail {message['id']} has unknown order")

    documents = _unique(world.get("communication", {}).get("documents", []), "id", "document")
    for document in documents.values():
        _check_id(document["id"], "document id")
        _require(document.get("owner_id") in people, f"document {document['id']} has unknown owner")

    support_cases = _unique(world.get("support", {}).get("cases", []), "id", "support case")
    for support_case in support_cases.values():
        _check_id(support_case["id"], "support case id")
        _require(support_case.get("customer_id") in customers, f"support case {support_case['id']} has unknown customer")
        _require(support_case.get("contact_id") in people, f"support case {support_case['id']} has unknown contact")
        _require(support_case.get("owner_id") in people, f"support case {support_case['id']} has unknown owner")
        related_order = support_case.get("order_id")
        _require(related_order is None or related_order in orders, f"support case {support_case['id']} has unknown order")

    # A timeline event is a fact that arrives after the world starts running.
    # `runtime/src/scheduler.mjs` plays every one of these through the provider
    # interface named below; a kind this compiler accepts and that runtime
    # cannot play would be a world that quietly does less than it says.
    issues_by_id = {
        issue["id"]: (repository, issue)
        for repository in repositories.values()
        for issue in repository.get("issues", [])
    }
    for event in world.get("timeline", []):
        _require(
            event.get("kind") in TIMELINE_KINDS,
            f"unsupported timeline kind: {event.get('kind')}",
        )
        payload = event.get("payload", {})
        if event["kind"] == "incoming-email":
            _require(payload.get("from_id") in people, f"timeline {event['id']} has unknown sender")
            _require(payload.get("to_id") in people, f"timeline {event['id']} has unknown recipient")
        if event["kind"] == "chat-message":
            _require(payload.get("author_id") in people, f"timeline {event['id']} has unknown author")
            _require(payload.get("channel_id") in channels, f"timeline {event['id']} has unknown channel")
        if event["kind"] == "github-comment":
            _require(payload.get("author_id") in people, f"timeline {event['id']} has unknown author")
            _require(payload.get("issue_id") in issues_by_id, f"timeline {event['id']} has unknown issue")
            _require(bool(str(payload.get("body", ""))), f"timeline {event['id']} has no comment body")
        if event["kind"] == "stripe-payment":
            _require(payload.get("customer_id") in customers, f"timeline {event['id']} has unknown customer")
            _require(int(payload.get("amount_cents", 0)) > 0, f"timeline {event['id']} has invalid amount")
        if event["kind"] == "s3-object":
            _require(bool(payload.get("bucket")), f"timeline {event['id']} has no bucket")
            _require(bool(payload.get("key")), f"timeline {event['id']} has no object key")
            # SeaweedFS answers 403 for a PUT into a bucket that does not exist,
            # and the arrival reports that as a failed write four minutes into a
            # run. Measured, in exactly that way. The bucket names this profile
            # projects are derived from the primary organization's slug, so the
            # compiler can say so now instead.
            _require(
                payload["bucket"] in _projected_bucket_names(world),
                f"timeline {event['id']} writes to bucket {payload['bucket']!r}, "
                f"and this world has {sorted(_projected_bucket_names(world))}",
            )


ORDER_STATES = frozenset(
    {"placed", "packed", "shipped", "delivered", "returned", "refunded", "cancelled"}
)
PRODUCT_STATES = frozenset({"active", "preorder", "sold-out", "retired"})


def _validate_commerce(
    world: dict[str, Any], people: dict[str, dict[str, Any]]
) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    """Validate the optional catalog and order book.

    A world that sells to people rather than to companies has a catalog and an
    order book, and neither fits `finance.customers`, which is a recurring
    billing relationship. These records are optional: a world without them
    validates and compiles exactly as before.

    THE ARITHMETIC IS CHECKED, NOT COPIED. An order states its own subtotal and
    total, because that is what an order does, and a reader of the pack should
    not have to recompute one to trust it. The compiler recomputes it anyway: an
    order whose stated total disagrees with its own lines is the sort of fault
    that survives every review and then teaches an application the wrong sum.
    """
    commerce = world.get("commerce", {})
    _require(isinstance(commerce, dict), "commerce must be an object")
    products = _unique(commerce.get("products", []), "id", "product")
    orders = _unique(commerce.get("orders", []), "id", "order")

    for product in products.values():
        _check_id(product["id"], "product id")
        _require(bool(product.get("name")), f"product {product['id']} has no name")
        _require(int(product.get("price_cents", 0)) > 0, f"product {product['id']} has invalid price")
        _require(
            product.get("status") in PRODUCT_STATES,
            f"product {product['id']} has invalid status: {product.get('status')!r}",
        )

    for order in orders.values():
        _check_id(order["id"], "order id")
        _require(order.get("shopper_id") in people, f"order {order['id']} has unknown shopper")
        _require(
            order.get("status") in ORDER_STATES,
            f"order {order['id']} has invalid status: {order.get('status')!r}",
        )
        items = order.get("items", [])
        _require(isinstance(items, list) and bool(items), f"order {order['id']} has no items")
        subtotal = 0
        for item in items:
            _require(item.get("product_id") in products, f"order {order['id']} has unknown product {item.get('product_id')}")
            quantity = item.get("quantity")
            unit = item.get("unit_amount_cents")
            _require(isinstance(quantity, int) and quantity > 0, f"order {order['id']} has invalid quantity")
            _require(isinstance(unit, int) and unit > 0, f"order {order['id']} has invalid unit amount")
            subtotal += quantity * unit
        _require(
            order.get("subtotal_cents") == subtotal,
            f"order {order['id']} states subtotal {order.get('subtotal_cents')} and its lines come to {subtotal}",
        )
        total = subtotal + int(order.get("shipping_cents", 0)) - int(order.get("discount_cents", 0))
        _require(
            order.get("total_cents") == total,
            f"order {order['id']} states total {order.get('total_cents')} and its lines come to {total}",
        )
    return products, orders


def _validate_social(
    world: dict[str, Any],
    people: dict[str, dict[str, Any]],
    products: dict[str, dict[str, Any]],
    orders: dict[str, dict[str, Any]],
) -> None:
    """Validate the optional public activity a world publishes about itself.

    Posts, reviews and comments are one domain because they are one surface: a
    reader of a product page sees all three together, and a comment can hang off
    either of the other two. Every one of them names a person in the world, so
    public activity can never come from an author the world does not have.
    """
    social = world.get("social", {})
    _require(isinstance(social, dict), "social must be an object")
    posts = _unique(social.get("posts", []), "id", "post")
    reviews = _unique(social.get("reviews", []), "id", "review")
    comments = _unique(social.get("comments", []), "id", "comment")

    for post in posts.values():
        _check_id(post["id"], "post id")
        _require(post.get("author_id") in people, f"post {post['id']} has unknown author")
        _require(bool(post.get("title")), f"post {post['id']} has no title")
        for product_id in post.get("product_ids", []):
            _require(product_id in products, f"post {post['id']} names unknown product {product_id}")

    for review in reviews.values():
        _check_id(review["id"], "review id")
        _require(review.get("product_id") in products, f"review {review['id']} has unknown product")
        _require(review.get("author_id") in people, f"review {review['id']} has unknown author")
        rating = review.get("rating")
        _require(isinstance(rating, int) and 1 <= rating <= 5, f"review {review['id']} has invalid rating")
        order_id = review.get("order_id")
        _require(order_id is None or order_id in orders, f"review {review['id']} has unknown order")

    for comment in comments.values():
        _check_id(comment["id"], "comment id")
        _require(comment.get("author_id") in people, f"comment {comment['id']} has unknown author")
        parent_id = comment.get("parent_id")
        _require(
            parent_id in posts or parent_id in reviews,
            f"comment {comment['id']} has no post or review to hang from: {parent_id!r}",
        )


def _month_before(anchor: date, months: int) -> date:
    absolute = anchor.year * 12 + anchor.month - 1 - months
    return date(absolute // 12, absolute % 12 + 1, 1)


def _date_in_month(month: date, day: int) -> date:
    return date(month.year, month.month, min(day, calendar.monthrange(month.year, month.month)[1]))


def _iso_day(value: date) -> str:
    return value.isoformat()


# The timestamp pass runs first, so this must not match the date half of a
# timestamp it already moved. Without the lookahead every timestamp under a
# rebased branch shifts twice and the world loses its internal order: mail
# arrives after the invoice it discusses is due.
_ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}(?!T\d{2}:)")
_ISO_TIMESTAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})")
_MONTH_NAMES = (
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)


def _ordinal(value: int) -> str:
    suffix = "th" if 10 <= value % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(value % 10, "th")
    return f"{value}{suffix}"


def _rebase_text(value: str, anchor: date, delta: timedelta) -> str:
    """Shift reviewed scenario dates while leaving historical prose unchanged."""
    first = anchor - timedelta(days=35)
    last = anchor + timedelta(days=35)

    def shifted(day: date) -> date | None:
        return day + delta if first <= day <= last else None

    def iso_timestamp(match: re.Match[str]) -> str:
        original = datetime.fromisoformat(match.group().replace("Z", "+00:00"))
        if shifted(original.date()) is None:
            return match.group()
        return (original + delta).isoformat().replace("+00:00", "Z")

    def iso_date(match: re.Match[str]) -> str:
        original = date.fromisoformat(match.group())
        return shifted(original).isoformat() if shifted(original) else match.group()

    value = _ISO_TIMESTAMP.sub(iso_timestamp, value)
    value = _ISO_DATE.sub(iso_date, value)

    # The authored prose uses these two unambiguous date forms. Weekday words do
    # not need rewriting because rebase steps are always whole weeks.
    month_pattern = "|".join(_MONTH_NAMES)

    def day_month(match: re.Match[str]) -> str:
        original = date(anchor.year, _MONTH_NAMES.index(match.group(3)) + 1, int(match.group(1)))
        rebased = shifted(original)
        return f"{rebased.day} {rebased.strftime('%B')}" if rebased else match.group()

    def month_day(match: re.Match[str]) -> str:
        original = date(anchor.year, _MONTH_NAMES.index(match.group(1)) + 1, int(match.group(2)))
        rebased = shifted(original)
        return f"{rebased.strftime('%B')} {rebased.day}" if rebased else match.group()

    value = re.sub(rf"\b(\d{{1,2}})(st|nd|rd|th)? ({month_pattern})\b", day_month, value)
    value = re.sub(rf"\b({month_pattern}) (\d{{1,2}})\b", month_day, value)
    return value


# Fields whose whole value is a date or timestamp, rather than prose that happens
# to mention one. These shift by the full delta wherever they sit in time; the
# +/-35 day window in `_rebase_text` is for free text only.
#
# WHY THE DISTINCTION MATTERS. The window exists so rebasing does not rewrite a
# date inside authored prose that refers to something real and fixed. Applied to
# structured fields it does something else entirely: it shifts the part of a
# world's history that sits near the anchor and freezes the rest. Measured on the
# larger world, whose mail spans 749 days: 301 of 3,069 messages moved and 2,146
# ended up AFTER the world's own new anchor -- most of the mail in the world's
# future, which is not a world at all.
_DATE_FIELDS = frozenset({
    "sent_at", "timestamp", "occurred_at", "due_on", "issued_on", "start", "end",
    "opened_at", "modified_at", "date", "start_on", "target_on", "anchor",
    # A world that sells to people carries these four as well. They name whole
    # dates for the same reason the ones above do, so they shift the same way.
    "placed_on", "shipped_on", "posted_at", "launched_on",
})


def _rebase_values(value: Any, anchor: date, delta: timedelta, relative_paths: set[tuple[str, ...]], path: tuple[str, ...] = ()) -> Any:
    if isinstance(value, dict):
        return {key: _rebase_values(item, anchor, delta, relative_paths, path + (key,)) for key, item in value.items()}
    if isinstance(value, list):
        return [_rebase_values(item, anchor, delta, relative_paths, path) for item in value]
    relative = any(path[:len(prefix)] == prefix for prefix in relative_paths)
    if not (relative and isinstance(value, str)):
        return value
    if path and path[-1] in _DATE_FIELDS:
        return _shift_date_value(value, delta)
    return _rebase_text(value, anchor, delta)


def _shift_date_value(value: str, delta: timedelta) -> str:
    """Shift one whole-value date or timestamp, wherever it sits in time."""
    try:
        if _ISO_TIMESTAMP.fullmatch(value):
            moved = datetime.fromisoformat(value.replace("Z", "+00:00")) + delta
            return moved.isoformat().replace("+00:00", "Z")
        if _ISO_DATE.fullmatch(value):
            return (date.fromisoformat(value) + delta).isoformat()
    except ValueError:
        return value
    return value


def rebase_world(source: dict[str, Any], target: datetime) -> dict[str, Any]:
    """Move the reviewed scenario to the most recent matching weekday."""
    validate_world(source)
    if target.tzinfo is None:
        raise WorldError("rebase target must include a timezone")
    anchor_at = datetime.fromisoformat(source["clock"]["anchor"].replace("Z", "+00:00"))
    anchor = anchor_at.astimezone(timezone.utc).date()
    target_day = target.astimezone(timezone.utc).date()
    delta = timedelta(days=((target_day - anchor).days // 7) * 7)
    relative_paths = {tuple(path.split(".")) for path in source["clock"]["rebase"]["relative_paths"]}
    rebased = _rebase_values(copy.deepcopy(source), anchor, delta, relative_paths)
    rebased["clock"]["anchor"] = (anchor_at + delta).isoformat().replace("+00:00", "Z")
    validate_world(rebased)

    rebased_anchor = anchor + delta

    # WHAT THIS GUARD IS FOR. Rebasing shifts every relative date by one delta,
    # and a bug once shifted timestamps by two -- mail arrived after the deadline
    # it discussed, and the calendar sat a month out of phase with the ledger.
    # Every individual date still looked plausible, which is why nothing noticed.
    # So the guard checks relationships that must survive any shift, not values.
    #
    # It used to check them by naming `inv-4471` and `event-release-go-no-go`,
    # which are records of ONE world. Any other world raised `StopIteration` from
    # a bare `next()`, so `rebase` could not run at all for it -- which is why the
    # clock anchor has never actually been dynamic.
    for invoice in rebased.get("finance", {}).get("anchor_invoices", []):
        if invoice.get("status") != "open" or "due_on" not in invoice:
            continue
        due = date.fromisoformat(invoice["due_on"])
        _require(
            due > rebased_anchor,
            f"rebase leaves open invoice {invoice['id']} due {due}, on or before the new anchor {rebased_anchor}",
        )

    # An event that was ahead of the world's own now has to stay ahead of it. A
    # release decision, a renewal call or a go-live that rebasing drops into the
    # past turns a world about an upcoming choice into one about a missed one.
    for event in rebased.get("communication", {}).get("calendar_events", []):
        start = event.get("start")
        if not start:
            continue
        original = next(
            (item for item in source["communication"]["calendar_events"] if item["id"] == event["id"]),
            None,
        )
        if original is None:
            continue
        was_ahead = datetime.fromisoformat(original["start"].replace("Z", "+00:00")).date() > anchor
        if not was_ahead:
            continue
        _require(
            datetime.fromisoformat(start.replace("Z", "+00:00")).date() > rebased_anchor,
            f"rebase moves {event['id']} from the world's future into its past",
        )
    return rebased


def _money(cents: int) -> str:
    return f"{cents // 100}.{cents % 100:02d}"


def _person_maps(world: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    people = {person["id"]: person for person in world["people"]}
    organizations = {organization["id"]: organization for organization in world["organizations"]}
    return people, organizations


def _expand_finance(world: dict[str, Any], anchor: date) -> dict[str, list[dict[str, Any]]]:
    finance = world["finance"]
    months = int(finance["history_months"])
    invoices = copy.deepcopy(finance["anchor_invoices"])
    bills: list[dict[str, Any]] = []
    payments: list[dict[str, Any]] = []
    ledger: list[dict[str, Any]] = []

    anchor_ids = {invoice["id"] for invoice in invoices}
    for offset in range(months, 0, -1):
        month = _month_before(anchor, offset)
        for customer in finance["customers"]:
            invoice_id = f"inv-{month:%Y%m}-{customer['id']}"
            if invoice_id in anchor_ids:
                continue
            issued = _date_in_month(month, int(customer.get("invoice_day", 5)))
            due = _date_in_month(_month_before(month, -1), int(customer.get("due_day", 5)))
            amount = int(customer["monthly_amount_cents"])
            invoice = {
                "id": invoice_id,
                "number": f"{month:%y%m}-{customer['number_suffix']}",
                "customer_id": customer["id"],
                "issued_on": _iso_day(issued),
                "due_on": _iso_day(due),
                "amount_cents": amount,
                "currency": finance["currency"],
                "status": "paid",
                "description": customer["service"],
            }
            invoices.append(invoice)
            paid = due
            payments.append(
                {
                    "id": f"pay-{invoice_id}",
                    "invoice_id": invoice_id,
                    "customer_id": customer["id"],
                    "paid_on": _iso_day(paid),
                    "amount_cents": amount,
                    "currency": finance["currency"],
                }
            )
        for supplier in finance["suppliers"]:
            issued = _date_in_month(month, int(supplier.get("bill_day", 12)))
            amount = int(supplier["monthly_amount_cents"])
            bills.append(
                {
                    "id": f"bill-{month:%Y%m}-{supplier['id']}",
                    "supplier_id": supplier["id"],
                    "issued_on": _iso_day(issued),
                    "amount_cents": amount,
                    "currency": finance["currency"],
                    "status": "paid",
                    "description": supplier["service"],
                }
            )

    for invoice in invoices:
        ledger.extend(
            [
                {
                    "id": f"entry-{invoice['id']}-receivable",
                    "record_id": invoice["id"],
                    "date": invoice["issued_on"],
                    "account": "accounts-receivable",
                    "debit_cents": invoice["amount_cents"],
                    "credit_cents": 0,
                },
                {
                    "id": f"entry-{invoice['id']}-revenue",
                    "record_id": invoice["id"],
                    "date": invoice["issued_on"],
                    "account": "subscription-revenue",
                    "debit_cents": 0,
                    "credit_cents": invoice["amount_cents"],
                },
            ]
        )
    for payment in payments:
        ledger.extend(
            [
                {
                    "id": f"entry-{payment['id']}-cash",
                    "record_id": payment["id"],
                    "date": payment["paid_on"],
                    "account": "operating-cash",
                    "debit_cents": payment["amount_cents"],
                    "credit_cents": 0,
                },
                {
                    "id": f"entry-{payment['id']}-receivable",
                    "record_id": payment["id"],
                    "date": payment["paid_on"],
                    "account": "accounts-receivable",
                    "debit_cents": 0,
                    "credit_cents": payment["amount_cents"],
                },
            ]
        )
    for bill in bills:
        ledger.extend(
            [
                {
                    "id": f"entry-{bill['id']}-expense",
                    "record_id": bill["id"],
                    "date": bill["issued_on"],
                    "account": "operating-expense",
                    "debit_cents": bill["amount_cents"],
                    "credit_cents": 0,
                },
                {
                    "id": f"entry-{bill['id']}-cash",
                    "record_id": bill["id"],
                    "date": bill["issued_on"],
                    "account": "operating-cash",
                    "debit_cents": 0,
                    "credit_cents": bill["amount_cents"],
                },
            ]
        )

    return {
        "invoices": sorted(invoices, key=lambda item: (item["issued_on"], item["id"])),
        "bills": sorted(bills, key=lambda item: (item["issued_on"], item["id"])),
        "payments": sorted(payments, key=lambda item: (item["paid_on"], item["id"])),
        "ledger_entries": sorted(ledger, key=lambda item: (item["date"], item["id"])),
    }


def _invoice_mail(world: dict[str, Any], finance: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    people, _ = _person_maps(world)
    customer_map = {customer["id"]: customer for customer in world["finance"]["customers"]}
    sender = people[world["finance"]["billing_owner_id"]]
    result: list[dict[str, Any]] = []
    for invoice in finance["invoices"]:
        customer = customer_map[invoice["customer_id"]]
        contact = people[customer["contact_id"]]
        result.append(
            {
                "id": f"mail-{invoice['id']}",
                "thread_id": f"thread-{invoice['id']}",
                "from_id": sender["id"],
                "to_ids": [contact["id"]],
                "subject": f"Invoice {invoice['number']} — {customer['name']}",
                "snippet": f"{invoice['description']} · {_money(invoice['amount_cents'])} {invoice['currency']}",
                "body_text": (
                    f"Hi {contact['name'].split()[0]},\n\n"
                    f"Invoice {invoice['number']} for {invoice['description']} is attached. "
                    f"The total is {_money(invoice['amount_cents'])} {invoice['currency']}, "
                    f"due {invoice['due_on']}.\n\n{sender['name']}"
                ),
                "sent_at": f"{invoice['issued_on']}T09:15:00Z",
                "labels": ["SENT", "Finance"],
                "invoice_id": invoice["id"],
                "customer_id": customer["id"],
            }
        )
    return result


def _google_projection(world: dict[str, Any], resolved_mail: list[dict[str, Any]]) -> dict[str, Any]:
    people, _ = _person_maps(world)
    primary = next(person for person in world["people"] if person.get("primary"))
    messages: list[dict[str, Any]] = []
    for message in resolved_mail:
        sender = people[message["from_id"]]
        recipients = [people[person_id] for person_id in message["to_ids"]]
        is_primary_sender = sender["id"] == primary["id"]
        is_primary_recipient = any(person["id"] == primary["id"] for person in recipients)
        if not is_primary_sender and not is_primary_recipient:
            continue
        messages.append(
            {
                "id": message["id"],
                "thread_id": message["thread_id"],
                "from": f"{sender['name']} <{sender['email']}>",
                "to": ", ".join(f"{person['name']} <{person['email']}>" for person in recipients),
                "subject": message["subject"],
                "snippet": message["snippet"],
                "body_text": message["body_text"],
                "label_ids": message["labels"],
                "date": message["sent_at"],
                "worldfixture_entity_refs": {
                    key: message[key]
                    for key in ("invoice_id", "customer_id", "order_id")
                    if key in message
                },
            }
        )
    communication = world["communication"]
    return {
        "users": [
            {
                "email": primary["email"],
                "name": primary["name"],
                "email_verified": True,
            }
        ],
        "messages": sorted(messages, key=lambda item: (item["date"], item["id"])),
        "calendars": copy.deepcopy(communication.get("calendars", [])),
        "calendar_events": copy.deepcopy(communication.get("calendar_events", [])),
        "drive_items": copy.deepcopy(communication.get("documents", [])),
    }


def _microsoft_projection(world: dict[str, Any]) -> dict[str, Any]:
    main_org = next(organization for organization in world["organizations"] if organization.get("primary"))
    members = [person for person in world["people"] if person["organization_id"] == main_org["id"]]
    return {
        "users": [
            {
                "email": person["email"],
                "name": person["name"],
                "given_name": person["name"].split(maxsplit=1)[0],
                "family_name": person["name"].split(maxsplit=1)[1],
                "tenant_id": main_org["id"],
                "worldfixture_person_id": person["id"],
            }
            for person in members
        ]
    }


def _notion_uuid(world_id: str, kind: str, source_id: str) -> str:
    """Return a stable, UUID-shaped Notion identifier for one world record."""
    digest = hashlib.sha256(f"worldfixture:notion:{world_id}:{kind}:{source_id}".encode("utf-8")).hexdigest()[:32]
    return f"{digest[:8]}-{digest[8:12]}-4{digest[13:16]}-8{digest[17:20]}-{digest[20:32]}"


def _notion_rich_text(text: str) -> list[dict[str, Any]]:
    return [
        {
            "type": "text",
            "text": {"content": text, "link": None},
            "annotations": {
                "bold": False,
                "italic": False,
                "strikethrough": False,
                "underline": False,
                "code": False,
                "color": "default",
            },
            "plain_text": text,
            "href": None,
        }
    ]


def _notion_projection(world: dict[str, Any]) -> dict[str, Any]:
    people, _ = _person_maps(world)
    main_org = next(organization for organization in world["organizations"] if organization.get("primary"))
    members = [person for person in world["people"] if person["organization_id"] == main_org["id"]]
    def notion_id(kind: str, source_id: str) -> str:
        return _notion_uuid(world["id"], kind, source_id)

    member_ids = {person["id"]: notion_id("user", person["id"]) for person in members}
    teamspace_ids = {person["team"]: notion_id("teamspace", person["team"]) for person in members}
    database_id = notion_id("database", "projects")
    data_source_id = notion_id("data-source", "projects")
    view_id = notion_id("view", "projects-active")
    pages: list[dict[str, Any]] = []
    document_page_ids = {
        document["id"]: notion_id("page", document["id"])
        for document in world["communication"].get("documents", [])
    }
    project_page_ids = {
        project["id"]: notion_id("page", project["id"])
        for project in world["work"].get("projects", [])
    }
    document_upload_ids = {
        document["id"]: notion_id("file-upload", document["id"])
        for document in world["communication"].get("documents", [])
    }

    for document in world["communication"].get("documents", []):
        pages.append(
            {
                "id": document_page_ids[document["id"]],
                "title": document["name"].removesuffix(".md"),
                "children": [
                    {"type": "paragraph", "text": document["content"]},
                    {
                        "type": "file",
                        "file": {
                            "type": "file_upload",
                            "file_upload": {"id": document_upload_ids[document["id"]]},
                            "caption": _notion_rich_text(document["name"]),
                        },
                    },
                ],
                "last_edited_time": document["modified_at"],
                "created_by": member_ids.get(document["owner_id"], next(iter(member_ids.values()))),
                "teamspace_id": teamspace_ids.get(people[document["owner_id"]]["team"]),
                "accessible_by": list(member_ids.values()),
                "is_skill": document["name"].lower().startswith("runbook:"),
                "worldfixture_document_id": document["id"],
                "worldfixture_owner_id": document["owner_id"],
            }
        )

    for project in world["work"].get("projects", []):
        owner = people[project["owner_id"]]
        detail = (
            f"{project['summary']}\n\n"
            f"Status: {project['status']}\n"
            f"Owner: {owner['name']}\n"
            f"Target: {project['target_on']}"
        )
        pages.append(
            {
                "id": project_page_ids[project["id"]],
                "title": project["name"],
                "parent": {"type": "data_source_id", "data_source_id": data_source_id},
                "properties": {
                    "Name": {"id": "title", "type": "title", "title": _notion_rich_text(project["name"])},
                    "Status": {
                        "id": "status",
                        "type": "status",
                        "status": {"id": project["status"], "name": project["status"].replace("-", " ").title(), "color": "default"},
                    },
                    "Owner": {
                        "id": "owner",
                        "type": "people",
                        "people": [{"object": "user", "id": member_ids[project["owner_id"]]}],
                    },
                    "Target": {
                        "id": "target",
                        "type": "date",
                        "date": {"start": project["target_on"], "end": None, "time_zone": None},
                    },
                },
                "created_by": member_ids.get(project["owner_id"], next(iter(member_ids.values()))),
                "teamspace_id": teamspace_ids.get(owner["team"]),
                "accessible_by": list(member_ids.values()),
                "children": [{"type": "paragraph", "text": detail}],
                "worldfixture_project_id": project["id"],
                "worldfixture_owner_id": project["owner_id"],
            }
        )

    comments: list[dict[str, Any]] = []
    page_ids_by_entity = {**document_page_ids, **project_page_ids}
    for channel in world["communication"].get("channels", []):
        for message in channel.get("messages", []):
            references = message.get("entity_refs", {})
            related_id = references.get("document_id") or references.get("project_id")
            if related_id not in page_ids_by_entity or message["author_id"] not in member_ids:
                continue
            comment_id = notion_id("comment", message["id"])
            comments.append(
                {
                    "id": comment_id,
                    "parent": {"type": "page_id", "page_id": page_ids_by_entity[related_id]},
                    "discussion_id": comment_id,
                    "created_time": message["timestamp"],
                    "last_edited_time": message["timestamp"],
                    "created_by": member_ids[message["author_id"]],
                    "rich_text": _notion_rich_text(message["text"]),
                    "display_name": {"type": "user", "resolved_name": people[message["author_id"]]["name"]},
                    "integration_created": False,
                    "worldfixture_message_id": message["id"],
                    "worldfixture_channel_id": channel["id"],
                }
            )

    file_uploads = [
        {
            "id": document_upload_ids[document["id"]],
            "created_time": document["modified_at"],
            "last_edited_time": document["modified_at"],
            "created_by": member_ids[document["owner_id"]],
            "status": "uploaded",
            "mode": "single_part",
            "filename": document["name"],
            "content_type": document["mime_type"],
            "content_length": len(document["content"].encode("utf-8")),
            "number_of_parts": 1,
            "sent_parts": [1],
            "object_bucket": f"{main_org['slug']}-documents",
            "object_key": _document_object_key(document),
            "worldfixture_document_id": document["id"],
            "worldfixture_owner_id": document["owner_id"],
        }
        for document in world["communication"].get("documents", [])
    ]

    people_by_email = {person["email"]: person for person in members}
    meeting_notes: list[dict[str, Any]] = []
    for event in world["communication"].get("calendar_events", []):
        attendees = [
            member_ids[people_by_email[email]["id"]]
            for email in event.get("attendees", [])
            if email in people_by_email
        ]
        if not attendees:
            continue
        page_id = notion_id("page", f"meeting:{event['id']}")
        pages.append(
            {
                "id": page_id,
                "title": event["summary"],
                "children": [{"type": "paragraph", "text": event.get("description", "")}],
                "created_time": event["start"],
                "last_edited_time": event["start"],
                "created_by": attendees[0],
                "accessible_by": attendees,
                "worldfixture_calendar_event_id": event["id"],
            }
        )
        meeting_notes.append(
            {
                "id": notion_id("block", f"meeting-note:{event['id']}"),
                "parent": {"type": "page_id", "page_id": page_id},
                "title": event["summary"],
                "status": "transcription_not_started",
                "calendar_event": {
                    "start_time": event["start"],
                    "end_time": event["end"],
                    "attendees": attendees,
                },
                "created_time": event["start"],
                "last_edited_time": event["start"],
                "created_by": attendees[0],
                "worldfixture_calendar_event_id": event["id"],
            }
        )

    # A world goal is the closest source record to a Notion Custom Agent. Keep
    # ownership private to the declared actor because the world does not state
    # that the agent was shared. All prose below comes directly from the world;
    # in particular, there is no fabricated example answer.
    agentic = world.get("agentic", {})
    actor_id = agentic.get("actor_id")
    agents: list[dict[str, Any]] = []
    if actor_id in member_ids:
        for goal in agentic.get("goals", []):
            instruction_sections = [goal["instructions"]]
            constraints = agentic.get("constraints", [])
            if constraints:
                instruction_sections.append("Constraints:\n" + "\n".join(f"- {item}" for item in constraints))
            success_evidence = goal.get("success_evidence", [])
            if success_evidence:
                instruction_sections.append("Success evidence:\n" + "\n".join(f"- {item}" for item in success_evidence))
            notion_actor_id = member_ids[actor_id]
            agents.append(
                {
                    "id": notion_id("agent", goal["id"]),
                    "name": goal["title"],
                    "description": goal["instructions"],
                    "instructions": "\n\n".join(instruction_sections),
                    "created_by": notion_actor_id,
                    "accessible_by": [notion_actor_id],
                    "editable_by": [notion_actor_id],
                    "default_response": None,
                }
            )

    return {
        "workspace": {"id": notion_id("workspace", main_org["id"]), "name": main_org["name"]},
        "object_store": {
            "bucket": f"{main_org['slug']}-documents",
            "prefix": "notion/uploads",
        },
        "users": [
            {
                "id": notion_id("user", person["id"]),
                "email": person["email"],
                "name": person["name"],
                "worldfixture_person_id": person["id"],
            }
            for person in members
        ],
        "teamspaces": [
            {
                "id": teamspace_id,
                "name": team,
                "member_ids": [member_ids[person["id"]] for person in members if person["team"] == team],
            }
            for team, teamspace_id in sorted(teamspace_ids.items())
        ],
        "databases": [
            {
                "id": database_id,
                "title": "Projects",
                "description": f"Project delivery, ownership, and target dates for {main_org['name']}.",
                "accessible_by": list(member_ids.values()),
            }
        ],
        "data_sources": [
            {
                "id": data_source_id,
                "database_id": database_id,
                "name": "Projects",
                "properties": {
                    "Name": {"type": "title"},
                    "Status": {"type": "status"},
                    "Owner": {"type": "people"},
                    "Target": {"type": "date"},
                },
                "templates": [{"id": notion_id("template", "project"), "name": "Project"}],
                "accessible_by": list(member_ids.values()),
            }
        ],
        "views": [
            {
                "id": view_id,
                "database_id": database_id,
                "data_source_id": data_source_id,
                "name": "Active projects",
                "type": "table",
                "filter": {"property": "Status", "status": {"does_not_equal": "Done"}},
                "sorts": [{"property": "Target", "direction": "ascending"}],
                "configuration": {"display_properties": ["Name", "Status", "Owner", "Target"]},
                "accessible_by": list(member_ids.values()),
            }
        ],
        "pages": pages,
        "meeting_notes": meeting_notes,
        "agents": agents,
        "comments": comments,
        "file_uploads": file_uploads,
    }


def _apple_projection(world: dict[str, Any]) -> dict[str, Any]:
    main_org = next(organization for organization in world["organizations"] if organization.get("primary"))
    members = [person for person in world["people"] if person["organization_id"] == main_org["id"]]
    return {
        "users": [
            {
                "email": person["email"],
                "name": person["name"],
                "given_name": person["name"].split(maxsplit=1)[0],
                "family_name": person["name"].split(maxsplit=1)[1],
                "is_private_email": False,
                "worldfixture_person_id": person["id"],
            }
            for person in members
        ]
    }


def _document_object_key(document: dict[str, Any]) -> str:
    """The S3 key a world document is stored under.

    The id is the key body rather than the name, because a document name is prose
    -- `Lumen renewal brief — working draft.md` carries spaces and an em dash --
    and a key is a path an application and a shell both have to handle. The id is
    already unique, already readable, and already stable across builds. The
    suffix is the name's own, so the extension a reader sees is the world's.
    """
    name = document["name"]
    tail = name.rsplit("/", 1)[-1]
    suffix = tail[tail.rfind(".") :] if "." in tail else ""
    return f"documents/{document['id']}{suffix}"


def _aws_projection(world: dict[str, Any]) -> dict[str, Any]:
    people, _ = _person_maps(world)
    main_org = next(organization for organization in world["organizations"] if organization.get("primary"))
    members = [person for person in world["people"] if person["organization_id"] == main_org["id"]]
    operators = [person for person in members if person.get("primary") or person["team"] == "engineering"][:4]
    documents_bucket = f"{main_org['slug']}-documents"
    # Only documents the world actually declares become objects. The exports
    # bucket stays empty here because no world record declares anything in it.
    objects = sorted(
        (
            {
                "bucket": documents_bucket,
                "key": _document_object_key(document),
                "content_type": document["mime_type"],
                "content": document["content"],
                # The world's own modification time. Never the build clock.
                "last_modified": document["modified_at"],
                # The owner is named the way this projection already names an IAM
                # principal, so an object owner and an IAM user are the same string.
                "owner": people[document["owner_id"]]["github_login"],
                "worldfixture_person_id": document["owner_id"],
                "worldfixture_document_id": document["id"],
            }
            for document in world["communication"].get("documents", [])
        ),
        key=lambda entry: (entry["bucket"], entry["key"]),
    )
    return {
        "region": "eu-west-2",
        "account_id": "000000000000",
        "s3": {
            "buckets": [
                {"name": documents_bucket, "region": "eu-west-2"},
                {"name": f"{main_org['slug']}-exports", "region": "eu-west-2"},
            ],
            "objects": objects,
        },
        "sqs": {
            "queues": [
                {"name": "billing-events", "visibility_timeout": 30},
                {"name": "export-jobs", "visibility_timeout": 120},
                {"name": "export-jobs-dlq", "visibility_timeout": 30},
            ]
        },
        "iam": {
            "users": [
                {"user_name": person["github_login"], "path": "/people/", "create_access_key": False}
                for person in operators
            ],
            "roles": [
                {"role_name": "billing-webhook", "path": "/services/", "description": "Receives billing events"},
                {"role_name": "export-worker", "path": "/services/", "description": "Processes customer exports"},
            ],
        },
        "worldfixture_organization_id": main_org["id"],
    }


def _resend_projection(world: dict[str, Any]) -> dict[str, Any]:
    people, _ = _person_maps(world)
    main_org = next(organization for organization in world["organizations"] if organization.get("primary"))
    contacts = []
    for customer in world["finance"]["customers"]:
        person = people[customer["contact_id"]]
        contacts.append(
            {
                "email": person["email"],
                "first_name": person["name"].split(maxsplit=1)[0],
                "last_name": person["name"].split(maxsplit=1)[1],
                "audience": "Customers",
                "worldfixture_person_id": person["id"],
                "worldfixture_customer_id": customer["id"],
            }
        )
    return {
        "domains": [{"name": main_org["domain"], "region": "eu-west-1"}],
        "contacts": contacts,
    }


# The names below belong to `business.saas-company`, which was the only world
# when these projections were written. A second world inherits them unless it
# says otherwise, which is why each one is now a declared value with the
# reviewed literal as its default: a world may own its Slack bot, its issue
# tracker team and its database without changing the parity fixture's bytes.
LEGACY_SLACK_BOTS = [{"name": "northstar-helper"}]
LEGACY_TRACKER_TEAM = {"key": "NSTAR", "name": "Northstar"}
LEGACY_DATABASE = {
    "cluster": "northstar-production",
    "name": "northstar",
    "collections": ["customers", "invoices", "support_cases", "tasks"],
}


def _mongoatlas_projection(world: dict[str, Any]) -> dict[str, Any]:
    main_org = next(organization for organization in world["organizations"] if organization.get("primary"))
    primary = next(person for person in world["people"] if person.get("primary"))
    database = world.get("software", {}).get("database") or LEGACY_DATABASE
    return {
        "projects": [{"name": main_org["name"], "org_id": main_org["id"]}],
        "clusters": [
            {
                "name": database["cluster"],
                "project": main_org["name"],
                "provider": "AWS",
                "instance_size": "M10",
                "region": "EU_WEST_2",
                "disk_size_gb": 20,
                "mongodb_version": "8.0",
            }
        ],
        "database_users": [
            {
                "username": primary["github_login"],
                "project": main_org["name"],
                "roles": [{"database_name": database["name"], "role_name": "readWrite"}],
            }
        ],
        "databases": [
            {
                "cluster": database["cluster"],
                "name": database["name"],
                "collections": list(database["collections"]),
            }
        ],
        "worldfixture_organization_id": main_org["id"],
    }


def _twilio_projection(world: dict[str, Any]) -> dict[str, Any]:
    main_org = next(organization for organization in world["organizations"] if organization.get("primary"))
    return {
        "account": {
            "sid": "AC00000000000000000000000000000000",
            "auth_token": "worldfixture_twilio_test_token",
            "friendly_name": main_org["name"],
        },
        "api_keys": [
            {
                "sid": "SK00000000000000000000000000000000",
                "secret": "twilio_test_api_secret",
                "friendly_name": f"{main_org['name']} application",
            }
        ],
        "phone_numbers": [
            {"phone_number": "+15550102028", "friendly_name": f"{main_org['name']} Support"}
        ],
        "messaging_services": [
            {"friendly_name": f"{main_org['name']} Notifications", "phone_numbers": ["+15550102028"]}
        ],
        "verify_services": [
            {"friendly_name": f"{main_org['name']} Sign-in", "code": "123456", "default_channel": "sms"}
        ],
        "conversations": {"services": [{"friendly_name": f"{main_org['name']} Support"}]},
        "worldfixture_organization_id": main_org["id"],
    }


def _slack_projection(world: dict[str, Any]) -> dict[str, Any]:
    people, organizations = _person_maps(world)
    main_org = next(organization for organization in world["organizations"] if organization.get("primary"))
    users = []
    for person in world["people"]:
        if person["organization_id"] != main_org["id"]:
            continue
        users.append(
            {
                "id": person["slack_id"],
                "name": person["github_login"],
                "real_name": person["name"],
                "email": person["email"],
                "profile": {"title": person["role"], "status_text": person.get("status", ""), "status_emoji": person.get("status_emoji", "")},
                "presence": "active" if person.get("primary") else "away",
                "worldfixture_person_id": person["id"],
            }
        )
    channels = []
    for channel in world["communication"]["channels"]:
        channels.append(
            {
                "id": channel["id"],
                "name": channel["name"],
                "topic": channel["topic"],
                "member_ids": [people[person_id]["slack_id"] for person_id in channel["member_ids"]],
                "messages": [
                    {
                        "id": message["id"],
                        "user": people[message["author_id"]]["slack_id"],
                        "text": message["text"],
                        "timestamp": message["timestamp"],
                        "worldfixture_entity_refs": copy.deepcopy(message.get("entity_refs", {})),
                    }
                    for message in channel.get("messages", [])
                ],
            }
        )
    return {
        "team": {"name": main_org["name"], "domain": main_org["domain"].split(".", 1)[0]},
        "users": users,
        "channels": channels,
        "bots": copy.deepcopy(world["communication"].get("bots") or LEGACY_SLACK_BOTS),
        "strict_scopes": False,
    }


def _github_projection(world: dict[str, Any]) -> dict[str, Any]:
    people, organizations = _person_maps(world)
    main_org = next(organization for organization in world["organizations"] if organization.get("primary"))
    members = [person for person in world["people"] if person["organization_id"] == main_org["id"]]
    users = [
        {
            "login": person["github_login"],
            "name": person["name"],
            "email": person["email"],
            "bio": person["role"],
            "company": main_org["name"],
            "location": person.get("location", "Remote"),
            "worldfixture_person_id": person["id"],
        }
        for person in members
    ]
    repos = []
    for repository in world["software"]["repositories"]:
        owner = organizations[repository["owner_id"]]
        repos.append(
            {
                "id": repository["id"],
                "owner": owner["slug"],
                "name": repository["name"],
                "description": repository["description"],
                "language": repository["language"],
                "topics": repository["topics"],
                "auto_init": True,
                "issues": copy.deepcopy(repository.get("issues", [])),
            }
        )
    return {
        "users": users,
        "orgs": [{"login": main_org["slug"], "name": main_org["name"], "description": main_org["summary"]}],
        "repos": repos,
    }


def _clerk_projection(world: dict[str, Any]) -> dict[str, Any]:
    main_org = next(organization for organization in world["organizations"] if organization.get("primary"))
    members = [person for person in world["people"] if person["organization_id"] == main_org["id"]]
    return {
        "users": [
            {
                "first_name": person["name"].split(maxsplit=1)[0],
                "last_name": person["name"].split(maxsplit=1)[1],
                "email_addresses": [person["email"]],
                "password": "worldfixture_test_password",
                "worldfixture_person_id": person["id"],
            }
            for person in members
        ],
        "organizations": [
            {
                "name": main_org["name"],
                "slug": main_org["slug"],
                "members": [
                    {
                        "email": person["email"],
                        "role": "admin" if person.get("primary") else "member",
                        "worldfixture_person_id": person["id"],
                    }
                    for person in members
                ],
                "worldfixture_organization_id": main_org["id"],
            }
        ],
    }


def _okta_projection(world: dict[str, Any]) -> dict[str, Any]:
    main_org = next(organization for organization in world["organizations"] if organization.get("primary"))
    members = [person for person in world["people"] if person["organization_id"] == main_org["id"]]
    groups = [
        {"name": "Everyone", "description": f"All {main_org['name']} people", "type": "BUILT_IN", "okta_id": "00g_everyone"}
    ]
    # An Okta group id needs a short, stable, world-owned prefix. The first
    # label of the organization slug is that: it reproduces the reviewed
    # `00g_northstar_NN` ids for `northstar-relay` and gives every other world
    # its own, instead of filing a second company's people under the first's.
    prefix = main_org["slug"].split("-")[0]
    for index, team in enumerate(sorted({person["team"] for person in members}), start=1):
        groups.append(
            {
                "name": team.replace("-", " ").title(),
                "description": f"{main_org['name']} {team.replace('-', ' ')} team",
                "type": "OKTA_GROUP",
                "okta_id": f"00g_{prefix}_{index:02d}",
            }
        )
    return {
        "users": [
            {
                "login": person["email"],
                "email": person["email"],
                "first_name": person["name"].split(maxsplit=1)[0],
                "last_name": person["name"].split(maxsplit=1)[1],
                "worldfixture_person_id": person["id"],
            }
            for person in members
        ],
        "groups": groups,
    }


def _linear_projection(world: dict[str, Any]) -> dict[str, Any]:
    people, _ = _person_maps(world)
    main_org = next(organization for organization in world["organizations"] if organization.get("primary"))
    members = [person for person in world["people"] if person["organization_id"] == main_org["id"]]
    projects = {project["id"]: project for project in world["work"]["projects"]}
    team = world.get("work", {}).get("team") or LEGACY_TRACKER_TEAM
    state_names = {
        "backlog": "Backlog",
        "ready": "Todo",
        "in-progress": "In Progress",
        "review": "In Progress",
        "blocked": "In Progress",
        "done": "Done",
    }
    label_names = sorted({label for task in world["work"]["tasks"] for label in task.get("labels", [])} | {"blocked", "urgent"})
    palette = ["#2563eb", "#7c3aed", "#0891b2", "#059669", "#ca8a04", "#ea580c", "#dc2626"]
    issues = []
    for task in world["work"]["tasks"]:
        labels = list(task.get("labels", []))
        if task["status"] == "blocked" and "blocked" not in labels:
            labels.append("blocked")
        if task["priority"] == "urgent" and "urgent" not in labels:
            labels.append("urgent")
        project = projects[task["project_id"]]
        issues.append(
            {
                "team": team["key"],
                "title": task["title"],
                "description": f"{task['description']}\n\nProject: {project['name']} · Due: {task['due_on']}",
                "state": state_names[task["status"]],
                "assignee": people[task["assignee_id"]]["email"],
                "labels": labels,
                "worldfixture_task_id": task["id"],
                "worldfixture_project_id": project["id"],
            }
        )
    return {
        "organization": {"name": main_org["name"], "url_key": main_org["slug"]},
        "users": [
            {
                "email": person["email"],
                "name": person["name"],
                "admin": bool(person.get("primary")),
                "worldfixture_person_id": person["id"],
            }
            for person in members
        ],
        "teams": [
            {
                "key": team["key"],
                "name": team["name"],
                "states": [
                    {"name": "Backlog", "type": "backlog"},
                    {"name": "Todo", "type": "unstarted"},
                    {"name": "In Progress", "type": "started"},
                    {"name": "Done", "type": "completed"},
                ],
            }
        ],
        "labels": [
            {"name": name, "color": palette[index % len(palette)], "team": team["key"]}
            for index, name in enumerate(label_names)
        ],
        "issues": issues,
        "strict_scopes": False,
    }


def _stripe_projection(world: dict[str, Any]) -> dict[str, Any]:
    """Project the billing relationships, and the catalog when a world has one.

    A world that bills companies has one product per plan and one price per
    customer, which is what this always projected. A world that sells goods to
    people has a catalog as well, and a catalog item is a Stripe product with a
    one-off price -- the same two record types, not a parallel set. A world with
    no `commerce.products` produces byte-identical output to before.
    """
    people, _ = _person_maps(world)
    customers = world["finance"]["customers"]
    plans = sorted({customer["service"] for customer in customers})
    catalog = world.get("commerce", {}).get("products", [])
    for product in catalog:
        _require(
            product["name"] not in plans,
            f"catalog product {product['id']} is named after subscription plan {product['name']!r}",
        )
    return {
        "customers": [
            {
                "email": people[customer["contact_id"]]["email"],
                "name": customer["name"],
                "worldfixture_customer_id": customer["id"],
            }
            for customer in customers
        ],
        "products": [{"name": name, "description": f"Monthly {name} subscription"} for name in plans]
        + [
            {
                "name": product["name"],
                "description": product.get("summary", product["name"]),
                "worldfixture_product_id": product["id"],
            }
            for product in catalog
        ],
        "prices": [
            {
                "product_name": customer["service"],
                "currency": "usd",
                "unit_amount": customer["monthly_amount_cents"],
                "worldfixture_customer_id": customer["id"],
            }
            for customer in customers
        ]
        + [
            {
                "product_name": product["name"],
                "currency": str(product.get("currency", "USD")).lower(),
                "unit_amount": product["price_cents"],
                "worldfixture_product_id": product["id"],
            }
            for product in catalog
        ],
    }


def _web_repository(world: dict[str, Any]) -> dict[str, Any]:
    """The repository that holds the company's own web front end.

    This used to be `next(... if repository["name"] == "web-console")`, which is
    a literal from one world, and a world without a repository of that exact name
    crashed the compiler with `StopIteration` rather than a `WorldError`: an
    unhandled Python exception, raised from a projection, for world data the
    schema allows. Selecting on a declared topic keeps the same answer for that
    world and gives every other world a rule it can satisfy.
    """
    repositories = world.get("software", {}).get("repositories", [])
    # A selection may leave a world with no software at all. That world has no web
    # deployment, which is a fact about it rather than an error, so the caller
    # omits the projection instead of inventing one.
    if not repositories:
        return None
    for repository in repositories:
        if "web" in repository.get("topics", []):
            return repository
    for repository in repositories:
        if "console" in repository["name"] or "web" in repository["name"]:
            return repository
    return repositories[0]


def _vercel_projection(world: dict[str, Any]) -> dict[str, Any] | None:
    main_org = next(organization for organization in world["organizations"] if organization.get("primary"))
    primary = next(person for person in world["people"] if person.get("primary"))
    web = _web_repository(world)
    if web is None:
        return None
    return {
        "users": [
            {
                "username": primary["github_login"],
                "name": primary["name"],
                "email": primary["email"],
                "worldfixture_person_id": primary["id"],
            }
        ],
        "teams": [
            {
                "slug": main_org["slug"],
                "name": main_org["name"],
                "worldfixture_organization_id": main_org["id"],
            }
        ],
        "projects": [
            {
                "name": web["name"],
                "team": main_org["slug"],
                "framework": "nextjs",
                "worldfixture_repository_id": web["id"],
            }
        ],
    }


def _mail_projection(world: dict[str, Any], resolved_mail: list[dict[str, Any]]) -> dict[str, Any]:
    people, _ = _person_maps(world)
    return {
        "users": [
            {
                "id": person["id"],
                "name": person["name"],
                "email": person["email"],
                "login": person["email"],
                "password_ref": f"mail-password:{person['id']}",
                "folders": ["INBOX", "Archive", "Drafts", "Sent", "Trash"],
            }
            for person in world["people"]
        ],
        "messages": [
            {
                **copy.deepcopy(message),
                "from": people[message["from_id"]]["email"],
                "to": [people[person_id]["email"] for person_id in message["to_ids"]],
            }
            for message in resolved_mail
        ],
    }


def _model_projection(world: dict[str, Any], finance: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    people, organizations = _person_maps(world)
    anchor_invoices = {invoice["id"]: invoice for invoice in finance["invoices"] if invoice["id"] in {item["id"] for item in world["finance"]["anchor_invoices"]}}
    return {
        "world_id": world["id"],
        "title": world["title"],
        "people": [{"id": person["id"], "name": person["name"], "role": person["role"], "organization": organizations[person["organization_id"]]["name"]} for person in people.values()],
        "organizations": [{"id": organization["id"], "name": organization["name"], "summary": organization["summary"]} for organization in organizations.values()],
        "facts": [
            {
                "id": invoice["id"],
                "kind": "invoice",
                "text": f"Invoice {invoice['number']} is {_money(invoice['amount_cents'])} {invoice['currency']} and is {invoice['status']}.",
            }
            for invoice in anchor_invoices.values()
        ]
        + copy.deepcopy(world.get("model_facts", [])),
        "stories": copy.deepcopy(world.get("stories", [])),
    }


def _agent_projection(world: dict[str, Any], finance: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    people, organizations = _person_maps(world)
    agentic = world.get("agentic", {})
    actor_id = agentic.get("actor_id")
    # A KeyError on `None` told the author nothing. This profile projects an
    # agent world, so a world that declares the profile owes it an actor.
    _require(actor_id in people, f"agentic.actor_id must name a person in this world, not {actor_id!r}")
    actor = people[actor_id]
    invoice_map = {invoice["id"]: invoice for invoice in finance["invoices"]}
    grounding = []
    for reference in agentic.get("grounding", []):
        kind = reference["kind"]
        entity_id = reference["entity_id"]
        known = {"person": people, "organization": organizations, "invoice": invoice_map}.get(kind)
        if known is not None:
            _require(
                entity_id in known,
                f"agentic.grounding names {kind} {entity_id!r}, which this world does not have",
            )
            entity = known[entity_id]
        else:
            entity = reference.get("fact", {})
        grounding.append({"kind": kind, "entity_id": entity_id, "value": copy.deepcopy(entity)})
    return {
        "api_version": "worldfixture.agent-world/v1",
        "world_id": world["id"],
        "actor": {
            "id": actor["id"],
            "name": actor["name"],
            "role": actor["role"],
            "organization": organizations[actor["organization_id"]]["name"],
        },
        "goals": copy.deepcopy(agentic.get("goals", [])),
        "capabilities": copy.deepcopy(agentic.get("capabilities", [])),
        "constraints": copy.deepcopy(agentic.get("constraints", [])),
        "grounding": grounding,
        "stories": copy.deepcopy(world.get("stories", [])),
        "causal_rules": copy.deepcopy(agentic.get("causal_rules", [])),
        "timeline": copy.deepcopy(world["timeline"]),
        "synthetic_notice": world["synthetic_notice"],
    }


def _arrival_projection(world: dict[str, Any]) -> list[dict[str, Any]]:
    people, _ = _person_maps(world)
    arrivals = []
    for event in world["timeline"]:
        if event["kind"] != "incoming-email":
            continue
        payload = event["payload"]
        sender = people[payload["from_id"]]
        recipient = people[payload["to_id"]]
        arrivals.append(
            {
                "after_seconds": event["after_seconds"],
                "message": {
                    "id": event["id"],
                    "thread_id": payload.get("thread_id", f"thread-{event['id']}"),
                    "from": f"{sender['name']} <{sender['email']}>",
                    "to": recipient["email"],
                    "subject": payload["subject"],
                    "snippet": payload["snippet"],
                    "body_text": payload["body_text"],
                    "label_ids": payload.get("labels", ["INBOX", "UNREAD"]),
                },
            }
        )
    return arrivals


def _metric_value(source: dict[str, Any], world: dict[str, Any], finance: dict[str, list[dict[str, Any]]]) -> int:
    """Resolve one declared metric against the world, rather than against a literal.

    A world states what a gauge counts; the compiler counts it. A literal value
    in the world file would go stale the moment a record was added.
    """
    kind = source.get("count")
    if kind == "open_support_cases":
        return len([case for case in world.get("support", {}).get("cases", []) if case.get("state") != "resolved"])
    if kind == "open_issues_with_label":
        label = source["label"]
        return len(
            [
                issue
                for repository in world.get("software", {}).get("repositories", [])
                for issue in repository.get("issues", [])
                if issue.get("state") == "open" and label in issue.get("labels", [])
            ]
        )
    if kind == "open_invoice_cents":
        return sum(
            invoice["amount_cents"] for invoice in finance["invoices"] if invoice.get("status") == "open"
        )
    if kind == "overdue_invoice_cents":
        return sum(
            invoice["amount_cents"] for invoice in finance["invoices"] if invoice.get("status") == "overdue"
        )
    if kind == "people":
        return len(world.get("people", []))
    if kind == "orders":
        status = source.get("status")
        return len(
            [
                order
                for order in world.get("commerce", {}).get("orders", [])
                if status is None or order.get("status") == status
            ]
        )
    if kind == "order_value_cents":
        status = source.get("status")
        return sum(
            int(order["total_cents"])
            for order in world.get("commerce", {}).get("orders", [])
            if status is None or order.get("status") == status
        )
    if kind == "products":
        status = source.get("status")
        return len(
            [
                product
                for product in world.get("commerce", {}).get("products", [])
                if status is None or product.get("status") == status
            ]
        )
    if kind == "reviews":
        minimum = source.get("min_rating")
        return len(
            [
                review
                for review in world.get("social", {}).get("reviews", [])
                if minimum is None or int(review.get("rating", 0)) >= int(minimum)
            ]
        )
    if kind == "literal":
        return int(source["value"])
    raise WorldError(f"unsupported site metric source: {kind!r}")


def _http_targets_from_site(
    world: dict[str, Any], finance: dict[str, list[dict[str, Any]]], site: dict[str, Any]
) -> dict[str, Any]:
    """Build the HTTP targets a world declares for itself."""
    organization = next(item for item in world["organizations"] if item.get("primary"))
    timeline = {event["id"]: event for event in world.get("timeline", [])}

    items = []
    for item in site.get("feed", {}).get("items", []):
        entry = {key: value for key, value in item.items() if key != "arrival_id"}
        arrival_id = item.get("arrival_id")
        if arrival_id is not None:
            _require(arrival_id in timeline, f"site feed item {item['id']} names unknown arrival {arrival_id}")
            # The page appears when the arrival that justifies it does, so a
            # reader who refreshes during a run sees the site change with the world.
            entry["available_after_seconds"] = timeline[arrival_id]["after_seconds"]
        items.append(entry)

    api_responses = {
        "/api/v1/company": {
            "id": organization["id"],
            "name": organization["name"],
            "summary": organization["summary"],
            "synthetic": True,
        },
        "/api/v1/stories": {
            "items": copy.deepcopy(world.get("stories", [])),
            "count": len(world.get("stories", [])),
        },
        "/api/v1/status": copy.deepcopy(site["status"]),
    }
    summaries = {
        "/api/v1/company": "Get the synthetic company",
        "/api/v1/stories": "List active company stories",
        "/api/v1/status": "Get the current service status",
    }

    return {
        "api_version": "worldfixture.http-targets/v1",
        "world_id": world["id"],
        "world_version": world["version"],
        "synthetic_notice": world["synthetic_notice"],
        "organization": {
            "id": organization["id"],
            "name": organization["name"],
            "summary": organization["summary"],
        },
        "feeds": [
            {
                "path": site["feed"]["path"],
                "title": site["feed"]["title"],
                "description": site["feed"]["description"],
                "items": items,
            }
        ],
        "pages": copy.deepcopy(site["pages"]),
        "probes": copy.deepcopy(site["probes"]),
        "metrics": [
            {
                "name": metric["name"],
                "help": metric["help"],
                "type": metric.get("type", "gauge"),
                "value": _metric_value(metric["source"], world, finance),
            }
            for metric in site.get("metrics", [])
        ],
        "api": {
            "openapi_path": site.get("openapi_path", "/openapi.json"),
            "responses": api_responses,
            "document": {
                "openapi": "3.0.3",
                "info": {
                    "title": f"{organization['name']} synthetic API",
                    "version": world["version"],
                    "description": world["synthetic_notice"],
                },
                "paths": {
                    path: {
                        "get": {
                            "summary": summaries[path],
                            "responses": {
                                "200": {
                                    "description": "Successful response",
                                    "content": {"application/json": {"example": copy.deepcopy(response)}},
                                }
                            },
                        }
                    }
                    for path, response in api_responses.items()
                },
            },
        },
    }


def _http_targets_projection(
    world: dict[str, Any], finance: dict[str, list[dict[str, Any]]]
) -> dict[str, Any]:
    """Build planted HTTP targets from the same reviewed company story.

    TWO PATHS, AND WHY BOTH EXIST. A world may declare a `site` block, in which
    case the pages, feed items, probes and metrics come from the world -- which
    is where they belong, and what lets a second world have a different site
    without editing this file.

    A world that declares none keeps the path below. That path reads one world's
    story ids, one world's invoice number and one world's arrival ids, and it
    cannot serve any other world. It is kept, unchanged, for exactly one reason:
    `business.saas-company:v2` is the parity fixture, and its artifact bytes are
    the evidence that this extraction reproduces the original world. Rewriting
    the code that produces those bytes would destroy the evidence in order to
    tidy the code. New worlds declare a `site`; v2 does not, and stays byte-identical.
    """
    site = world.get("site")
    if site is not None:
        return _http_targets_from_site(world, finance, site)

    organization = next(item for item in world["organizations"] if item.get("primary"))
    stories = {item["id"]: item for item in world["stories"]}
    support_cases = world["support"]["cases"]
    release_issues = [
        issue
        for repository in world["software"]["repositories"]
        for issue in repository["issues"]
        if "release-2.8" in issue["labels"] and issue["state"] == "open"
    ]
    invoice = next(item for item in finance["invoices"] if item["id"] == "inv-4471")
    lumen = stories["story-lumen-renewal"]
    release = stories["story-release-28"]
    onboarding = stories["story-theo-onboarding"]
    timeline = {item["id"]: item for item in world["timeline"]}
    priya_arrival = timeline["arrival-priya-sample-result"]
    lucas_arrival = timeline["arrival-lucas-load-test"]
    payment_arrival = timeline["arrival-lumen-payment"]
    priya_update = priya_arrival["payload"]
    lucas_update = lucas_arrival["payload"]

    api_responses = {
        "/api/v1/company": {
            "id": organization["id"],
            "name": organization["name"],
            "summary": organization["summary"],
            "synthetic": True,
        },
        "/api/v1/stories": {
            "items": copy.deepcopy(world["stories"]),
            "count": len(world["stories"]),
        },
        "/api/v1/status": {
            "status": "degraded",
            "incident": "Scheduled exports above 50,000 rows can exceed the worker limit.",
            "workaround": "Use an interactive retry while cancellation testing continues.",
            "issue": 318,
        },
    }
    summaries = {
        "/api/v1/company": "Get the synthetic company",
        "/api/v1/stories": "List active company stories",
        "/api/v1/status": "Get the current service status",
    }
    openapi_paths = {
        path: {
            "get": {
                "summary": summaries[path],
                "responses": {
                    "200": {
                        "description": "Successful response",
                        "content": {"application/json": {"example": copy.deepcopy(response)}},
                    }
                },
            }
        }
        for path, response in api_responses.items()
    }

    return {
        "api_version": "worldfixture.http-targets/v1",
        "world_id": world["id"],
        "world_version": world["version"],
        "synthetic_notice": world["synthetic_notice"],
        "organization": {
            "id": organization["id"],
            "name": organization["name"],
            "summary": organization["summary"],
        },
        "feeds": [
            {
                "path": "/feeds/company.xml",
                "title": f"{organization['name']} operating notes",
                "description": "Release, customer, and company updates from the synthetic Northstar world.",
                "items": [
                    {
                        "id": "feed-release-28",
                        "path": "/notes/release-2-8",
                        "title": release["title"],
                        "summary": release["summary"],
                        "published_at": "2026-08-21T08:15:00Z",
                    },
                    {
                        "id": "feed-lumen-export",
                        "path": "/notes/lumen-export",
                        "title": lumen["title"],
                        "summary": lumen["summary"],
                        "published_at": "2026-08-20T14:30:00Z",
                    },
                    {
                        "id": "feed-theo-onboarding",
                        "path": "/notes/theo-onboarding",
                        "title": onboarding["title"],
                        "summary": onboarding["summary"],
                        "published_at": "2026-08-19T15:42:00Z",
                    },
                    {
                        "id": "feed-arrival-priya-sample-result",
                        "path": "/notes/lumen-export",
                        "title": "A fresh Lumen sample confirms the scheduled-path boundary",
                        "summary": priya_update["snippet"],
                        "published_at": "2026-08-22T07:30:10Z",
                        "available_after_seconds": priya_arrival["after_seconds"],
                    },
                    {
                        "id": "feed-arrival-lucas-load-test",
                        "path": "/notes/release-2-8",
                        "title": "Cancellation cleanup still blocks release 2.8",
                        "summary": lucas_update["text"],
                        "published_at": "2026-08-22T07:30:20Z",
                        "available_after_seconds": lucas_arrival["after_seconds"],
                    },
                    {
                        "id": "feed-arrival-lumen-payment",
                        "path": "/notes/lumen-export",
                        "title": "Lumen invoice 4471 is paid",
                        "summary": "A synthetic payment event closed the open August invoice while the export incident remains active.",
                        "published_at": "2026-08-22T07:30:30Z",
                        "available_after_seconds": payment_arrival["after_seconds"],
                    },
                ],
            }
        ],
        "pages": [
            {
                "path": "/",
                "title": organization["name"],
                "heading": "Operational data exports with an audit trail",
                "summary": organization["summary"],
                "sections": [
                    {"heading": "Current work", "body": release["summary"]},
                    {"heading": "Customer focus", "body": lumen["summary"]},
                ],
            },
            {
                "path": "/notes/release-2-8",
                "title": release["title"],
                "heading": "Release 2.8 readiness",
                "summary": release["summary"],
                "sections": [
                    {
                        "heading": "Exit criteria",
                        "body": "Run the 50k, 75k, and cancelled-job cases before merge.",
                    }
                ],
            },
            {
                "path": "/notes/lumen-export",
                "title": lumen["title"],
                "heading": "Scheduled export incident",
                "summary": lumen["summary"],
                "sections": [
                    {
                        "heading": "Billing context",
                        "body": f"Invoice {invoice['number']} is open for {_money(invoice['amount_cents'])} {invoice['currency']} and is not overdue.",
                    }
                ],
                "request_variants": [
                    "The scheduled path still uses the legacy two-minute worker limit.",
                    "The timeout source is isolated. The 75k and cancellation tests are still pending.",
                ],
            },
            {
                "path": "/notes/theo-onboarding",
                "title": onboarding["title"],
                "heading": "Theo's first week",
                "summary": onboarding["summary"],
                "sections": [
                    {"heading": "Open item", "body": "Staging access still needs an owner."}
                ],
            },
        ],
        "probes": [
            {
                "path": "/health/api",
                "name": "Public API",
                "mode": "stable",
                "statuses": [200],
                "body": "ok",
            },
            {
                "path": "/health/export-worker",
                "name": "Scheduled export worker",
                "mode": "failing",
                "statuses": [503],
                "body": "degraded: scheduled exports above 50,000 rows can time out",
            },
            {
                "path": "/health/webhook-delivery",
                "name": "Webhook delivery",
                "mode": "flapping",
                "statuses": [200, 200, 503, 200],
                "body": "request-sequenced synthetic health",
            },
        ],
        "metrics": [
            {
                "name": "northstar_support_cases_open",
                "help": "Open support cases in the synthetic Northstar world.",
                "type": "gauge",
                "value": len(support_cases),
            },
            {
                "name": "northstar_release_blockers",
                "help": "Open issues that block release 2.8.",
                "type": "gauge",
                "value": len(release_issues),
            },
            {
                "name": "northstar_lumen_invoice_cents",
                "help": "Open Lumen invoice value in cents.",
                "type": "gauge",
                "value": invoice["amount_cents"],
            },
        ],
        "api": {
            "openapi_path": "/openapi.json",
            "responses": api_responses,
            "document": {
                "openapi": "3.0.3",
                "info": {
                    "title": f"{organization['name']} synthetic operations API",
                    "version": "1.0.0",
                    "description": world["synthetic_notice"],
                },
                "paths": openapi_paths,
            },
        },
    }


def _canonical_packs(
    world: dict[str, Any],
    finance: dict[str, list[dict[str, Any]]],
    resolved_mail: list[dict[str, Any]],
) -> dict[str, Any]:
    """Return vendor-neutral records for fixture and application adapters.

    An optional domain appears only when the world declares it. A pack file that
    exists but is empty would tell a connector that this world has a catalog and
    that the catalog is empty, which is a different claim from having none.
    """
    packs = {
        "identity": {
            "organizations": copy.deepcopy(world["organizations"]),
            "people": copy.deepcopy(world["people"]),
        },
        "communication": {
            **copy.deepcopy(world["communication"]),
            "mail": copy.deepcopy(resolved_mail),
        },
        # The accounts, not only the documents.
        #
        # `finance` here is the PROJECTION -- invoices, bills, payments and the
        # ledger it derives. Every one of those carries a `customer_id` or a
        # `supplier_id`, and until this line those keys pointed at nothing a
        # connector could see: the customers and suppliers they name live in the
        # world source and were never exported. A connector receiving
        # `invoice.customer_id = "lumen"` had an opaque string, no name for it,
        # no billing terms and no way to reach `lumen-labs` in `identity`, and
        # the only thing it could do with an invoice was drop the customer.
        #
        # These records carry `organization_id`, so exporting them closes the
        # chain: invoice -> customer -> organization.
        "finance": {
            **copy.deepcopy(finance),
            "customers": copy.deepcopy(world["finance"].get("customers", [])),
            "suppliers": copy.deepcopy(world["finance"].get("suppliers", [])),
        },
        "software": copy.deepcopy(world["software"]),
        "support": copy.deepcopy(world["support"]),
        "work": copy.deepcopy(world.get("work", {"projects": [], "tasks": [], "time_entries": []})),
    }
    for name in ("commerce", "social"):
        if world.get(name):
            packs[name] = copy.deepcopy(world[name])
    return packs


def _slack_ts(timestamp: str, sequence: int) -> str:
    """Render one authored time as a Slack `ts`.

    Slack orders a channel by this value, so it has to be derived from the
    authored time rather than from the clock at seed time. The sequence keeps two
    messages in the same second distinct and ordered.
    """
    when = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    return f"{int(when.timestamp())}.{sequence:06d}"


def _emulator_slack_channels(slack: dict[str, Any]) -> list[dict[str, Any]]:
    """Project channels and their authored history for the Slack emulator.

    The emulator mints its own user ids when it seeds and matches a user by
    name, so a message author is named, not given the world's canonical
    `slack_id`. `SlackSeedConfig` has no message field; the composer inserts
    these through the emulator's public store after seeding.
    """
    name_by_id = {user["id"]: user["name"] for user in slack["users"]}
    channels = []
    for channel in slack["channels"]:
        messages = []
        for sequence, message in enumerate(channel.get("messages", []), start=1):
            author = name_by_id.get(message["user"])
            if author is None:
                continue
            messages.append(
                {
                    "user": author,
                    "text": message["text"],
                    "ts": _slack_ts(message["timestamp"], sequence),
                }
            )
        channels.append(
            {
                "name": channel["name"],
                "topic": channel["topic"],
                # Upstream seeding puts every user in every channel, which erases
                # the world's own membership and ungates every read. Members are
                # named, like message authors, because the emulator mints its own
                # ids and matches a user by name.
                "members": [name_by_id[member] for member in channel.get("member_ids", []) if member in name_by_id],
                "messages": messages,
            }
        )
    return channels


# ---------------------------------------------------------------------------
# Selecting part of a world
# ---------------------------------------------------------------------------

# The vendor-neutral domains a world is made of, and what each one owns in the
# source. `_canonical_packs` projects exactly these.
PACK_SOURCES: dict[str, list[tuple[str, ...]]] = {
    "identity": [("organizations",), ("people",)],
    "communication": [("communication", "channels"), ("communication", "mail"),
                      ("communication", "documents"), ("communication", "calendars"),
                      ("communication", "calendar_events")],
    "finance": [("finance", "customers"), ("finance", "suppliers"), ("finance", "anchor_invoices")],
    "software": [("software", "repositories")],
    "support": [("support", "cases")],
    "work": [("work", "projects"), ("work", "tasks"), ("work", "time_entries")],
    "commerce": [("commerce", "products"), ("commerce", "orders")],
    "social": [("social", "posts"), ("social", "reviews"), ("social", "comments")],
}

# `identity` is the spine. Every other domain names people and organizations, and
# the profile refuses a world with neither, so it is never droppable.
REQUIRED_PACKS = frozenset({"identity"})


def _drop_at(world: dict[str, Any], path: tuple[str, ...]) -> None:
    node = world
    for key in path[:-1]:
        if not isinstance(node.get(key), dict):
            return
        node = node[key]
    if path[-1] in node:
        node[path[-1]] = []


def prune_world(source: dict[str, Any], keep: set[str]) -> dict[str, Any]:
    """Return the world reduced to `keep`, with every reference into a dropped
    domain resolved.

    NOT REACHABLE FROM THE COMMAND LINE, ON PURPOSE. `build` compiles the whole
    world and always has: one world, one artifact, one digest. Selecting part of
    a world at compile time would fragment that into many partial artifacts, and
    choosing what to LOAD is a runtime decision -- `worldfixture up --only` makes
    it, by not starting a service at all.

    This exists because the contract test that keeps `world.requires` honest is
    built on it: it compiles the world once per domain with that domain removed
    and compares each projection, which is how two services were found to be
    under-declaring what they read.

    WHY THIS IS NOT A FILTER. The domains are not independent, and dropping one
    leaves records elsewhere pointing at nothing. Measured against the default
    world, dropping each domain on its own and validating the result:

        identity        refused -- the profile needs an organization and people
        communication   refused -- the timeline references channels
        finance         refused -- projects reference customers
        software        refused -- the timeline references issues
        support         drops cleanly
        work            drops cleanly

    So a selection has to take the closure: remove the domain, then remove or
    clear whatever referred to it. A reference the profile REQUIRES takes its
    holder with it -- a support case must have a customer, so support cases go
    when finance does. A reference the profile allows to be absent is cleared
    instead, because the record is still a true record without it.

    The result is validated by the caller, which is what stops this from
    silently producing a world that only looks whole.
    """
    unknown = sorted(keep - set(PACK_SOURCES))
    if unknown:
        raise WorldError(f"unknown pack{'s' if len(unknown) > 1 else ''}: {', '.join(unknown)}")
    missing = sorted(REQUIRED_PACKS - keep)
    if missing:
        raise WorldError(f"{', '.join(missing)} cannot be dropped; every other domain names its records")

    world = copy.deepcopy(source)
    dropped = set(PACK_SOURCES) - keep
    for pack in dropped:
        for path in PACK_SOURCES[pack]:
            _drop_at(world, path)

    customers = {item["id"] for item in world.get("finance", {}).get("customers", [])}
    invoices = {item["id"] for item in world.get("finance", {}).get("anchor_invoices", [])}
    channels = {item["id"] for item in world.get("communication", {}).get("channels", [])}
    issues = {
        issue["id"]
        for repository in world.get("software", {}).get("repositories", [])
        for issue in repository.get("issues", [])
    }
    cases = {item["id"] for item in world.get("support", {}).get("cases", [])}
    products = {item["id"] for item in world.get("commerce", {}).get("products", [])}

    # A required reference takes its holder with it. An order line names a
    # product, a review names a product, and a comment hangs from one of the
    # other two, so dropping the catalog empties the order book and the reviews,
    # and dropping the reviews takes the comments that answered them.
    commerce = world.get("commerce", {})
    commerce["orders"] = [
        order
        for order in commerce.get("orders", [])
        if all(item.get("product_id") in products for item in order.get("items", []))
    ]
    orders = {item["id"] for item in commerce.get("orders", [])}
    social = world.get("social", {})
    social["reviews"] = [
        review for review in social.get("reviews", []) if review.get("product_id") in products
    ]
    parents = {item["id"] for item in social.get("posts", [])} | {
        item["id"] for item in social.get("reviews", [])
    }
    social["comments"] = [
        comment for comment in social.get("comments", []) if comment.get("parent_id") in parents
    ]
    for review in social.get("reviews", []):
        if review.get("order_id") not in orders:
            review.pop("order_id", None)
    for post in social.get("posts", []):
        if "product_ids" in post:
            post["product_ids"] = [item for item in post["product_ids"] if item in products]

    support = world.get("support", {})
    support["cases"] = [case for case in support.get("cases", []) if case.get("customer_id") in customers]
    for case in support["cases"]:
        if case.get("order_id") not in orders:
            case.pop("order_id", None)

    # An optional reference is cleared; the record survives without it.
    for project in world.get("work", {}).get("projects", []):
        if project.get("customer_id") not in customers:
            project.pop("customer_id", None)
    for message in world.get("communication", {}).get("mail", []):
        if message.get("invoice_id") not in invoices:
            message.pop("invoice_id", None)
        if message.get("customer_id") not in customers:
            message.pop("customer_id", None)
        if message.get("order_id") not in orders:
            message.pop("order_id", None)
    for repository in world.get("software", {}).get("repositories", []):
        for issue in repository.get("issues", []):
            if issue.get("customer_id") not in customers:
                issue.pop("customer_id", None)
            if issue.get("support_case_id") not in cases:
                issue.pop("support_case_id", None)

    # A timeline arrival that names something this world no longer has can never
    # be played, so it is not part of this world.
    kept_timeline = []
    for event in world.get("timeline", []):
        payload = event.get("payload", {})
        kind = event.get("kind")
        if kind == "chat-message" and payload.get("channel_id") not in channels:
            continue
        if kind == "github-comment" and payload.get("issue_id") not in issues:
            continue
        if kind == "stripe-payment" and payload.get("customer_id") not in customers:
            continue
        if kind == "s3-object" and "communication" not in keep:
            continue
        kept_timeline.append(event)
    world["timeline"] = kept_timeline

    # Stories index the world. One whose every reference is gone indexes nothing.
    present = customers | invoices | channels | issues | cases
    present |= {item["id"] for item in world.get("organizations", [])}
    present |= {item["id"] for item in world.get("people", [])}
    present |= {item["id"] for item in world.get("communication", {}).get("documents", [])}
    present |= {item["id"] for item in world.get("work", {}).get("projects", [])}
    present |= products | orders
    present |= {item["id"] for item in world.get("social", {}).get("posts", [])}
    present |= {item["id"] for item in world.get("social", {}).get("reviews", [])}
    world["stories"] = [
        story for story in world.get("stories", [])
        if not story.get("entity_refs") or any(ref in present for ref in story["entity_refs"])
    ]

    # A site feed item can be tied to an arrival, so it appears when that arrival
    # plays. An item whose arrival is gone would wait for something that can
    # never happen.
    site = world.get("site")
    if isinstance(site, dict) and isinstance(site.get("feed"), dict):
        arrivals = {event["id"] for event in world.get("timeline", [])}
        site["feed"]["items"] = [
            item for item in site["feed"].get("items", [])
            if "arrival_id" not in item or item["arrival_id"] in arrivals
        ]

    # Agent grounding points at specific records. One that points at a record this
    # world no longer has would ground an agent in nothing.
    agentic = world.get("agentic")
    if isinstance(agentic, dict) and agentic.get("grounding"):
        agentic["grounding"] = [
            reference for reference in agentic["grounding"]
            if reference.get("kind") not in {"person", "organization", "invoice"}
            or reference.get("entity_id") in present
        ]

    validate_world(world)
    return world


def packs_for_services(manifests: list[dict[str, Any]]) -> set[str]:
    """The world domains a set of services needs, from what they declare.

    This is the point of `world.requires`. A service names the collections it
    reads as `<pack>.<collection>.v1`, so the domain is the prefix, and the
    domains a run needs are the union across the services it starts. Nobody has
    to name a pack by hand, and nobody has to know that seeding a mailbox also
    needs the finance records because invoice mail is delivered into it.

    `identity` is always included: every other domain names people and
    organizations, and the profile refuses a world without them.
    """
    packs = set(REQUIRED_PACKS)
    for manifest in manifests:
        for requirement in manifest.get("world", {}).get("requires", []):
            pack = str(requirement).split(".")[0]
            if pack in PACK_SOURCES:
                packs.add(pack)
    return packs


def compile_world(source: dict[str, Any]) -> dict[str, Any]:
    """Compile one world into packs and projections for its declared profile.

    A world without a profile compiles to its records and timeline only. That is
    the minimal world in the system design: data with no service projection and
    no driver.
    """
    validate_world(source)
    profile = source.get("profile")
    if profile is None:
        world = copy.deepcopy(source)
        return {"world": world, "timeline": copy.deepcopy(world.get("timeline", [])), "packs": {}, "projections": {}}
    return PROFILES[profile]["compile"](source)


def _compile_business_operations(source: dict[str, Any]) -> dict[str, Any]:
    anchor = datetime.fromisoformat(source["clock"]["anchor"].replace("Z", "+00:00")).astimezone(timezone.utc).date()
    world = copy.deepcopy(source)
    finance = _expand_finance(world, anchor)
    world["finance"]["resolved"] = finance
    resolved_mail = copy.deepcopy(world["communication"]["mail"]) + _invoice_mail(world, finance)
    resolved_mail.sort(key=lambda item: (item["sent_at"], item["id"]))
    world["communication"]["resolved_mail"] = resolved_mail

    google = _google_projection(world, resolved_mail)
    microsoft = _microsoft_projection(world)
    notion = _notion_projection(world)
    apple = _apple_projection(world)
    aws = _aws_projection(world)
    resend = _resend_projection(world)
    mongoatlas = _mongoatlas_projection(world)
    twilio = _twilio_projection(world)
    slack = _slack_projection(world)
    github = _github_projection(world)
    clerk = _clerk_projection(world)
    okta = _okta_projection(world)
    linear = _linear_projection(world)
    stripe = _stripe_projection(world)
    vercel = _vercel_projection(world)
    mail = _mail_projection(world, resolved_mail)
    model = _model_projection(world, finance)
    agent = _agent_projection(world, finance)
    http_targets = _http_targets_projection(world, finance)
    primary = next(person for person in world["people"] if person.get("primary"))
    emulator_google = copy.deepcopy(google)
    for message in emulator_google["messages"]:
        message.pop("worldfixture_entity_refs", None)
    emulator_microsoft = {
        "users": [
            {
                key: copy.deepcopy(user[key])
                for key in ("email", "name", "given_name", "family_name", "tenant_id")
            }
            for user in microsoft["users"]
        ]
    }
    emulator_apple = {
        "users": [
            {
                key: copy.deepcopy(user[key])
                for key in ("email", "name", "given_name", "family_name", "is_private_email")
            }
            for user in apple["users"]
        ]
    }
    emulator_slack = {
        "team": copy.deepcopy(slack["team"]),
        "users": [
            {key: copy.deepcopy(user[key]) for key in ("name", "real_name", "email", "profile", "presence")}
            for user in slack["users"]
        ],
        "channels": _emulator_slack_channels(slack),
        "bots": copy.deepcopy(slack["bots"]),
        "strict_scopes": False,
    }
    emulator_github = {
        "users": [
            {key: copy.deepcopy(user[key]) for key in ("login", "name", "email", "bio", "company", "location")}
            for user in github["users"]
        ],
        "orgs": copy.deepcopy(github["orgs"]),
        "repos": [
            {
                **{key: copy.deepcopy(repository[key]) for key in ("owner", "name", "description", "language", "topics", "auto_init")},
                # `GitHubSeedConfig` has no issues field, so the composer inserts
                # these through the emulator's public store after seeding. The world
                # points at one of them by number from Slack, so a repository that
                # arrives without its issues makes that reference dangle.
                "issues": [
                    {
                        "number": issue["number"],
                        "title": issue["title"],
                        "body": issue["body"],
                        "state": issue["state"],
                        "author": issue["author"],
                        "assignees": [issue["assignee"]] if issue.get("assignee") else [],
                    }
                    for issue in repository.get("issues", [])
                ],
            }
            for repository in github["repos"]
        ],
    }
    emulator_clerk = {
        "users": [
            {key: copy.deepcopy(user[key]) for key in ("first_name", "last_name", "email_addresses", "password")}
            for user in clerk["users"]
        ],
        "organizations": [
            {
                "name": organization["name"],
                "slug": organization["slug"],
                "members": [
                    {key: copy.deepcopy(member[key]) for key in ("email", "role")}
                    for member in organization["members"]
                ],
            }
            for organization in clerk["organizations"]
        ],
    }
    emulator_okta = {
        "users": [
            {key: copy.deepcopy(user[key]) for key in ("login", "email", "first_name", "last_name")}
            for user in okta["users"]
        ],
        "groups": copy.deepcopy(okta["groups"]),
    }
    emulator_linear = {
        "organization": copy.deepcopy(linear["organization"]),
        "users": [
            {key: copy.deepcopy(user[key]) for key in ("email", "name", "admin")}
            for user in linear["users"]
        ],
        "teams": copy.deepcopy(linear["teams"]),
        "labels": copy.deepcopy(linear["labels"]),
        "issues": [
            {key: copy.deepcopy(issue[key]) for key in ("team", "title", "description", "state", "assignee", "labels")}
            for issue in linear["issues"]
        ],
        "strict_scopes": False,
    }
    emulator_stripe = {
        "customers": [
            {key: copy.deepcopy(customer[key]) for key in ("email", "name")}
            for customer in stripe["customers"]
        ],
        "products": [
            {key: copy.deepcopy(product[key]) for key in ("name", "description")}
            for product in stripe["products"]
        ],
        "prices": [
            {key: copy.deepcopy(price[key]) for key in ("product_name", "currency", "unit_amount")}
            for price in stripe["prices"]
        ],
    }
    # A world with no software projects no web deployment, so the composer's
    # Vercel vendor is given nothing to seed rather than an invented project.
    emulator_vercel = None if vercel is None else {
        "users": [
            {key: copy.deepcopy(user[key]) for key in ("username", "name", "email")}
            for user in vercel["users"]
        ],
        "teams": [
            {key: copy.deepcopy(team[key]) for key in ("slug", "name")}
            for team in vercel["teams"]
        ],
        "projects": [
            {key: copy.deepcopy(project[key]) for key in ("name", "team", "framework")}
            for project in vercel["projects"]
        ],
    }
    emulator_aws = copy.deepcopy(aws)
    emulator_aws.pop("worldfixture_organization_id", None)
    # SeaweedFS owns S3. `@emulators/aws` serves `/s3/` too, so handing it the
    # bucket list would give one provider's mutable state two route owners, which
    # the design forbids. The AWS vendor keeps IAM, SQS and STS, which no other
    # service implements; the S3 service reads `projections/aws.json` itself and
    # is the sole authority for buckets and objects.
    emulator_aws.pop("s3", None)
    for queue in emulator_aws["sqs"]["queues"]:
        queue.pop("worldfixture_story_id", None)
    for user in emulator_aws["iam"]["users"]:
        user.pop("worldfixture_person_id", None)
    for role in emulator_aws["iam"]["roles"]:
        role.pop("worldfixture_repository_id", None)
    emulator_resend = {
        "domains": [{key: copy.deepcopy(domain[key]) for key in ("name", "region")} for domain in resend["domains"]],
        "contacts": [
            {key: copy.deepcopy(contact[key]) for key in ("email", "first_name", "last_name")}
            for contact in resend["contacts"]
        ],
    }
    emulator_mongoatlas = copy.deepcopy(mongoatlas)
    for project in emulator_mongoatlas["projects"]:
        project.pop("worldfixture_organization_id", None)
    for user in emulator_mongoatlas["database_users"]:
        user.pop("worldfixture_person_id", None)
    emulator_twilio = copy.deepcopy(twilio)
    emulator_twilio["account"].pop("worldfixture_organization_id", None)
    slack_name_by_person = {user["worldfixture_person_id"]: user["name"] for user in slack["users"]}
    primary_slack_name = slack_name_by_person[primary["id"]]
    person_slack_tokens = {
        f"slack_token_{person['id']}": {"login": slack_name_by_person[person["id"]], "scopes": []}
        for person in world["people"]
        if person["id"] in slack_name_by_person
    }
    notion_members = {
        user["worldfixture_person_id"]: user
        for user in notion["users"]
    }
    person_notion_tokens = {
        f"notion_token_{person_id}": {
            "login": user["email"],
            "scopes": ["read:user", "read:content", "write:content", "read:comment", "insert:comment", "interact:agents"],
        }
        for person_id, user in notion_members.items()
    }
    overlay = {
        "tokens": {
            **person_slack_tokens,
            **person_notion_tokens,
            "demo_token": {"login": primary["email"], "scopes": ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.modify"]},
            "microsoft_token": {"login": primary["email"], "scopes": ["openid", "email", "profile", "User.Read"]},
            "notion_token": {"login": primary["email"], "scopes": ["read:user", "read:content", "write:content", "read:comment", "insert:comment", "interact:agents"]},
            "notion_admin_token": {
                "login": primary["email"],
                "scopes": [
                    "legal-hold:read", "legal-hold:write", "legal-hold:write-high-impact", "legal-hold:export",
                    "workspace:export", "managed-user-session:write", "mcp-client-connection:read",
                    "mcp-client-connection:write-high-impact", "user:read", "permission-group:read",
                    "permission-group:write", "personal-access-token:read", "personal-access-token:write-high-impact",
                    "workflows:read", "workflows:write",
                ],
            },
            "apple_token": {"login": primary["email"], "scopes": ["openid", "email", "name"]},
            "aws_token": {"login": primary["github_login"], "scopes": ["s3:*", "sqs:*", "iam:*", "sts:*"]},
            "clerk_token": {"login": primary["email"], "scopes": []},
            "github_token": {"login": primary["github_login"], "scopes": ["repo", "user", "admin:org"]},
            "linear_token": {"login": primary["email"], "scopes": []},
            "mongoatlas_token": {"login": primary["github_login"], "scopes": []},
            "okta_token": {"login": primary["email"], "scopes": ["openid", "profile", "email", "groups"]},
            "resend_token": {"login": "re_test_admin", "scopes": []},
            # The Slack emulator resolves a token by its own user id or user name.
            # The world's canonical `slack_id` is neither: seeding mints a fresh id,
            # and the world id collides with the upstream default admin. Name the
            # person instead, which the emulator matches and the world owns.
            "slack_token": {"login": primary_slack_name, "scopes": []},
            "stripe_token": {"login": "sk_test_admin", "scopes": []},
            "twilio_token": {"login": twilio["account"]["sid"], "scopes": []},
            "vercel_token": {"login": primary["github_login"], "scopes": []},
        },
        "microsoft": emulator_microsoft,
        "notion": copy.deepcopy(notion),
        "apple": emulator_apple,
        "aws": emulator_aws,
        "resend": emulator_resend,
        "mongoatlas": emulator_mongoatlas,
        "twilio": emulator_twilio,
        "clerk": emulator_clerk,
        "google": emulator_google,
        "slack": emulator_slack,
        "github": emulator_github,
        "linear": emulator_linear,
        "okta": emulator_okta,
        "stripe": emulator_stripe,
        "vercel": emulator_vercel,
        "worldfixture": {"arrivals": _arrival_projection(world)},
    }
    return {
        "world": world,
        "timeline": copy.deepcopy(world["timeline"]),
        "packs": _canonical_packs(world, finance, resolved_mail),
        "projections": {
            "google": google,
            "microsoft": microsoft,
            "notion": notion,
            "apple": apple,
            "aws": aws,
            "resend": resend,
            "mongoatlas": mongoatlas,
            "twilio": twilio,
            "slack": slack,
            "github": github,
            "clerk": clerk,
            "linear": linear,
            "okta": okta,
            "stripe": stripe,
            "vercel": vercel,
            "aws": aws,
            "resend": resend,
            "mongoatlas": mongoatlas,
            "twilio": twilio,
            "mail": mail,
            "model": model,
            "agent": agent,
            "http-targets": http_targets,
            "emulator-overlay": overlay,
        },
    }


PROFILES: dict[str, dict[str, Any]] = {
    "business.operations/v1": {
        "validate": _validate_business_operations,
        "compile": _compile_business_operations,
    },
}


def _build_world(source: dict[str, Any], source_provenance: dict[str, Any], output: Path) -> dict[str, Any]:
    compiled = compile_world(source)

    files: dict[str, bytes] = {
        "world.json": canonical_json(compiled["world"]),
        "timeline.json": canonical_json(compiled["timeline"]),
    }
    for name, pack in compiled["packs"].items():
        files[f"packs/{name}.json"] = canonical_json(pack)
    for name, projection in compiled["projections"].items():
        # A projection with nothing to project is omitted rather than written
        # empty. A selection can leave a world with no software, and an artifact
        # that carried an empty web deployment would be claiming one exists.
        if projection is None:
            continue
        files[f"projections/{name}.json"] = canonical_json(projection)

    digests = {name: {"sha256": sha256(data), "size": len(data)} for name, data in sorted(files.items())}
    artifact_digest = sha256(canonical_json(digests))
    manifest = {
        "api_version": "worldfixture.world-artifact/v1",
        "build_mode": "prebuilt",
        "world_id": source["id"],
        "world_version": source["version"],
        "profile": source.get("profile"),
        "source_sha256": source_provenance["source_sha256"],
        "source_files": source_provenance["source_files"],
        "artifact_sha256": artifact_digest,
        "files": digests,
        "categories": source.get("categories", []),
        "packs": sorted(compiled["packs"]),
        "scenario": copy.deepcopy(source["scenario"]),
        "synthetic": True,
    }
    files["manifest.json"] = canonical_json(manifest)

    for name, data in files.items():
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    return manifest


def build_world(source_path: Path, output: Path, packs: set[str] | None = None) -> dict[str, Any]:
    """Compile one world, optionally reduced to some of its domains.

    `packs` is None for the whole world, which is the default and produces
    byte-identical output to a build that never knew about selection at all --
    `prune_world` is not called, so the parity fixture is untouched.
    """
    source, source_provenance = load_world(source_path)
    if packs is not None:
        source = prune_world(source, set(packs))
    return _build_world(source, source_provenance, output)


def build_rebased_world(source_path: Path, target: datetime, output: Path) -> dict[str, Any]:
    """Build a deterministic session artifact without changing reviewed source files."""
    source, source_provenance = load_world(source_path)
    return _build_world(rebase_world(source, target), source_provenance, output)


def bundle_world(source_path: Path, output: Path) -> dict[str, Any]:
    """Build one deterministic transport artifact for object storage."""
    with tempfile.TemporaryDirectory() as directory:
        build_directory = Path(directory)
        manifest = build_world(source_path, build_directory)
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("wb") as archive_file:
            with tarfile.open(fileobj=archive_file, mode="w", format=tarfile.USTAR_FORMAT) as archive:
                for path in sorted(item for item in build_directory.rglob("*") if item.is_file()):
                    data = path.read_bytes()
                    info = tarfile.TarInfo(path.relative_to(build_directory).as_posix())
                    info.size = len(data)
                    info.mode = 0o644
                    info.mtime = 0
                    info.uid = 0
                    info.gid = 0
                    info.uname = ""
                    info.gname = ""
                    archive.addfile(info, io.BytesIO(data))

    artifact = output.read_bytes()
    return {
        "world_id": manifest["world_id"],
        "world_version": manifest["world_version"],
        "content_sha256": manifest["artifact_sha256"],
        "artifact_sha256": sha256(artifact),
        "artifact_size": len(artifact),
    }
