"""Canonical sections do not imply an entire business or a provider account."""

from __future__ import annotations

import copy
import hashlib
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

RECORD_COLLECTIONS = {
    "identity": ("organizations", "people"),
    "communication": ("channels", "mail", "documents", "calendars", "calendar_events"),
    "software": ("repositories",),
    "finance": ("customers", "suppliers", "invoices", "bills", "payments", "refunds", "ledger_entries"),
    "work": ("projects", "tasks", "time_entries"),
    "support": ("cases",),
    "commerce": ("products", "orders"),
    "social": ("posts", "reviews", "comments"),
}
SECTION_NAMES = ("communication", "software", "finance", "work", "support", "commerce", "social", "agentic", "site")


def domain_projection(world: dict[str, Any], packs: dict[str, Any]) -> dict[str, Any] | None:
    configuration_arrays = {
        "communication": {"mailboxes", "bots", "resolved_mail"},
        "software": {"queues", "service_roles", "operator_ids", "operator_teams"},
    }
    collections = {
        f"{pack}.{field}": copy.deepcopy(records)
        for pack, value in packs.items()
        for field, records in value.items()
        if field not in configuration_arrays.get(pack, set())
        and isinstance(records, list)
        and (
            field in RECORD_COLLECTIONS.get(pack, ())
            or all(isinstance(row, dict) and isinstance(row.get("id"), str) for row in records)
        )
    }
    if not collections:
        return None
    return {
        "api_version": "worldfixture.domain/v1",
        "world": {"id": world["id"], "version": world["version"]},
        "collections": collections,
    }


def schema_validator(name: str, *, format_checker=None):
    """Resolve the published shared schemas from this installation, offline."""
    from jsonschema import Draft202012Validator, RefResolver

    directory = Path(__file__).resolve().parents[2] / "schemas"
    if not directory.is_dir():
        directory = Path(sys.prefix) / "share" / "worldfixture" / "schemas"
    documents = [json.loads(path.read_text()) for path in directory.glob("*.schema.json")]
    store = {document["$id"]: document for document in documents if "$id" in document}
    schema = json.loads((directory / name).read_text())

    def reject_remote(uri):
        raise ValueError(f"schema reference is not installed: {uri}")

    resolver = RefResolver.from_schema(
        schema, store=store, handlers={"https": reject_remote, "http": reject_remote, "file": reject_remote}
    )
    return Draft202012Validator(schema, resolver=resolver, format_checker=format_checker)


def validate_schema(name: str, value: Any, context: str) -> None:
    from .compiler import WorldError

    errors = sorted(schema_validator(name).iter_errors(value), key=lambda error: str(list(error.path)))
    if errors:
        error = errors[0]
        path = ".".join(str(part) for part in error.path)
        raise WorldError(f"{context}{'.' + path if path else ''}: {error.message}")


def provider_world(source: dict[str, Any]) -> dict[str, Any]:
    """Derive native identifiers in a private projection view, never in packs."""
    world = copy.deepcopy(source)
    native_logins: set[str] = set()
    slack_ids: set[str] = set()
    for person in world.get("people", []):
        source_id = person["id"]
        login = person.get("github_login")
        if login is None:
            slug = re.sub(r"[^a-z0-9-]", "-", source_id).strip("-")[:24]
            from .compiler import LOGIN_PATTERN

            login = (
                source_id
                if LOGIN_PATTERN.fullmatch(source_id)
                else f"{slug}-{hashlib.sha256(source_id.encode()).hexdigest()[:10]}"
            )
            person["github_login"] = login
        slack_id = person.setdefault("slack_id", "U" + hashlib.sha256(source_id.encode()).hexdigest()[:10].upper())
        from .compiler import _require

        _require(login not in native_logins, f"derived GitHub login collision for person {source_id}")
        _require(slack_id not in slack_ids, f"derived Slack ID collision for person {source_id}")
        native_logins.add(login)
        slack_ids.add(slack_id)
        person.setdefault("role", "")
        person.setdefault("team", person.get("organization_id") or "")
    for organization in world.get("organizations", []):
        organization.setdefault("slug", organization["id"])
        organization.setdefault("summary", "")
    return world


def legacy_business_shape(world: dict[str, Any]) -> bool:
    """The original finance/history adapter remains for its explicit contract."""
    return (
        world.get("profile") == "business.operations/v1"
        and all(
            isinstance(world.get(name), dict)
            for name in ("communication", "software", "finance", "work", "support", "agentic")
        )
        and isinstance(world.get("stories"), list)
        and any(row.get("primary") for row in world.get("people", []))
        and any(row.get("primary") for row in world.get("organizations", []))
        and {"history_months", "currency", "customers", "suppliers", "anchor_invoices", "billing_owner_id"}
        <= world["finance"].keys()
        and {"channels", "mail"} <= world["communication"].keys()
        and {"projects", "tasks"} <= world["work"].keys()
        and world["agentic"].get("actor_id") is not None
        and all(person.get("email") and person.get("organization_id") for person in world.get("people", []))
        and all({"name", "description", "language", "topics", "owner_id"} <= row.keys() for row in world["software"].get("repositories", []))
        and all({"name", "owner_id", "status", "target_on"} <= row.keys() for row in world["work"]["projects"])
        and all({"title", "description", "project_id", "assignee_id", "reporter_id", "status", "priority", "due_on"} <= row.keys() for row in world["work"]["tasks"])
        and all(row.get("project_id") and row.get("assignee_id") and row.get("reporter_id") for row in world["work"]["tasks"])
    )


def validate_structure(world: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    from . import compiler as c

    context = f"world {world['id']}:{world['version']}"
    for name in SECTION_NAMES:
        if name in world:
            c._require(isinstance(world[name], dict), f"{context} {name} must be an object")
    for name in ("people", "organizations", "stories", "records", "timeline"):
        if name in world:
            c._require(isinstance(world[name], list), f"{context} {name} must be an array")
    rows: dict[str, list[dict[str, Any]]] = {}
    for pack, fields in RECORD_COLLECTIONS.items():
        section = world if pack == "identity" else world.get(pack, {})
        for field in fields:
            if field not in section:
                continue
            label = f"{context} {pack}.{field}"
            values = section[field]
            c._require(isinstance(values, list), f"{label} must be an array")
            c._require(all(isinstance(row, dict) for row in values), f"{label} entries must be objects")
            c._unique(values, "id", label)
            for row in values:
                c._check_id(row.get("id"), f"{label} id")
            rows[f"{pack}.{field}"] = values
    if "anchor_invoices" in world.get("finance", {}):
        c._unique(world["finance"]["anchor_invoices"], "id", f"{context} finance.anchor_invoices")
    return rows


def validate_sections(world: dict[str, Any]) -> None:
    from . import compiler as c

    context = f"world {world['id']}:{world['version']}"
    rows = validate_structure(world)
    organizations = c._unique(world.get("organizations", []), "id", "organization")
    people = c._unique(world.get("people", []), "id", "person")
    for kind, values in (("organization", organizations), ("person", people)):
        c._require(sum(bool(row.get("primary")) for row in values.values()) <= 1, f"world has multiple primary {kind}s")
        for row in values.values():
            c._require(
                isinstance(row.get("name"), str) and bool(row["name"].strip()), f"{kind} {row['id']} needs a name"
            )
    for row in organizations.values():
        if "domain" in row:
            c._check_reserved_test_domain(row["domain"], f"organization domain for {row['id']}")
    emails: set[str] = set()
    logins: set[str] = set()
    slack_ids: set[str] = set()
    for person in people.values():
        if person.get("organization_id") is not None:
            c._require(
                isinstance(person["organization_id"], str) and person["organization_id"] in organizations,
                f"person {person['id']} has unknown organization",
            )
        if "email" in person:
            c._check_reserved_test_domain(person["email"], f"person email for {person['id']}")
            c._require(person["email"] not in emails, f"duplicate person email: {person['email']}")
            emails.add(person["email"])
        if "github_login" in person:
            login = person["github_login"]
            c._require(
                isinstance(login, str) and bool(c.LOGIN_PATTERN.fullmatch(login)),
                f"invalid GitHub login for {person['id']}",
            )
            c._require(login not in logins, f"duplicate GitHub login: {login}")
            logins.add(login)
        if "slack_id" in person:
            value = person["slack_id"]
            c._require(isinstance(value, str) and value.startswith("U"), f"invalid Slack id for {person['id']}")
            c._require(value not in slack_ids, f"duplicate Slack id: {value}")
            slack_ids.add(value)

    # Index nested canonical records too. Provider-native names and arbitrary
    # prose are not treated as canonical references.
    global_ids: set[str] = set()

    def index(value: Any) -> None:
        if isinstance(value, dict):
            if isinstance(value.get("id"), str):
                global_ids.add(value["id"])
            for child in value.values():
                index(child)
        elif isinstance(value, list):
            for child in value:
                index(child)

    index(world)
    finance = world.get("finance", {})
    invoice_ids = {row["id"] for row in finance.get("anchor_invoices", [])} | {
        row["id"] for row in rows.get("finance.invoices", [])
    }
    if {"history_months", "currency", "customers", "suppliers", "anchor_invoices"} <= finance.keys():
        resolved = c._expand_finance(
            world, datetime.fromisoformat(world["clock"]["anchor"].replace("Z", "+00:00")).date()
        )
        index(resolved)
        invoice_ids |= {row["id"] for row in resolved["invoices"]}
    refs = {
        "invoice_id": invoice_ids,
        "payment_id": {row["id"] for row in rows.get("finance.payments", [])},
        "document_id": {row["id"] for row in rows.get("communication.documents", [])},
        "support_case_id": {row["id"] for row in rows.get("support.cases", [])},
        "repository_id": {row["id"] for row in rows.get("software.repositories", [])},
        "issue_id": {issue["id"] for row in rows.get("software.repositories", []) for issue in row.get("issues", [])},
        "story_id": {row["id"] for row in world.get("stories", [])},
        "organization_id": set(organizations),
        "person_id": set(people),
        "actor_id": set(people),
        "author_id": set(people),
        "assignee_id": set(people),
        "reporter_id": set(people),
        "contact_id": set(people),
        "shopper_id": set(people),
        "from_id": set(people),
        "to_id": set(people),
        "billing_owner_id": set(people),
        "customer_id": {row["id"] for row in rows.get("finance.customers", [])},
        "supplier_id": {row["id"] for row in rows.get("finance.suppliers", [])},
        "product_id": {row["id"] for row in rows.get("commerce.products", [])},
        "order_id": {row["id"] for row in rows.get("commerce.orders", [])},
        "project_id": {row["id"] for row in rows.get("work.projects", [])},
        "task_id": {row["id"] for row in rows.get("work.tasks", [])},
        "calendar_id": {row["id"] for row in rows.get("communication.calendars", [])},
        "post_id": {row["id"] for row in rows.get("social.posts", [])},
        "review_id": {row["id"] for row in rows.get("social.reviews", [])},
        "channel_id": {row["id"] for row in rows.get("communication.channels", [])},
    }

    def references(value: Any, path: str) -> None:
        if isinstance(value, list):
            for number, child in enumerate(value):
                references(child, f"{path}[{number}]")
        elif isinstance(value, dict):
            for field, target in value.items():
                location = f"{path}.{field}"
                expected = refs.get(field)
                if field == "owner_id":
                    expected = set(organizations) if path.startswith("software.repositories[") else set(people)
                if expected is not None and target is not None:
                    c._require(
                        isinstance(target, str) and target in expected,
                        f"{context} {location} has unknown reference {target!r}",
                    )
                if field in {"member_ids", "to_ids", "participant_ids", "attendee_ids", "operator_ids", "product_ids"}:
                    expected = refs["product_id"] if field == "product_ids" else set(people)
                    c._require(
                        isinstance(target, list) and all(isinstance(item, str) and item in expected for item in target),
                        f"{context} {location} has unknown references",
                    )
                if field == "entity_refs":
                    targets = (
                        target.values() if isinstance(target, dict) else target if isinstance(target, list) else []
                    )
                    for reference in targets:
                        for item in reference if isinstance(reference, list) else [reference]:
                            c._require(
                                isinstance(item, str) and item in global_ids,
                                f"{context} {location} has unknown reference {item!r}",
                            )
                if field not in {"causal_rules", "oauth_clients"}:
                    references(target, location)

    c._validate_commerce(world, people)
    c._validate_social(
        world,
        people,
        {row["id"]: row for row in rows.get("commerce.products", [])},
        {row["id"]: row for row in rows.get("commerce.orders", [])},
    )
    c._validate_google_mailbox_declarations(world, people)
    for key, value in world.items():
        if key != "timeline":
            references(value, key)
    for reference in world.get("agentic", {}).get("grounding", []):
        if "entity_id" in reference:
            c._require(
                reference["entity_id"] in global_ids,
                f"{context} agentic.grounding has unknown reference {reference['entity_id']!r}",
            )
    for message in rows.get("communication.mail", []):
        labels = message.get("labels")
        c._require(
            isinstance(labels, list) and all(isinstance(label, str) and label.strip() for label in labels),
            f"{context} communication.mail {message['id']} labels must be nonempty strings",
        )
        c._require(
            isinstance(message.get("to_ids"), list) and bool(message["to_ids"]), f"mail {message['id']} needs to_ids"
        )
        for field in ("from_id", "subject", "body_text", "sent_at", "thread_id"):
            c._require(isinstance(message.get(field), str), f"mail {message['id']} needs {field}")
        for person_id in [message["from_id"], *message["to_ids"]]:
            c._require(people[person_id].get("email"), f"mail {message['id']} person {person_id} needs email")
    timeline_world = copy.deepcopy(world)
    timeline_world["timeline"] = []
    for event in world.get("timeline", []):
        label = f"{context} timeline {event['id']}"
        c._require(
            event.get("kind") in c.TIMELINE_KINDS | {"domain-operation"},
            f"unsupported timeline kind: {event.get('kind')}",
        )
        payload = event.get("payload", {})
        c._require(isinstance(payload, dict), f"{label}.payload must be an object")
        reference_payload = payload
        if event["kind"] == "stripe-payment" or (
            event["kind"] in {"webhook", "application-event"} and payload.get("event") == "finance.invoice.paid"
        ):
            # This field names the new payment, rather than an existing record.
            reference_payload = {key: value for key, value in payload.items() if key != "payment_id"}
            if "payment_id" in payload:
                c._check_id(payload["payment_id"], f"{label} payload.payment_id")
                if event["kind"] == "stripe-payment":
                    c._require(payload["payment_id"] not in refs["payment_id"], f"{label} payment already exists")
        if event["kind"] != "domain-operation":
            references(reference_payload, f"timeline {event['id']} payload")
        if event["kind"] == "domain-operation":
            validate_schema("runtime-operation.v1.schema.json", payload, label)
            record = payload["record"]
            collection = {
                "commerce.order.place.v1": "commerce.orders",
                "social.post.publish.v1": "social.posts",
                "social.review.publish.v1": "social.reviews",
                "social.comment.publish.v1": "social.comments",
            }[payload["type"]]
            pack, field = collection.split(".")
            c._require(field in world.get(pack, {}), f"{label} requires declared {collection}")
            c._require(
                record["id"] not in {row["id"] for row in rows.get(collection, [])},
                f"{label} record already exists: {record['id']}",
            )
            c._require(payload["actor_id"] in people, f"{label} payload.actor_id has unknown person")
            candidate = copy.deepcopy(timeline_world)
            candidate[pack][field].append(copy.deepcopy(record))
            candidate["timeline"] = []
            validate_sections(candidate)
            timeline_world = candidate
        if event["kind"] == "incoming-email":
            labels = payload.get("labels", ["INBOX", "UNREAD"])
            c._require(
                isinstance(labels, list) and all(isinstance(label, str) and label.strip() for label in labels),
                f"{label} payload.labels must contain nonempty strings",
            )
            for field in ("subject", "body_text"):
                c._require(isinstance(payload.get(field), str), f"{label} payload.{field} must be a string")
            for field in ("from_id", "to_id"):
                c._require(
                    isinstance(payload.get(field), str) and payload[field] in people,
                    f"{label} payload.{field} has unknown person",
                )
                c._require(people[payload[field]].get("email"), f"{label}.{field} needs a person with email")
            c._require(payload.get("via", "smtp") in {"smtp", "gmail"}, f"{label}.via is unsupported")
        if event["kind"] == "chat-message":
            c._require(
                payload.get("author_id") in people and payload.get("channel_id") in refs["channel_id"],
                f"{label} has unknown author/channel",
            )
        if event["kind"] == "github-comment":
            issues = {
                issue["id"]
                for repository in rows.get("software.repositories", [])
                for issue in repository.get("issues", [])
            }
            c._require(
                payload.get("author_id") in people and payload.get("issue_id") in issues,
                f"{label} has unknown author/issue",
            )
        if event["kind"] == "stripe-payment":
            c._require(payload.get("customer_id") in refs["customer_id"], f"{label} has unknown customer")
            c._require(
                type(payload.get("amount_cents")) is int and payload["amount_cents"] > 0, f"{label} has invalid amount"
            )
        if event["kind"] == "s3-object":
            c._require(payload.get("bucket") in c._projected_bucket_names(world), f"{label} writes to unknown bucket")
            c._require(isinstance(payload.get("key"), str) and bool(payload["key"]), f"{label} needs object key")
    communication = world.get("communication", {})
    if "mailboxes" in communication:
        c._validate_google_mailbox_references(world, communication["mailboxes"], communication.get("mail", []))
        c._validate_google_content_owners(world, communication["mailboxes"])
    for item in world.get("site", {}).get("feed", {}).get("items", []):
        if "arrival_id" in item:
            c._require(
                item["arrival_id"] in {event["id"] for event in world.get("timeline", [])},
                f"{context} site feed item {item.get('id')} names unknown arrival {item['arrival_id']}",
            )
    for channel in rows.get("communication.channels", []):
        messages = channel.get("messages", [])
        c._unique(messages, "id", f"channel {channel['id']} messages")
        for message in messages:
            for field in ("text", "timestamp", "author_id"):
                c._require(
                    isinstance(message.get(field), str),
                    f"channel {channel['id']} message {message['id']} needs {field}",
                )
    for task in rows.get("work.tasks", []):
        for field in ("title", "status"):
            c._require(isinstance(task.get(field), str) and bool(task[field]), f"task {task['id']} needs {field}")
        c._require(
            isinstance(task.get("labels", []), list)
            and all(isinstance(label, str) for label in task.get("labels", [])),
            f"task {task['id']} labels must be strings",
        )
    for entry in rows.get("work.time_entries", []):
        c._require(
            type(entry.get("minutes")) is int and entry["minutes"] > 0,
            f"time entry {entry['id']} needs positive minutes",
        )
    for rule in world.get("agentic", {}).get("causal_rules", []):
        if rule.get("api_version") == "worldfixture.causal-rule/v1":
            validate_schema("causal-rule.v1.schema.json", rule, f"{context} causal rule {rule.get('id')}")
        else:
            c._require(
                rule.get("execution") == "descriptive"
                and isinstance(rule.get("reason"), str)
                and bool(rule["reason"].strip()),
                f"{context} causal rule {rule.get('id')} must be executable or explicitly descriptive with reason",
            )


def compile_sections(source: dict[str, Any]) -> dict[str, Any]:
    """Compile declared canonical records first; provider adapters follow."""
    world = copy.deepcopy(source)
    packs: dict[str, Any] = {}
    identity = {key: copy.deepcopy(world[key]) for key in RECORD_COLLECTIONS["identity"] if key in world}
    if identity:
        packs["identity"] = identity
    for section in RECORD_COLLECTIONS:
        if section != "identity" and section in world:
            packs[section] = copy.deepcopy(world[section])
    finance = world.get("finance", {})
    if {"history_months", "currency", "customers", "suppliers", "anchor_invoices"} <= finance.keys():
        from . import compiler as c

        resolved = c._expand_finance(
            world, datetime.fromisoformat(world["clock"]["anchor"].replace("Z", "+00:00")).date()
        )
        world["finance"]["resolved"] = resolved
        packs["finance"] = {
            **copy.deepcopy(resolved),
            **{field: copy.deepcopy(finance[field]) for field in ("customers", "suppliers") if field in finance},
        }
        if "billing_owner_id" in finance and "mail" in world.get("communication", {}):
            messages = copy.deepcopy(world["communication"]["mail"]) + c._invoice_mail(world, resolved)
            messages.sort(key=lambda message: (message["sent_at"], message["id"]))
            world["communication"]["resolved_mail"] = messages
            packs["communication"]["mail"] = copy.deepcopy(messages)
    elif "anchor_invoices" in finance:
        packs["finance"]["invoices"] = packs["finance"].pop("anchor_invoices")
    from .section_projections import compile_projections

    projections = compile_projections(world, packs)
    domain = domain_projection(world, packs)
    if domain is not None:
        projections["domain"] = domain
    return {
        "world": world,
        "timeline": copy.deepcopy(world.get("timeline", [])),
        "packs": packs,
        "projections": projections,
    }
