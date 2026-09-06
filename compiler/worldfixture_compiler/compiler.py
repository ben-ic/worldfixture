from __future__ import annotations

import calendar
import copy
import hashlib
import io
import json
import re
import shutil
import tarfile
import tempfile
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

from .oauth import oauth_projection

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

    _validate_authored_timeline(world)
    world["timeline"] = sorted(
        world["timeline"],
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
    _require(isinstance(items, list), f"{label} must be an array")
    result: dict[str, dict[str, Any]] = {}
    for item in items:
        _require(isinstance(item, dict), f"{label} must contain records")
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
    """Validate the envelope, declared sections, and compatible provider adapters."""
    from .sections import legacy_business_shape, provider_world, validate_sections, validate_structure

    _require(isinstance(world, dict), "world must be an object")
    _validate_envelope(world)
    validate_structure(world)
    try:
        oauth_projection(world)
    except ValueError as error:
        raise WorldError(str(error)) from error
    profile = world.get("profile")
    _require(profile is None or (isinstance(profile, str) and profile in PROFILES), f"unsupported world profile: {profile!r}")
    if legacy_business_shape(world):
        view = provider_world(world)
        view["software"].setdefault("repositories", [])
        view["work"].setdefault("time_entries", [])
        PROFILES[profile]["validate"](view)
    validate_sections(world)


def _validate_envelope(world: dict[str, Any]) -> None:
    """Check only what every world has, whatever its records describe.

    The core requires no organization, person, GitHub login, Slack id, or
    primary person. A world profile adds those requirements when a world
    declares one.
    """
    _require(isinstance(world.get("title"), str) and bool(world["title"].strip()), "world needs a title")
    _require(world.get("api_version") == "worldfixture.world-source/v1", "unsupported api_version")
    _check_id(world.get("id"), "world id")
    _require(re.fullmatch(r"v[0-9]+", str(world.get("version", ""))) is not None, "invalid world version")
    _require(len(str(world.get("synthetic_notice", ""))) >= 20, "synthetic_notice is too short")
    scenario = world.get("scenario", {})
    _require(isinstance(scenario, dict), "scenario must be an object")
    _check_id(scenario.get("id"), "scenario id")
    _require(
        isinstance(scenario.get("class"), str) and scenario.get("class") in {"normal", "data-quality", "bad-actor", "fraud", "operational-failure"},
        "unsupported scenario class",
    )
    _require(bool(scenario.get("title")), "scenario needs a title")

    _require(isinstance(world.get("clock"), dict) and isinstance(world["clock"].get("anchor"), str), "clock.anchor must be an ISO-8601 timestamp")
    try:
        anchor = datetime.fromisoformat(world["clock"]["anchor"].replace("Z", "+00:00"))
    except (KeyError, TypeError, ValueError) as error:
        raise WorldError("clock.anchor must be an ISO-8601 timestamp") from error
    _require(anchor.tzinfo is not None, "clock.anchor must include a timezone")
    _finance_history_clock(world, anchor.astimezone(UTC).date())
    rebase = world["clock"].get("rebase", {})
    _require(isinstance(rebase, dict), "clock.rebase must be an object")
    relative_paths = rebase.get("relative_paths", [])
    _require(
        isinstance(relative_paths, list)
        and all(isinstance(path, str) and re.fullmatch(r"[a-z_]+(?:\.[a-z_]+)*", path) for path in relative_paths),
        "clock.rebase.relative_paths must name scenario-relative branches",
    )

    _validate_authored_timeline(world)


def _validate_authored_timeline(world: dict[str, Any]) -> None:
    """Validate authored input before fragment sorting or provider transforms.

    A selected runtime schedule can be empty after capability filtering. That
    derived schedule is separate from the authored world contract checked here.
    """
    context = f"world {world.get('id', '<missing id>')}:{world.get('version', '<missing version>')}"
    timeline = world.get("timeline")
    _require(
        isinstance(timeline, list) and bool(timeline),
        f"{context} timeline must be a nonempty authored array; add at least one scheduled arrival",
    )
    timeline_ids: set[str] = set()
    for index, event in enumerate(timeline):
        _require(isinstance(event, dict), f"{context} timeline entry {index} must be a record")
        _check_id(event.get("id"), f"{context} timeline id at entry {index}")
        _require(event["id"] not in timeline_ids, f"{context} duplicate timeline id: {event['id']}")
        timeline_ids.add(event["id"])
        _require(
            isinstance(event.get("kind"), str) and bool(event["kind"]),
            f"{context} timeline {event['id']} needs a kind string",
        )
        _require(
            isinstance(event.get("payload"), dict),
            f"{context} timeline {event['id']} needs a payload object",
        )
        _require(
            type(event.get("after_seconds")) is int and event["after_seconds"] >= 0,
            f"{context} invalid timeline offset: {event['id']}",
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
    _validate_aws_operators(world)

    finance = world.get("finance", {})
    customers = _unique(finance.get("customers", []), "id", "customer")
    suppliers = _unique(finance.get("suppliers", []), "id", "supplier")
    invoices = _unique(finance.get("anchor_invoices", []), "id", "invoice")
    for customer in customers.values():
        _check_id(customer["id"], "customer id")
        _require(customer.get("organization_id") in organizations, f"customer {customer['id']} has unknown organization")
        _require(customer.get("contact_id") in people, f"customer {customer['id']} has unknown contact")
        if _billing_mode(customer) == "recurring_monthly":
            _finance_amount(customer.get("monthly_amount_cents"), f"customer {customer['id']} amount")
        _revenue_account({}, customer)
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
    _expand_finance(world, datetime.fromisoformat(world["clock"]["anchor"].replace("Z", "+00:00")).date())
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
        _require(isinstance(task.get("status"), str) and bool(task["status"]), f"task {task['id']} has invalid status")
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

    def validate_mail_labels(labels: Any, context: str) -> None:
        _require(isinstance(labels, list), f"world {world['id']} {context} labels must be an array")
        _require(all(isinstance(label, str) and label.strip() for label in labels), f"world {world['id']} {context} labels must contain nonempty strings")
        _require(len(labels) == len(set(labels)), f"world {world['id']} {context} labels contains duplicates")

    mail = _unique(world.get("communication", {}).get("mail", []), "id", "mail")
    for message in mail.values():
        _check_id(message["id"], "mail id")
        validate_mail_labels(message.get("labels"), f"communication.mail {message['id']}")
        _require(isinstance(message.get("to_ids"), list) and bool(message["to_ids"]), f"world {world['id']} communication.mail {message['id']} to_ids must be a nonempty array")
        _require(message.get("from_id") in people, f"mail {message['id']} has unknown sender")
        for recipient_id in message.get("to_ids", []):
            _require(recipient_id in people, f"mail {message['id']} has unknown recipient {recipient_id}")
        related_invoice = message.get("invoice_id")
        _require(related_invoice is None or related_invoice in invoices, f"mail {message['id']} has unknown invoice")
        related_order = message.get("order_id")
        _require(related_order is None or related_order in orders, f"mail {message['id']} has unknown order")

    _validate_google_mailbox_declarations(world, people)
    if "mailboxes" in world.get("communication", {}):
        _validate_google_mailbox_references(world, world["communication"]["mailboxes"], list(mail.values()))

    documents = _unique(world.get("communication", {}).get("documents", []), "id", "document")
    for document in documents.values():
        _check_id(document["id"], "document id")
        _require(document.get("owner_id") in people, f"document {document['id']} has unknown owner")

    if "mailboxes" in world.get("communication", {}):
        _validate_google_content_owners(world, world["communication"]["mailboxes"])

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
            event.get("kind") in TIMELINE_KINDS | {"domain-operation"},
            f"unsupported timeline kind: {event.get('kind')}",
        )
        payload = event.get("payload", {})
        if event["kind"] == "incoming-email":
            validate_mail_labels(payload.get("labels", ["INBOX", "UNREAD"]), f"timeline {event['id']} payload.labels")
            _require(payload.get("via", "smtp") in {"smtp", "gmail"}, f"world {world['id']} timeline {event['id']} payload.via is unsupported")
            context = f"world {world['id']}:{world['version']} timeline {event['id']} payload"
            _require(isinstance(payload.get("from_id"), str) and payload["from_id"] in people, f"{context}.from_id has unknown sender")
            _require(isinstance(payload.get("to_id"), str) and payload["to_id"] in people, f"{context}.to_id has unknown recipient")
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
        _require(type(product.get("price_cents")) is int and product["price_cents"] > 0, f"product {product['id']} has invalid price")
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
            _require(isinstance(item, dict), f"order {order['id']} items must be records")
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
        for field in ("shipping_cents", "discount_cents"):
            _require(type(order.get(field, 0)) is int and order.get(field, 0) >= 0, f"order {order['id']} has invalid {field}")
        total = subtotal + order.get("shipping_cents", 0) - order.get("discount_cents", 0)
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


def _prose_date(day: int, month: int, anchor: date) -> date | None:
    """The calendar date an authored `30 December` means under this anchor.

    Prose names a day and a month and no year, so the year has to come from the
    anchor. Reading it as `anchor.year` outright loses every date that sits on
    the other side of a year boundary: under a 5 January anchor, `30 December`
    parsed as the December ELEVEN MONTHS AHEAD, landed far outside the +/-35 day
    window in `_rebase_text`, and was silently left alone while every date around
    it moved. The nearest of the three candidate years is the one the prose
    means. It can only ever rebase a date the old reading left frozen: the
    candidates are a year apart and the window is 70 days wide, so at most one of
    them can fall inside it.

    A day the month does not have is not a date at all, and this returns None for
    it. The pattern that finds these matches any one or two digit number before a
    month name, so `we shipped 62 June units` reached `date()` and raised a bare
    `ValueError: day 62 must be in range 1..30`, which failed the whole build and
    named no world, file or field. Prose the compiler cannot read as a date is
    left exactly as its author wrote it.
    """
    candidates = []
    for year in (anchor.year - 1, anchor.year, anchor.year + 1):
        try:
            candidates.append(date(year, month, day))
        except ValueError:
            continue
    if not candidates:
        return None
    return min(candidates, key=lambda candidate: abs((candidate - anchor).days))


def _rebase_text(value: str, anchor: date, delta: timedelta) -> str:
    """Shift reviewed scenario dates while leaving historical prose unchanged."""
    first = anchor - timedelta(days=35)
    last = anchor + timedelta(days=35)

    def shifted(day: date | None) -> date | None:
        if day is None:
            return None
        return day + delta if first <= day <= last else None

    # An ISO shape is not the same thing as an ISO date: `2026-02-30` matches the
    # pattern and is not a day. Parsing it raised the same bare `ValueError` the
    # prose forms did, so an unparseable match is left as authored here too.
    def iso_timestamp(match: re.Match[str]) -> str:
        try:
            original = datetime.fromisoformat(match.group().replace("Z", "+00:00"))
        except ValueError:
            return match.group()
        if shifted(original.date()) is None:
            return match.group()
        return (original + delta).isoformat().replace("+00:00", "Z")

    def iso_date(match: re.Match[str]) -> str:
        try:
            original = date.fromisoformat(match.group())
        except ValueError:
            return match.group()
        return shifted(original).isoformat() if shifted(original) else match.group()

    value = _ISO_TIMESTAMP.sub(iso_timestamp, value)
    value = _ISO_DATE.sub(iso_date, value)

    # The authored prose uses these two unambiguous date forms. Weekday words do
    # not need rewriting because rebase steps are always whole weeks.
    month_pattern = "|".join(_MONTH_NAMES)

    def day_month(match: re.Match[str]) -> str:
        rebased = shifted(_prose_date(int(match.group(1)), _MONTH_NAMES.index(match.group(3)) + 1, anchor))
        if rebased is None:
            return match.group()
        # The ordinal suffix is captured and was then thrown away, which turned
        # `the 3rd March` into `the 10 March`. `_ordinal` exists to write the
        # suffix the shifted day needs, and is called here rather than nowhere.
        day = _ordinal(rebased.day) if match.group(2) else str(rebased.day)
        return f"{day} {rebased.strftime('%B')}"

    def month_day(match: re.Match[str]) -> str:
        rebased = shifted(_prose_date(int(match.group(2)), _MONTH_NAMES.index(match.group(1)) + 1, anchor))
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
    "placed_on", "shipped_on", "posted_at", "launched_on", "paid_on", "refunded_on",
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
    anchor = anchor_at.astimezone(UTC).date()
    target_day = target.astimezone(UTC).date()
    delta = timedelta(days=((target_day - anchor).days // 7) * 7)
    relative_paths = {tuple(path.split(".")) for path in source["clock"]["rebase"]["relative_paths"]}
    rebased = _rebase_values(copy.deepcopy(source), anchor, delta, relative_paths)
    rebased["clock"]["anchor"] = (anchor_at + delta).isoformat().replace("+00:00", "Z")
    _record_finance_rebase_context(source, rebased, delta)
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
    people = {person["id"]: person for person in world.get("people", [])}
    organizations = {organization["id"]: organization for organization in world.get("organizations", [])}
    return people, organizations


def _finance_history_clock(world: dict[str, Any], anchor: date) -> tuple[date, timedelta]:
    context = world["clock"].get("rebase", {}).get("finance_history")
    if context is None and "finance_history" not in world["clock"].get("rebase", {}):
        return anchor, timedelta()
    _require(isinstance(context, dict) and set(context) == {"origin_anchor", "day_shift"}, "clock.rebase.finance_history needs origin_anchor and day_shift")
    _require(isinstance(context["origin_anchor"], str) and type(context["day_shift"]) is int, "invalid finance_history origin_anchor/day_shift types")
    try:
        original = datetime.fromisoformat(context["origin_anchor"].replace("Z", "+00:00"))
        _require(original.tzinfo is not None, "finance_history.origin_anchor needs a timezone")
        origin = original.astimezone(UTC).date()
        shift = timedelta(days=context["day_shift"])
        _require(origin + shift == anchor, "finance_history origin_anchor plus day_shift must equal the current anchor date")
    except (ValueError, OverflowError) as error:
        raise WorldError("invalid finance_history origin_anchor/day_shift") from error
    return origin, shift


def _record_finance_rebase_context(source: dict[str, Any], rebased: dict[str, Any], delta: timedelta) -> None:
    if "finance" not in source:
        return
    prior = source["clock"].get("rebase", {}).get("finance_history")
    rebased["clock"].setdefault("rebase", {})["finance_history"] = {
        "origin_anchor": prior["origin_anchor"] if prior else source["clock"]["anchor"],
        "day_shift": (prior["day_shift"] if prior else 0) + delta.days,
    }


def _billing_mode(customer: dict[str, Any]) -> str:
    mode = customer["billing_mode"] if "billing_mode" in customer else "recurring_monthly"
    _require(isinstance(mode, str) and mode in {"recurring_monthly", "one_time"}, f"customer {customer['id']} has invalid billing_mode")
    return mode


def _finance_currency(record: dict[str, Any], fallback: str) -> str:
    value = record["currency"] if "currency" in record else fallback
    _require(isinstance(value, str) and re.fullmatch(r"[A-Za-z]{3}", value), "finance currency must be a three-letter code")
    return value.upper()


def _finance_amount(value: Any, label: str) -> int:
    _require(type(value) is int and 0 < value <= 9007199254740991, f"{label} must be a positive safe integer")
    return value


def _finance_date(value: Any, label: str) -> str:
    try:
        _require(isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value), f"{label} must be an authored ISO date")
        date.fromisoformat(value)
    except ValueError as error:
        raise WorldError(f"{label} must be an authored ISO date") from error
    return value


def _revenue_account(record: dict[str, Any], customer: dict[str, Any]) -> str:
    value = record.get("revenue_account", customer.get("revenue_account"))
    if value is None and "revenue_account" not in record and "revenue_account" not in customer:
        _require(_billing_mode(customer) == "recurring_monthly", f"one-time customer {customer['id']} needs revenue_account")
        value = "subscription-revenue"
    _require(isinstance(value, str) and bool(value), f"customer {customer['id']} has invalid revenue_account")
    _require(value not in {"accounts-receivable", "operating-cash", "operating-expense"}, "revenue_account cannot use a reserved balance/expense account")
    return value


def _expand_finance(world: dict[str, Any], anchor: date) -> dict[str, list[dict[str, Any]]]:
    finance = world["finance"]
    currency = _finance_currency(finance, "")
    months = finance["history_months"]
    history_anchor, history_shift = _finance_history_clock(world, anchor)
    _require(type(months) is int and months >= 0, "finance.history_months must be a nonnegative integer")
    customers = {row["id"]: row for row in finance["customers"]}
    orders = {row["id"]: row for row in world.get("commerce", {}).get("orders", [])}
    invoices = copy.deepcopy(finance["anchor_invoices"])
    bills: list[dict[str, Any]] = []
    payments: list[dict[str, Any]] = []
    ledger: list[dict[str, Any]] = []
    authored = finance["payments"] if "payments" in finance else []
    refunds = copy.deepcopy(finance["refunds"] if "refunds" in finance else [])
    _require(isinstance(authored, list) and isinstance(refunds, list), "finance payments/refunds must be arrays")
    _require(all(isinstance(row, dict) for row in authored + refunds), "finance payment/refund entries must be objects")
    for row in authored:
        for field in ("id", "customer_id"):
            _check_id(row.get(field), f"payment {field}")
        for field in ("invoice_id", "order_id"):
            if field in row:
                _check_id(row[field], f"payment {field}")
    for row in refunds:
        for field in ("id", "payment_id"):
            _check_id(row.get(field), f"refund {field}")
    _unique(authored, "id", "payment")
    _unique(refunds, "id", "refund")
    # An authored settlement replaces the generated default for its invoice.
    # Empty authored arrays add no records; monthly history remains its own policy.
    overridden = {row.get("invoice_id") for row in authored}
    anchor_ids = {invoice["id"] for invoice in invoices}
    for offset in range(months, 0, -1):
        month = _month_before(history_anchor, offset)
        for customer in customers.values():
            if _billing_mode(customer) == "one_time":
                continue
            invoice_id = f"inv-{month:%Y%m}-{customer['id']}"
            if invoice_id in anchor_ids:
                continue
            issued = _date_in_month(month, int(customer.get("invoice_day", 5))) + history_shift
            due = _date_in_month(_month_before(month, -1), int(customer.get("due_day", 5))) + history_shift
            amount = _finance_amount(customer["monthly_amount_cents"], f"customer {customer['id']} amount")
            record_currency = _finance_currency(customer, currency)
            invoices.append({"id": invoice_id, "number": f"{month:%y%m}-{customer['number_suffix']}",
                "customer_id": customer["id"], "issued_on": _iso_day(issued), "due_on": _iso_day(due),
                "amount_cents": amount, "currency": record_currency, "status": "paid", "description": customer["service"]})
            if invoice_id not in overridden:
                payments.append({"id": f"pay-{invoice_id}", "invoice_id": invoice_id, "customer_id": customer["id"],
                    "paid_on": _iso_day(due), "amount_cents": amount, "currency": record_currency})
        for supplier in finance["suppliers"]:
            issued = _date_in_month(month, int(supplier.get("bill_day", 12))) + history_shift
            bills.append({"id": f"bill-{month:%Y%m}-{supplier['id']}", "supplier_id": supplier["id"],
                "issued_on": _iso_day(issued), "amount_cents": _finance_amount(supplier["monthly_amount_cents"], "supplier amount"),
                "currency": _finance_currency(supplier, currency), "status": "paid", "description": supplier["service"]})
    invoice_map = _unique(invoices, "id", "invoice")
    order_invoices = {}
    for invoice in invoices:
        customer = customers[invoice["customer_id"]]
        invoice["currency"] = _finance_currency(invoice, _finance_currency(customer, currency))
        _finance_amount(invoice["amount_cents"], f"invoice {invoice['id']} amount")
        _finance_date(invoice["issued_on"], f"invoice {invoice['id']} issued_on")
        _finance_date(invoice["due_on"], f"invoice {invoice['id']} due_on")
        if "order_id" in invoice:
            _check_id(invoice["order_id"], "invoice order_id")
            order = orders.get(invoice["order_id"])
            _require(order is not None, f"invoice {invoice['id']} has unknown order")
            _require(order["shopper_id"] == customer["contact_id"], f"invoice {invoice['id']} order/customer mismatch")
            _require(invoice["currency"] == _finance_currency(order, currency), f"invoice {invoice['id']} order currency mismatch")
            _require(invoice["amount_cents"] == order["total_cents"], f"invoice {invoice['id']} order amount mismatch")
            _require(order["id"] not in order_invoices, f"order {order['id']} has duplicate purchase invoices")
            order_invoices[order["id"]] = invoice["id"]
    for original in authored:
        payment = copy.deepcopy(original)
        _check_id(payment["id"], "payment id")
        _require(payment.get("status") == "succeeded", f"payment {payment['id']} must explicitly declare status succeeded")
        customer = customers.get(payment.get("customer_id"))
        _require(customer is not None, f"payment {payment['id']} has unknown customer")
        _require("invoice_id" in payment or "order_id" in payment, f"payment {payment['id']} needs invoice_id or order_id")
        invoice = invoice_map.get(payment.get("invoice_id"))
        _require("invoice_id" not in payment or invoice is not None, f"payment {payment['id']} has unknown invoice")
        payment["currency"] = _finance_currency(payment, invoice["currency"] if invoice else _finance_currency(customer, currency))
        _finance_amount(payment.get("amount_cents"), f"payment {payment['id']} amount")
        _finance_date(payment.get("paid_on"), f"payment {payment['id']} paid_on")
        _require(payment["paid_on"] <= _iso_day(anchor), f"payment {payment['id']} is after the world anchor")
        if invoice:
            _require(invoice["customer_id"] == customer["id"], f"payment {payment['id']} invoice/customer mismatch")
            _require(invoice["currency"] == payment["currency"], f"payment {payment['id']} invoice currency mismatch")
            _require(payment["paid_on"] >= invoice["issued_on"], f"payment {payment['id']} predates invoice")
            if "order_id" in invoice:
                _require(payment.get("order_id", invoice["order_id"]) == invoice["order_id"], f"payment {payment['id']} order/invoice mismatch")
                payment["order_id"] = invoice["order_id"]
        if "order_id" in payment:
            order = orders.get(payment["order_id"])
            _require(order is not None, f"payment {payment['id']} has unknown order")
            _require(order["shopper_id"] == customer["contact_id"], f"payment {payment['id']} order/customer mismatch")
            _require(order["status"] != "cancelled" and order.get("payment_status") not in {"unpaid", "cancelled"}, f"payment {payment['id']} settles an unpaid/cancelled order")
            _require(payment["currency"] == _finance_currency(order, currency), f"payment {payment['id']} order currency mismatch")
            _require(payment["paid_on"] >= order["placed_on"], f"payment {payment['id']} predates order")
            _require(invoice is None or invoice.get("order_id") == order["id"], f"payment {payment['id']} invoice must declare the same order")
            _require(order["id"] not in order_invoices or payment.get("invoice_id") == order_invoices[order["id"]], f"payment {payment['id']} must use the order's invoice to avoid double counting")
        payments.append(payment)
    payment_map = _unique(payments, "id", "payment")
    for payment in payments:
        _finance_date(payment.get("paid_on"), f"payment {payment['id']} paid_on")
        _require(payment["paid_on"] <= _iso_day(anchor), f"payment {payment['id']} is after the world anchor")
        if payment.get("invoice_id"):
            _require(payment["paid_on"] >= invoice_map[payment["invoice_id"]]["issued_on"], f"payment {payment['id']} predates invoice")
    for invoice in invoices:
        total = sum(row["amount_cents"] for row in payments if row.get("invoice_id") == invoice["id"])
        if invoice["status"] == "paid":
            _require(total == invoice["amount_cents"], f"paid invoice {invoice['id']} needs explicit authored settlements with paid_on (expected {invoice['amount_cents']}, got {total})")
        else:
            _require(total < invoice["amount_cents"], f"invoice {invoice['id']} is fully settled but not paid")
            _require(invoice["status"] in {"open", "overdue"} or total == 0, f"invoice {invoice['id']} cannot receive payments")
    for order in orders.values():
        _require("payment_status" not in order or (isinstance(order["payment_status"], str) and order["payment_status"] in {"unpaid", "cancelled", "paid", "partially_refunded", "refunded"}), f"order {order['id']} has invalid payment_status")
        total = sum(row["amount_cents"] for row in payments if row.get("order_id") == order["id"])
        _require(total <= order["total_cents"], f"order {order['id']} is charged more than once")
        if order.get("payment_status") in {"paid", "partially_refunded", "refunded"}:
            _require(total == order["total_cents"], f"order {order['id']} has unmatched explicit payments")
        if order.get("payment_status") in {"unpaid", "cancelled"}:
            _require(total == 0, f"order {order['id']} must have no successful payments")
        if order["status"] == "refunded" and (order["id"] in order_invoices or total > 0 or "payment_status" in order):
            _require(total == order["total_cents"], f"finance-linked refunded order {order['id']} needs its original payment")
    refunded = {}
    for refund in refunds:
        _check_id(refund["id"], "refund id")
        _require(refund.get("status") == "succeeded", f"refund {refund['id']} must explicitly declare status succeeded")
        payment = payment_map.get(refund.get("payment_id"))
        _require(payment is not None, f"refund {refund['id']} has unknown payment")
        refund["currency"] = _finance_currency(refund, payment["currency"])
        _require(refund["currency"] == payment["currency"], f"refund {refund['id']} currency mismatch")
        _finance_amount(refund.get("amount_cents"), f"refund {refund['id']} amount")
        _finance_date(refund.get("refunded_on"), f"refund {refund['id']} refunded_on")
        _require(refund["refunded_on"] <= _iso_day(anchor), f"refund {refund['id']} is after the world anchor")
        _require(refund["refunded_on"] >= payment["paid_on"], f"refund {refund['id']} predates payment")
        refunded[payment["id"]] = refunded.get(payment["id"], 0) + refund["amount_cents"]
        _require(refunded[payment["id"]] <= payment["amount_cents"], f"refunds exceed payment {payment['id']}")
    for order in orders.values():
        refund_total = sum(refunded.get(row["id"], 0) for row in payments if row.get("order_id") == order["id"])
        linked = order["id"] in order_invoices or any(row.get("order_id") == order["id"] for row in payments) or "payment_status" in order
        if order["status"] == "refunded" and linked:
            _require(refund_total == order["total_cents"], f"finance-linked refunded order {order['id']} needs a full refund")
        if order.get("payment_status") == "partially_refunded":
            _require(0 < refund_total < order["total_cents"], f"order {order['id']} needs a partial refund")
        if order.get("payment_status") == "refunded":
            _require(refund_total == order["total_cents"], f"order {order['id']} needs a full refund")
        if order.get("payment_status") == "paid":
            _require(refund_total == 0, f"order {order['id']} status must declare its refund")
    def pair(record, day, debit, credit):
        for side, account in (("debit", debit), ("credit", credit)):
            suffix = "receivable" if account == "accounts-receivable" else "cash" if account == "operating-cash" else "expense" if account == "operating-expense" else "revenue"
            ledger.append({"id": f"entry-{record['id']}-{suffix}", "record_id": record["id"], "date": day,
                "account": account, "currency": record["currency"], "debit_cents": record["amount_cents"] if side == "debit" else 0,
                "credit_cents": record["amount_cents"] if side == "credit" else 0})
    for invoice in invoices:
        if invoice["status"] not in {"draft", "void", "cancelled"}:
            pair(invoice, invoice["issued_on"], "accounts-receivable", _revenue_account(invoice, customers[invoice["customer_id"]]))
    for payment in payments:
        customer = customers[payment["customer_id"]]
        pair(payment, payment["paid_on"], "operating-cash", "accounts-receivable" if payment.get("invoice_id") else _revenue_account(payment, customer))
    for bill in bills:
        pair(bill, bill["issued_on"], "operating-expense", "operating-cash")
    for refund in refunds:
        payment = payment_map[refund["payment_id"]]
        origin = invoice_map[payment["invoice_id"]] if payment.get("invoice_id") else payment
        pair(refund, refund["refunded_on"], _revenue_account(origin, customers[payment["customer_id"]]), "operating-cash")
    _unique(ledger, "id", "ledger entry")
    return {"invoices": sorted(invoices, key=lambda row: (row["issued_on"], row["id"])),
        "bills": sorted(bills, key=lambda row: (row["issued_on"], row["id"])),
        "payments": sorted(payments, key=lambda row: (row["paid_on"], row["id"])),
        "refunds": sorted(refunds, key=lambda row: (row["refunded_on"], row["id"])),
        "ledger_entries": sorted(ledger, key=lambda row: (row["date"], row["id"]))}



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


GOOGLE_SYSTEM_LABELS = frozenset({
    "INBOX", "SENT", "UNREAD", "STARRED", "IMPORTANT", "TRASH", "SPAM", "DRAFT",
    "CATEGORY_PERSONAL", "CATEGORY_SOCIAL", "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_FORUMS",
})


def _google_message_owners(message: dict[str, Any]) -> set[str]:
    owners = set(message["to_ids"])
    if "SENT" in message["labels"]:
        owners.add(message["from_id"])
    return owners


def _google_mailboxes(world: dict[str, Any], resolved_mail: list[dict[str, Any]]) -> list[dict[str, Any]]:
    communication = world.get("communication", {})
    if "mailboxes" in communication:
        # An explicit empty array or subset is authoritative. Never infer a new
        # owner or label from a message when the author declared mailboxes.
        return copy.deepcopy(communication["mailboxes"])
    # Compatibility for old sources without this field: every person receives a
    # mailbox, with custom labels derived from current mail and Gmail arrivals.
    labels = {person["id"]: set() for person in world["people"]}
    for message in resolved_mail:
        for owner in _google_message_owners(message):
            labels[owner].update(set(message["labels"]) - GOOGLE_SYSTEM_LABELS)
    for event in world.get("timeline", []):
        payload = event.get("payload", {})
        if event["kind"] == "incoming-email" and payload.get("via", "smtp") == "gmail":
            labels[payload["to_id"]].update(set(payload.get("labels", ["INBOX", "UNREAD"])) - GOOGLE_SYSTEM_LABELS)
    return [{"owner_id": person["id"], "labels": sorted(labels[person["id"]])} for person in world["people"]]


def _validate_google_mailbox_declarations(world: dict[str, Any], people: dict[str, Any]) -> None:
    communication = world.get("communication", {})
    if "mailboxes" not in communication:
        return
    context = f"world {world['id']}:{world['version']} communication.mailboxes"
    rows = communication["mailboxes"]
    _require(isinstance(rows, list), f"{context} must be an array")
    owners = set()
    for row in rows:
        _require(isinstance(row, dict), f"{context} entries must be objects")
        owner = row.get("owner_id")
        _require(isinstance(owner, str) and owner in people, f"{context} has unknown owner {owner!r}")
        _require(owner not in owners, f"{context} has duplicate owner {owner}")
        owners.add(owner)
        labels = row.get("labels")
        _require(isinstance(labels, list), f"{context} owner {owner} labels must be an array")
        _require(all(isinstance(label, str) and bool(label.strip()) for label in labels), f"{context} owner {owner} labels must contain nonempty strings")
        _require(len(labels) == len(set(labels)), f"{context} owner {owner} labels contains duplicates")
        _require(not set(labels) & GOOGLE_SYSTEM_LABELS, f"{context} owner {owner} declares system labels as custom labels")


def _validate_google_mailbox_references(world: dict[str, Any], mailboxes: list[dict[str, Any]], resolved_mail: list[dict[str, Any]]) -> None:
    declared = {row["owner_id"]: set(row["labels"]) for row in mailboxes}

    def check(owner: str, labels: list[str], context: str) -> None:
        field = f"world {world['id']}:{world['version']} {context} labels"
        _require(isinstance(labels, list), f"{field} must be an array")
        _require(all(isinstance(label, str) and bool(label.strip()) for label in labels), f"{field} must contain nonempty strings")
        _require(len(labels) == len(set(labels)), f"{field} contains duplicates")
        missing = set(labels) - GOOGLE_SYSTEM_LABELS - declared[owner]
        _require(not missing, f"world {world['id']}:{world['version']} {context} owner {owner} has undeclared Gmail custom labels: {sorted(missing)}")

    for message in resolved_mail:
        for owner in _google_message_owners(message) & declared.keys():
            check(owner, message["labels"], f"communication.mail {message['id']}")
    for event in world.get("timeline", []):
        payload = event.get("payload", {})
        if event["kind"] != "incoming-email" or payload.get("via", "smtp") != "gmail":
            continue
        owner = payload.get("to_id")
        _require(isinstance(owner, str) and owner in declared, f"world {world['id']}:{world['version']} timeline {event['id']} payload.to_id Gmail recipient {owner} has no declared mailbox")
        check(owner, payload.get("labels", ["INBOX", "UNREAD"]), f"timeline {event['id']}")


def _validate_google_content_owners(world: dict[str, Any], mailboxes: list[dict[str, Any]]) -> None:
    people, _ = _person_maps(world)
    owner_ids = {row["owner_id"] for row in mailboxes}
    emails = {people[owner]["email"] for owner in owner_ids}
    primary = next((person for person in world["people"] if person.get("primary")), {})
    context = f"world {world['id']}:{world['version']} communication"
    communication = world.get("communication", {})
    calendar_owners = {}
    for row in communication.get("calendars", []):
        email = row.get("user_email", primary.get("email"))
        _require(isinstance(email, str) and email in emails, f"{context}.calendars {row.get('id')} user_email {email!r} has no declared Google mailbox/account")
        calendar_owners[row["id"]] = email
    for row in communication.get("calendar_events", []):
        email = row.get("user_email", calendar_owners.get(row.get("calendar_id"), primary.get("email")))
        _require(isinstance(email, str) and email in emails, f"{context}.calendar_events {row.get('id')} user_email {email!r} has no declared Google mailbox/account")
    for row in communication.get("documents", []):
        owner = row.get("owner_id")
        _require(isinstance(owner, str) and owner in owner_ids, f"{context}.documents {row.get('id')} owner_id {owner!r} has no declared Google mailbox/account")
        content = row.get("content", row.get("body_md", row.get("body", "")))
        _require(isinstance(content, str), f"{context}.documents {row.get('id')} content must be a string")


def _google_projection(world: dict[str, Any], resolved_mail: list[dict[str, Any]]) -> dict[str, Any]:
    people, _ = _person_maps(world)
    primary = next((person for person in world["people"] if person.get("primary")), {})
    mailboxes = _google_mailboxes(world, resolved_mail)
    _validate_google_mailbox_references(world, mailboxes, resolved_mail)
    _validate_google_content_owners(world, mailboxes)
    selected_owners = {row["owner_id"] for row in mailboxes}
    messages: list[dict[str, Any]] = []
    for message in resolved_mail:
        sender = people[message["from_id"]]
        recipients = [people[person_id] for person_id in message["to_ids"]]
        for owner_id in sorted(_google_message_owners(message) & selected_owners):
            provider_id = "wf_" + sha256(json.dumps(
                [world["id"], world["version"], owner_id, message["id"]],
                separators=(",", ":"), ensure_ascii=False,
            ).encode())[:32]
            messages.append(
                {
                    "id": provider_id,
                    "worldfixture_message_id": message["id"],
                    "worldfixture_owner_id": owner_id,
                    "user_email": people[owner_id]["email"],
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
    labels = [
        {"id": label, "name": label, "user_email": people[row["owner_id"]]["email"], "type": "user"}
        for row in mailboxes for label in row["labels"]
    ]
    communication = world["communication"]
    # World authoring uses calendar names, ISO start/end strings, and attendee
    # email strings. The upstream Google seed API uses summary, split temporal
    # fields, and attendee objects. Passing authoring records through unchanged
    # produces undefined summaries (calendarList returns 500) and loses event
    # times and attendees. Normalize at the projection boundary, not in routes.
    calendars = copy.deepcopy(communication.get("calendars", []))
    for calendar_row in calendars:
        calendar_row["summary"] = (
            calendar_row.get("summary") or calendar_row.get("name") or calendar_row.get("title") or calendar_row["id"]
        )
        calendar_row.setdefault("user_email", primary.get("email"))
        calendar_row.pop("name", None)
        calendar_row.pop("title", None)
    calendar_owners = {calendar["id"]: calendar["user_email"] for calendar in calendars if "id" in calendar}
    calendar_events = copy.deepcopy(communication.get("calendar_events", []))
    for event in calendar_events:
        event.setdefault("summary", event.get("title") or event.get("name") or event["id"])
        event.setdefault("user_email", calendar_owners.get(event.get("calendar_id"), primary.get("email")))
        for boundary in ("start", "end"):
            value = event.pop(boundary, None)
            if isinstance(value, str):
                field = f"{boundary}_date" if len(value) == 10 else f"{boundary}_date_time"
                event.setdefault(field, value)
            elif isinstance(value, dict):
                if "dateTime" in value:
                    event.setdefault(f"{boundary}_date_time", value["dateTime"])
                elif "date" in value:
                    event.setdefault(f"{boundary}_date", value["date"])
        event["attendees"] = [
            {"email": attendee} if isinstance(attendee, str) else copy.deepcopy(attendee)
            for attendee in event.get("attendees", [])
        ]
    return {
        "users": [
            {
                "email": person["email"],
                "name": person["name"],
                "email_verified": True,
                "worldfixture_person_id": person["id"],
            }
            for person in world["people"] if person["id"] in selected_owners
        ],
        "messages": sorted(messages, key=lambda item: (item["date"], item["id"])),
        "labels": labels,
        "calendars": calendars,
        "calendar_events": calendar_events,
        "drive_items": [
            {
                **copy.deepcopy(document),
                "worldfixture_document_id": document["id"],
                "worldfixture_owner_id": document["owner_id"],
                "user_email": people[document["owner_id"]]["email"],
                "name": document.get("name") or document.get("title") or document["id"],
                "mime_type": document.get("mime_type", "text/markdown"),
                "data": document.get("content", document.get("body_md", document.get("body", ""))),
            }
            for document in communication.get("documents", [])
        ],
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
                "family_name": " ".join(person["name"].split(maxsplit=1)[1:]),
                "tenant_id": main_org["id"],
                "worldfixture_person_id": person["id"],
            }
            for person in members
        ]
    }


def _notion_uuid(world_id: str, kind: str, source_id: str) -> str:
    """Return a stable, UUID-shaped Notion identifier for one world record."""
    digest = hashlib.sha256(f"worldfixture:notion:{world_id}:{kind}:{source_id}".encode()).hexdigest()[:32]
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
    members = world["people"]
    return {
        "users": [
            {
                "email": person["email"],
                "name": person["name"],
                "given_name": person["name"].split(maxsplit=1)[0],
                "family_name": " ".join(person["name"].split(maxsplit=1)[1:]),
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
    name = document.get("name") or document.get("title") or document["id"]
    tail = name.rsplit("/", 1)[-1]
    suffix = tail[tail.rfind(".") :] if "." in tail else ""
    return f"documents/{document['id']}{suffix}"


# The exported PROFILES["business.operations/v1"]["compile"] callback retains
# the reviewed cloud defaults for callers of that original adapter. The normal
# compile_world path removes undeclared IAM/SQS records from its output. New
# authored policies select their own operators, queues and roles.
LEGACY_OPERATOR_TEAMS = ["engineering"]
LEGACY_OPERATOR_LIMIT = 4
LEGACY_QUEUES = [
    {"name": "billing-events", "visibility_timeout": 30},
    {"name": "export-jobs", "visibility_timeout": 120},
    {"name": "export-jobs-dlq", "visibility_timeout": 30},
]
LEGACY_SERVICE_ROLES = [
    {"role_name": "billing-webhook", "path": "/services/", "description": "Receives billing events"},
    {"role_name": "export-worker", "path": "/services/", "description": "Processes customer exports"},
]


def _validate_aws_operators(world: dict[str, Any]) -> None:
    software = world.get("software", {})
    label = f"{world['id']}:{world['version']} software"
    organizations = {organization["id"] for organization in world["organizations"] if organization.get("primary")}
    members = [person for person in world["people"] if person["organization_id"] in organizations]
    if "operator_teams" in software:
        teams = software["operator_teams"]
        _require(isinstance(teams, list), f"{label}.operator_teams must be an array")
        _require(all(isinstance(team, str) and bool(team) for team in teams),
                 f"{label}.operator_teams must contain nonempty team names")
        _require(len(teams) == len(set(teams)), f"{label}.operator_teams contains duplicate teams")
        known = {person.get("team") for person in members}
        unknown = sorted(set(teams) - known)
        _require(not unknown, f"{label}.operator_teams names unknown primary-organization teams: {unknown}")
    if "operator_ids" in software:
        ids = software["operator_ids"]
        _require(isinstance(ids, list), f"{label}.operator_ids must be an array")
        _require(all(isinstance(person_id, str) and bool(person_id) for person_id in ids),
                 f"{label}.operator_ids must contain nonempty person IDs")
        _require(len(ids) == len(set(ids)), f"{label}.operator_ids contains duplicate person IDs")
        known = {person["id"] for person in world["people"]}
        unknown = sorted(set(ids) - known)
        _require(not unknown, f"{label}.operator_ids names unknown people: {unknown}")
        external = sorted(set(ids) - {person["id"] for person in members})
        _require(not external, f"{label}.operator_ids names people outside the primary organization: {external}")
    if "operator_limit" in software:
        limit = software["operator_limit"]
        _require(limit is None or (type(limit) is int and limit >= 0),
                 f"{label}.operator_limit must be null or a nonnegative integer")


def _aws_projection(world: dict[str, Any]) -> dict[str, Any]:
    from .sections import provider_world

    world = provider_world(world)
    people, _ = _person_maps(world)
    software = world.get("software", {})
    main_org = next(organization for organization in world["organizations"] if organization.get("primary"))
    members = [person for person in world["people"] if person["organization_id"] == main_org["id"]]
    # `.get("team")`, not `person["team"]`: a person without a team is not an
    # operator, and used to be an unhandled KeyError raised from a projection.
    explicit_selection = "operator_teams" in software or "operator_ids" in software
    operator_teams = set(software.get("operator_teams", [] if explicit_selection else LEGACY_OPERATOR_TEAMS))
    operator_ids = set(software.get("operator_ids", []))
    operator_limit = software.get("operator_limit", LEGACY_OPERATOR_LIMIT)
    operators = [person for person in members if (
        person.get("team") in operator_teams or person["id"] in operator_ids
        or (not explicit_selection and person.get("primary"))
    )]
    if explicit_selection or "operator_limit" in software:
        operators.sort(key=lambda person: person["id"])
    if operator_limit is not None:
        operators = operators[:operator_limit]
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
        "sqs": {"queues": copy.deepcopy(software.get("queues", LEGACY_QUEUES))},
        "iam": {
            "users": [
                {"user_name": person["github_login"], "path": "/people/", "create_access_key": False}
                for person in operators
            ],
            "roles": copy.deepcopy(software.get("service_roles", LEGACY_SERVICE_ROLES)),
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
                "last_name": " ".join(person["name"].split(maxsplit=1)[1:]),
                "audience": "Customers",
                "worldfixture_person_id": person["id"],
                "worldfixture_customer_id": customer["id"],
            }
        )
    return {
        "domains": [{"name": main_org["domain"], "region": "eu-west-1"}],
        "contacts": contacts,
    }


# The original business adapter retains these reviewed defaults. compile_world
# removes undeclared Slack bots; the legacy tracker team remains overridable by
# work.team. Independent section adapters derive their team from the world.
LEGACY_SLACK_BOTS = [{"name": "northstar-helper"}]
LEGACY_TRACKER_TEAM = {"key": "NSTAR", "name": "Northstar"}
def _mongoatlas_projection(world: dict[str, Any]) -> dict[str, Any]:
    main_org = next(organization for organization in world["organizations"] if organization.get("primary"))
    primary = next(person for person in world["people"] if person.get("primary"))
    database = world["software"]["database"]
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
        "bots": copy.deepcopy(world["communication"].get("bots", LEGACY_SLACK_BOTS)),
        "strict_scopes": False,
    }


def _github_projection(world: dict[str, Any]) -> dict[str, Any]:
    people, organizations = _person_maps(world)
    members = world["people"]
    users = [
        {
            "login": person["github_login"],
            "name": person["name"],
            "email": person["email"],
            "bio": person["role"],
            "company": organizations[person["organization_id"]]["name"],
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
                "collaborators": [
                    {"username": people[person_id]["github_login"], "permission": "push"}
                    for person_id in repository.get("member_ids", [])
                ],
            }
        )
    return {
        "users": users,
        "orgs": [
            {"login": organization["slug"], "name": organization["name"], "description": organization.get("summary", "")}
            for organization in world["organizations"]
        ],
        "repos": repos,
    }


def _clerk_projection(world: dict[str, Any]) -> dict[str, Any]:
    main_org = next(organization for organization in world["organizations"] if organization.get("primary"))
    members = [person for person in world["people"] if person["organization_id"] == main_org["id"]]
    return {
        "users": [
            {
                "first_name": person["name"].split(maxsplit=1)[0],
                "last_name": " ".join(person["name"].split(maxsplit=1)[1:]),
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
                "last_name": " ".join(person["name"].split(maxsplit=1)[1:]),
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
                "state": state_names.get(task["status"], task["status"]),
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
                    *[{"name": status, "type": "unstarted"} for status in sorted({task["status"] for task in world["work"]["tasks"]} - state_names.keys())],
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
    people, _ = _person_maps(world)
    finance = world["finance"]
    customers = finance["customers"]
    recurring = [customer for customer in customers if _billing_mode(customer) == "recurring_monthly"]
    plans = sorted({customer["service"] for customer in recurring})
    catalog = world.get("commerce", {}).get("products", [])
    for product in catalog:
        _require(product["name"] not in plans, f"catalog product {product['id']} is named after subscription plan")
    def fragment(value):
        return re.sub(r"[^a-zA-Z0-9]", "_", value)
    seen = set()
    def provider_id(prefix, source_id):
        value = f"{prefix}_{fragment(source_id)}"
        _require(value not in seen, f"Stripe ID collision for source record {source_id}: {value}")
        seen.add(value)
        return value
    def seconds(day):
        return int(datetime.fromisoformat(day).replace(tzinfo=UTC).timestamp())
    customer_ids = {row["id"]: provider_id("cus", row["id"]) for row in customers}
    product_ids = {name: provider_id("prod", fragment(name).lower()) for name in plans}
    price_ids = {row["id"]: provider_id("price", row["id"]) for row in recurring}
    result = {
        "customers": [{"id": customer_ids[row["id"]], "email": people[row["contact_id"]]["email"],
            "name": row["name"], "worldfixture_customer_id": row["id"]} for row in customers],
        "products": [{"id": product_ids[name], "name": name, "description": f"Monthly {name} subscription"} for name in plans],
        "prices": [{"id": price_ids[row["id"]], "product_name": row["service"],
            "currency": _finance_currency(row, finance["currency"]).lower(), "unit_amount": row["monthly_amount_cents"],
            "recurring": {"interval": "month"}, "worldfixture_customer_id": row["id"]} for row in recurring],
        "subscriptions": [{"id": provider_id("sub", row["id"]), "customer": customer_ids[row["id"]],
            "price": price_ids[row["id"]], "status": "active", "metadata": {"worldfixture_customer_id": row["id"]}} for row in recurring],
        "invoices": [],
        "transactions": {"payments": [], "refunds": []},
    }
    for product in catalog:
        result["products"].append({"id": provider_id("prod", product["id"]), "name": product["name"],
            "description": product.get("summary", product["name"]), "worldfixture_product_id": product["id"]})
        result["prices"].append({"id": provider_id("price", product["id"]), "product_name": product["name"],
            "currency": _finance_currency(product, finance["currency"]).lower(), "unit_amount": product["price_cents"],
            "worldfixture_product_id": product["id"]})
    invoice_ids = {}
    for invoice in finance["resolved"]["invoices"]:
        invoice_ids[invoice["id"]] = provider_id("in", invoice["id"])
        metadata = {"worldfixture_invoice_id": invoice["id"], "worldfixture_status": invoice["status"]}
        if "order_id" in invoice:
            metadata["worldfixture_order_id"] = invoice["order_id"]
        result["invoices"].append({"id": invoice_ids[invoice["id"]], "number": invoice["number"],
            "customer": customer_ids[invoice["customer_id"]], "description": invoice["description"],
            "currency": invoice["currency"].lower(), "status": "open" if invoice["status"] == "overdue" else invoice["status"],
            "created": seconds(invoice["issued_on"]), "due_date": seconds(invoice["due_on"]),
            "amount_due": invoice["amount_cents"], "metadata": metadata})
    payment_ids = {}
    for payment in finance["resolved"]["payments"]:
        payment_ids[payment["id"]] = provider_id("pi", payment["id"])
        metadata = {"worldfixture_payment_id": payment["id"], "worldfixture_customer_id": payment["customer_id"]}
        for name in ("invoice_id", "order_id"):
            if name in payment:
                metadata[f"worldfixture_{name}"] = payment[name]
        row = {"id": payment_ids[payment["id"]], "charge": provider_id("ch", payment["id"]),
            "customer": customer_ids[payment["customer_id"]], "amount": payment["amount_cents"],
            "currency": payment["currency"].lower(), "created": seconds(payment["paid_on"]), "metadata": metadata}
        if "invoice_id" in payment:
            row.update(invoice=invoice_ids[payment["invoice_id"]], invoice_payment=provider_id("inpay", payment["id"]))
        result["transactions"]["payments"].append(row)
    for refund in finance["resolved"]["refunds"]:
        result["transactions"]["refunds"].append({"id": provider_id("re", refund["id"]),
            "payment_intent": payment_ids[refund["payment_id"]], "amount": refund["amount_cents"],
            "currency": refund["currency"].lower(), "created": seconds(refund["refunded_on"]),
            "metadata": {"worldfixture_refund_id": refund["id"], "worldfixture_payment_id": refund["payment_id"]}})
    return result



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
    if web is None and "vercel" not in world.get("software", {}).get("oauth_clients", {}):
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
        "projects": [] if web is None else [
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
    for event in world.get("timeline", []):
        if event["kind"] != "incoming-email":
            continue
        payload = event["payload"]
        if payload.get("via", "smtp") != "gmail":
            continue
        sender = people[payload["from_id"]]
        recipient = people[payload["to_id"]]
        arrivals.append(
            {
                "after_seconds": event["after_seconds"],
                "via": "gmail",
                "worldfixture_owner_id": recipient["id"],
                "user": recipient["email"],
                "token_ref": f"google_token_{recipient['id']}",
                "message": {
                    "id": event["id"],
                    "thread_id": payload.get("thread_id", f"thread-{event['id']}"),
                    "from": f"{sender['name']} <{sender['email']}>",
                    "to": recipient["email"],
                    "subject": payload["subject"],
                    "snippet": payload.get("snippet", payload["body_text"][:160]),
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
        if name in world:
            packs[name] = copy.deepcopy(world[name])
    return packs


def _slack_ts(timestamp: str, sequence: int) -> str:
    """Render one authored time as a Slack `ts`.

    Slack orders a channel by this value, so it has to be derived from the
    authored time rather than from the clock at seed time. The sequence keeps two
    messages in the same second distinct and ordered.

    AN AUTHORED TIME WITH NO OFFSET IS UTC, SAID HERE EXPLICITLY. Left naive,
    `datetime.timestamp()` reads the zone of whatever machine is compiling, and
    the same world source then produces a different artifact. Measured on the v2
    world with the `Z` removed from one channel message: `artifact_sha256` came
    out c5c554ef under TZ=UTC, cde8b503 under TZ=Asia/Tokyo and 377d0209 under
    TZ=US/Pacific -- three artifacts from one source, on a compiler whose whole
    contract is that a world compiles to one digest.

    No committed world trips it, because every authored time carries `Z`, so
    this moves no world's bytes. Nothing refused a world that omitted one. The
    rest of the compiler already reads a bare authored time as UTC; see the
    `replace(tzinfo=timezone.utc)` in `_stripe_projection`.
    """
    when = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
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
    "communication": [("communication", "channels"), ("communication", "mail"), ("communication", "mailboxes"),
                      ("communication", "documents"), ("communication", "calendars"),
                      ("communication", "calendar_events")],
    "finance": [("finance", "customers"), ("finance", "suppliers"), ("finance", "anchor_invoices"), ("finance", "payments"), ("finance", "refunds")],
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

    # An invoice remains a financial record without its optional order link.
    # Only an order-only payment loses its required origin with the order.
    finance = world.get("finance", {})
    for invoice in finance.get("anchor_invoices", []):
        if invoice.get("order_id") not in orders:
            invoice.pop("order_id", None)
    if "payments" in finance:
        removed_payments = {row["id"] for row in finance["payments"]
                            if "order_id" in row and row["order_id"] not in orders and "invoice_id" not in row}
        finance["payments"] = [row for row in finance["payments"] if row["id"] not in removed_payments]
        for payment in finance["payments"]:
            if payment.get("order_id") not in orders:
                payment.pop("order_id", None)
        if "refunds" in finance:
            finance["refunds"] = [row for row in finance["refunds"] if row["payment_id"] not in removed_payments]
    if "finance" in dropped:
        for order in commerce.get("orders", []):
            order.pop("payment_status", None)
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

    # Keep only canonical references that survive the selected source closure.
    surviving_ids = set()
    def index_selected(value):
        if isinstance(value, dict):
            if isinstance(value.get("id"), str):
                surviving_ids.add(value["id"])
            for child in value.values():
                index_selected(child)
        elif isinstance(value, list):
            for child in value:
                index_selected(child)
    index_selected(world)
    def prune_metadata(value):
        if isinstance(value, dict):
            for field in ("support_case_id", "repository_id", "issue_id", "document_id", "story_id"):
                if field in value and value[field] not in surviving_ids:
                    value.pop(field)
            references = value.get("entity_refs")
            if isinstance(references, list):
                value["entity_refs"] = [item for item in references if item in surviving_ids]
            elif isinstance(references, dict):
                value["entity_refs"] = {key: item for key, item in references.items() if isinstance(item, str) and item in surviving_ids}
            for child in value.values():
                prune_metadata(child)
        elif isinstance(value, list):
            for child in value:
                prune_metadata(child)
    prune_metadata(world)
    if isinstance(world.get("agentic", {}).get("grounding"), list):
        world["agentic"]["grounding"] = [row for row in world["agentic"]["grounding"] if "entity_id" not in row or row["entity_id"] in surviving_ids]
    validate_world(world)
    return world


def compile_world(source: dict[str, Any]) -> dict[str, Any]:
    """Compile each declared canonical section and its applicable adapters."""
    from .sections import compile_sections, domain_projection, legacy_business_shape, provider_world

    validate_world(source)
    if not legacy_business_shape(source):
        return compile_sections(source)
    view = provider_world(source)
    view["software"].setdefault("repositories", [])
    view["work"].setdefault("time_entries", [])
    compiled = _compile_business_operations(view)
    # Native identity defaults belong only in provider projections.
    for name in ("people", "organizations"):
        compiled["world"][name] = copy.deepcopy(source[name])
        compiled["packs"]["identity"][name] = copy.deepcopy(source[name])
    for section, field in (("software", "repositories"), ("work", "time_entries")):
        if field not in source[section]:
            compiled["world"][section].pop(field, None)
            compiled["packs"][section].pop(field, None)
    projections = compiled["projections"]
    overlay = projections["emulator-overlay"]
    software = source.get("software", {})
    communication = source.get("communication", {})
    clients = source.get("software", {}).get("oauth_clients", {})
    if not clients.get("apple"):
        projections.pop("apple", None)
        overlay.pop("apple", None)
        overlay["tokens"].pop("apple_token", None)
    if "repositories" not in software:
        for provider in ("github", "vercel"):
            if provider not in clients:
                projections.pop(provider, None)
                overlay.pop(provider, None)
                overlay["tokens"].pop(f"{provider}_token", None)
    if "bots" not in communication:
        projections["slack"].pop("bots", None)
        overlay["slack"].pop("bots", None)
    if "queues" not in software:
        projections["aws"].pop("sqs", None)
        overlay["aws"].pop("sqs", None)
    if "service_roles" not in software:
        projections["aws"]["iam"].pop("roles", None)
        overlay["aws"]["iam"].pop("roles", None)
    if not {"operator_ids", "operator_teams"}.intersection(software):
        projections["aws"]["iam"].pop("users", None)
        overlay["aws"]["iam"].pop("users", None)
        if "service_roles" not in software:
            projections["aws"].pop("iam", None)
            overlay["aws"].pop("iam", None)
    for source_field, projection_field in (("calendars", "calendars"), ("calendar_events", "calendar_events"), ("documents", "drive_items")):
        if source_field not in communication:
            projections["google"].pop(projection_field, None)
            overlay["google"].pop(projection_field, None)
    compiled["projections"]["domain"] = domain_projection(compiled["world"], compiled["packs"])
    return compiled


def _compile_business_operations(source: dict[str, Any]) -> dict[str, Any]:
    anchor = datetime.fromisoformat(source["clock"]["anchor"].replace("Z", "+00:00")).astimezone(UTC).date()
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
    mongoatlas = _mongoatlas_projection(world) if "database" in world["software"] else None
    twilio = copy.deepcopy(world["communication"].get("twilio"))
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
    http_targets = _http_targets_from_site(world, finance, world["site"]) if "site" in world else None
    primary = next(person for person in world["people"] if person.get("primary"))
    emulator_google = copy.deepcopy(google)
    emulator_google["worldfixture_seed_version"] = 1
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
                **{key: copy.deepcopy(repository[key]) for key in ("owner", "name", "description", "language", "topics", "auto_init", "collaborators")},
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
                        **({"labels": copy.deepcopy(issue["labels"])} if "labels" in issue else {}),
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
        "worldfixture_seed_version": 1,
        "organization": copy.deepcopy(linear["organization"]),
        "users": [
            {key: copy.deepcopy(user[key]) for key in ("email", "name", "admin")}
            for user in linear["users"]
        ],
        "teams": copy.deepcopy(linear["teams"]),
        "labels": copy.deepcopy(linear["labels"]),
        "issues": [
            {key: copy.deepcopy(issue[key]) for key in ("team", "title", "description", "state", "assignee", "labels", "worldfixture_task_id", "worldfixture_project_id")}
            for issue in linear["issues"]
        ],
        "strict_scopes": False,
    }
    emulator_stripe = {
        "customers": [
            {key: copy.deepcopy(customer[key]) for key in ("id", "email", "name", "worldfixture_customer_id")}
            for customer in stripe["customers"]
        ],
        "products": [
            {key: copy.deepcopy(product[key]) for key in ("id", "name", "description")}
            for product in stripe["products"]
        ],
        "prices": [
            {key: copy.deepcopy(price[key]) for key in ("id", "product_name", "currency", "unit_amount")}
            | {key: copy.deepcopy(price[key]) for key in ("recurring", "worldfixture_customer_id") if key in price}
            for price in stripe["prices"]
        ],
        "subscriptions": copy.deepcopy(stripe["subscriptions"]),
        "invoices": copy.deepcopy(stripe["invoices"]),
        "transactions": copy.deepcopy(stripe["transactions"]),
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
    if emulator_mongoatlas is not None:
        for project in emulator_mongoatlas["projects"]:
            project.pop("worldfixture_organization_id", None)
        for user in emulator_mongoatlas["database_users"]:
            user.pop("worldfixture_person_id", None)
    emulator_twilio = copy.deepcopy(twilio)
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
    google_owner_ids = {user["worldfixture_person_id"] for user in google["users"]}
    person_google_tokens = {
        f"google_token_{person['id']}": {
            "login": person["email"],
            "scopes": ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.modify"],
        }
        for person in world["people"] if person["id"] in google_owner_ids
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
            **person_google_tokens,
            **({"demo_token": {"login": primary["email"], "scopes": ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.modify"]}}
               if primary["id"] in google_owner_ids else {}),
            "microsoft_token": {"login": primary["email"], "scopes": ["openid", "email", "profile", "User.Read", "User.ReadBasic.All"]},
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
            **({"mongoatlas_token": {"login": primary["github_login"], "scopes": []}} if mongoatlas is not None else {}),
            "okta_token": {"login": primary["email"], "scopes": ["openid", "profile", "email", "groups"]},
            "resend_token": {"login": "re_test_admin", "scopes": []},
            # The Slack emulator resolves a token by its own user id or user name.
            # The world's canonical `slack_id` is neither: seeding mints a fresh id,
            # and the world id collides with the upstream default admin. Name the
            # person instead, which the emulator matches and the world owns.
            "slack_token": {"login": primary_slack_name, "scopes": []},
            "stripe_token": {"login": "sk_test_admin", "scopes": []},
            **({"twilio_token": {"login": twilio["account"]["sid"], "scopes": []}} if twilio and twilio.get("account", {}).get("sid") else {}),
            "vercel_token": {"login": primary["github_login"], "scopes": []},
        },
        "microsoft": emulator_microsoft,
        "notion": copy.deepcopy(notion),
        "apple": emulator_apple,
        "aws": emulator_aws,
        "resend": emulator_resend,
        **({"mongoatlas": emulator_mongoatlas} if mongoatlas is not None else {}),
        **({"twilio": emulator_twilio} if twilio is not None else {}),
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
    for provider, clients in oauth_projection(world).items():
        overlay[provider].update(clients)
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
            **({"mongoatlas": mongoatlas} if mongoatlas is not None else {}),
            **({"twilio": twilio} if twilio is not None else {}),
            "slack": slack,
            "github": github,
            "clerk": clerk,
            "linear": linear,
            "okta": okta,
            "stripe": stripe,
            "vercel": vercel,
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


def _replace_artifact_directory(output: Path, files: dict[str, bytes]) -> None:
    """Publish a complete generation; keep the prior artifact if staging fails."""
    if output.is_symlink() or output.exists() and not output.is_dir():
        raise WorldError(f"Artifact output must be a directory, not a file or symlink: {output}")
    if output.exists() and any(output.iterdir()):
        try:
            previous = json.loads((output / "manifest.json").read_text())
        except (OSError, ValueError) as error:
            raise WorldError(f"Refusing to replace non-artifact output directory: {output}") from error
        if not isinstance(previous, dict) or previous.get("api_version") != "worldfixture.world-artifact/v1":
            raise WorldError(f"Refusing to replace non-artifact output directory: {output}")
        # Rebuilding may remove obsolete generated JSON, including files left by
        # older compiler versions. It must not delete unrelated user files.
        for path in output.rglob("*"):
            relative = path.relative_to(output)
            generated = (relative.as_posix() in {"manifest.json", "world.json", "timeline.json"}
                         or len(relative.parts) == 2 and relative.parts[0] in {"packs", "projections"}
                         and path.suffix == ".json")
            if path.is_symlink() or (not path.is_dir() and not generated):
                raise WorldError(f"Refusing to remove unrelated artifact output entry: {path}")
            if path.is_dir() and relative.as_posix() not in {"packs", "projections"}:
                raise WorldError(f"Refusing to remove unrelated artifact output directory: {path}")
    output.parent.mkdir(parents=True, exist_ok=True)
    workspace = Path(tempfile.mkdtemp(prefix=f".{output.name}-build-", dir=output.parent))
    backup = workspace / "previous"
    try:
        staged = workspace / "artifact"
        staged.mkdir()
        for name, data in files.items():
            target = staged / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        existed = output.exists()
        if existed:
            output.rename(backup)
        try:
            staged.rename(output)
        except OSError:
            if existed:
                try:
                    backup.rename(output)
                except OSError as error:
                    raise WorldError(f"Artifact replacement and rollback failed; previous artifact retained at {backup}") from error
            raise
        if existed:
            shutil.rmtree(backup)
    finally:
        # A failed rollback must not erase the only surviving prior artifact.
        # Leave that backup at its named path for recovery.
        if not backup.exists():
            shutil.rmtree(workspace)


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

    _replace_artifact_directory(output, files)
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
