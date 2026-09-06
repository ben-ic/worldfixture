"""Provider adapters for independently declared canonical sections."""

from __future__ import annotations

import copy
import hashlib
import re
from typing import Any


def compile_projections(source: dict[str, Any], packs: dict[str, Any]) -> dict[str, Any]:
    from . import compiler as c
    from .sections import provider_world

    world = provider_world(source)
    people = world.get("people", [])
    by_id = {person["id"]: person for person in people}
    organizations = world.get("organizations", [])
    organization = next((row for row in organizations if row.get("primary")), None)
    workspace = organization or {
        "id": world["id"],
        "name": world["title"],
        "slug": re.sub(r"[^a-z0-9-]", "-", world["id"]),
    }
    primary = next((person for person in people if person.get("primary")), None)
    email_people = [person for person in people if person.get("email")]
    email_actor = next(
        (person for person in email_people if person.get("primary")), None
    )
    communication = world.get("communication", {})
    work = world.get("work", {})
    software = world.get("software", {})
    oauth = c.oauth_projection(world)
    projections: dict[str, Any] = {}
    overlay: dict[str, Any] = {
        "tokens": {},
        "worldfixture": {"arrivals": c._arrival_projection({**world, "people": people})},
    }

    def token(name: str, login: str | None, scopes: list[str] | None = None) -> None:
        if login is not None:
            overlay["tokens"][name] = {"login": login, "scopes": scopes or []}

    # SMTP identity needs an email, not a GitHub account or a primary actor.
    mail_declared = "mail" in communication or any(
        event.get("kind") == "incoming-email" for event in world.get("timeline", [])
    )
    if mail_declared:
        messages = copy.deepcopy(packs.get("communication", {}).get("mail", []))
        projections["mail"] = c._mail_projection(
            {**world, "people": email_people, "organizations": organizations}, messages
        )

    google_fields = {"mail", "mailboxes", "documents", "calendars", "calendar_events"}
    google_communication = copy.deepcopy(communication)
    email_ids = {person["id"] for person in email_people}
    if "mailboxes" not in communication and any(document.get("owner_id") not in email_ids for document in communication.get("documents", [])):
        # The canonical document stays in domain/Notion/S3. Google Drive is
        # unavailable when its owners have no Google account email.
        google_communication.pop("documents", None)
    if google_fields.intersection(google_communication) or "google" in oauth:
        messages = copy.deepcopy(packs.get("communication", {}).get("mail", []))
        for message in messages:
            message.setdefault("snippet", message["body_text"][:160])
        google_world = {**world, "people": email_people, "organizations": organizations, "communication": google_communication}
        google = c._google_projection(google_world, messages)
        for field in ("calendars", "calendar_events"):
            if field not in communication:
                google.pop(field, None)
        if "documents" not in google_communication:
            google.pop("drive_items", None)
        if "mail" not in communication:
            google.pop("messages", None)
        projections["google"] = google
        overlay["google"] = copy.deepcopy(google)
        overlay["google"]["worldfixture_seed_version"] = 1
        for message in overlay["google"].get("messages", []):
            message.pop("worldfixture_entity_refs", None)
        scopes = ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.modify"]
        for user in google["users"]:
            token(f"google_token_{user['worldfixture_person_id']}", user["email"], scopes)
        selected = {user["worldfixture_person_id"] for user in google["users"]}
        if email_actor and email_actor["id"] in selected:
            token("demo_token", email_actor["email"], scopes)

    if "channels" in communication or "bots" in communication or "slack" in oauth:
        users = [
            {
                "id": person["slack_id"],
                "name": person["github_login"],
                "real_name": person["name"],
                **({"email": person["email"]} if person.get("email") else {}),
                "profile": {
                    "title": person.get("role", ""),
                    "status_text": person.get("status", ""),
                    "status_emoji": person.get("status_emoji", ""),
                },
                "presence": "active" if person.get("primary") else "away",
                "worldfixture_person_id": person["id"],
            }
            for person in people
        ]
        channels = [
            {
                "id": row["id"],
                "name": row.get("name", row["id"]),
                "topic": row.get("topic", ""),
                "member_ids": [by_id[person]["slack_id"] for person in row.get("member_ids", [])],
                "messages": [
                    {
                        "id": message["id"],
                        "user": by_id[message["author_id"]]["slack_id"],
                        "text": message["text"],
                        "timestamp": message["timestamp"],
                        "worldfixture_entity_refs": copy.deepcopy(message.get("entity_refs", {})),
                    }
                    for message in row.get("messages", [])
                ],
            }
            for row in communication.get("channels", [])
        ]
        slack = {
            "team": {"name": workspace["name"], "domain": workspace.get("domain", workspace["slug"]).split(".")[0]},
            "users": users,
            "channels": channels,
            "strict_scopes": False,
        }
        if "bots" in communication:
            slack["bots"] = copy.deepcopy(communication["bots"])
        projections["slack"] = slack
        overlay["slack"] = {
            "team": copy.deepcopy(slack["team"]),
            "users": [
                {key: value for key, value in user.items() if key not in {"id", "worldfixture_person_id"}}
                for user in users
            ],
            "channels": c._emulator_slack_channels(slack),
            "strict_scopes": False,
            **({"bots": copy.deepcopy(slack["bots"])} if "bots" in slack else {}),
        }
        for person in people:
            token(f"slack_token_{person['id']}", person["github_login"])
        token("slack_token", primary["github_login"] if primary else None)

    if {"projects", "tasks", "team"}.intersection(work) or "linear" in oauth:
        team = copy.deepcopy(
            work.get("team", {"key": re.sub(r"[^A-Z0-9]", "", world["id"].upper())[:12], "name": workspace["name"]})
        )
        # Unfamiliar source statuses are retained as names. A provider state
        # type is supplied explicitly when the source declares team.states.
        state_types = {
            "backlog": "backlog",
            "ready": "unstarted",
            "in-progress": "started",
            "blocked": "started",
            "review": "started",
            "done": "completed",
        }
        states = copy.deepcopy(team.get("states", []))
        for task in work.get("tasks", []):
            status = task.get("status")
            if status and not any(state["name"] == status for state in states):
                states.append({"name": status, "type": state_types.get(status, "unstarted")})
        team["states"] = states
        issues = []
        for task in work.get("tasks", []):
            issue = {
                "team": team["key"],
                "title": task["title"],
                "description": task.get("description", ""),
                "state": task.get("status"),
                "labels": copy.deepcopy(task.get("labels", [])),
                "worldfixture_task_id": task["id"],
                "worldfixture_project_id": task.get("project_id"),
            }
            if task.get("assignee_id"):
                issue["assignee"] = by_id[task["assignee_id"]].get("email")
            issues.append(issue)
        linear = {
            "organization": {"name": workspace["name"], "url_key": workspace["slug"]},
            "users": [
                {
                    "email": person["email"],
                    "name": person["name"],
                    "admin": bool(person.get("primary")),
                    "worldfixture_person_id": person["id"],
                }
                for person in email_people
            ],
            "teams": [team],
            "labels": [
                {"name": name, "team": team["key"], "color": "#2563eb"}
                for name in sorted({label for task in work.get("tasks", []) for label in task.get("labels", [])})
            ],
            "issues": issues,
        }
        projections["linear"] = linear
        overlay["linear"] = {**copy.deepcopy(linear), "worldfixture_seed_version": 1, "strict_scopes": False}
        for person in email_people:
            token(f"linear_token_{person['id']}", person["email"])
        token("linear_token", email_actor["email"] if email_actor else None)

    if "documents" in communication or "projects" in work:

        def native_id(kind, source_id):
            return c._notion_uuid(world["id"], kind, source_id)

        users = [
            {
                "id": native_id("user", person["id"]),
                "name": person["name"],
                "email": person["email"],
                "worldfixture_person_id": person["id"],
            }
            for person in email_people
        ]
        user_ids = {user["worldfixture_person_id"]: user["id"] for user in users}
        pages = []
        for kind, values in (("document", communication.get("documents", [])), ("project", work.get("projects", []))):
            for record in values:
                title = record.get("name", record.get("title", record["id"]))
                text = (
                    record.get("content", record.get("body_md", record.get("body", "")))
                    if kind == "document"
                    else record.get("summary", record.get("description", ""))
                )
                page = {
                    "id": native_id("page", record["id"]),
                    "title": title,
                    "children": [{"type": "paragraph", "text": text}],
                    f"worldfixture_{kind}_id": record["id"],
                    "accessible_by": list(user_ids.values()),
                }
                if record.get("owner_id"):
                    page["worldfixture_owner_id"] = record["owner_id"]
                    if record["owner_id"] in user_ids:
                        page["created_by"] = user_ids[record["owner_id"]]
                if record.get("modified_at"):
                    page["last_edited_time"] = record["modified_at"]
                pages.append(page)
        notion = {
            "workspace": {"id": native_id("workspace", workspace["id"]), "name": workspace["name"]},
            "users": users,
            "pages": pages,
        }
        projections["notion"] = notion
        overlay["notion"] = copy.deepcopy(notion)
        for person in email_people:
            token(
                f"notion_token_{person['id']}",
                person["email"],
                ["read:user", "read:content", "write:content", "read:comment", "insert:comment", "interact:agents"],
            )
        token(
            "notion_token",
            email_actor["email"] if email_actor else None,
            ["read:user", "read:content", "write:content", "read:comment", "insert:comment", "interact:agents"],
        )

    if "documents" in communication or any(
        key in software for key in ("queues", "operator_ids", "operator_teams", "service_roles")
    ):
        bucket = f"{workspace['slug']}-documents"
        objects = [
            {
                "bucket": bucket,
                "key": c._document_object_key(document),
                "content_type": document.get("mime_type", "text/plain"),
                "content": document.get("content", document.get("body", "")),
                "last_modified": document.get("modified_at", world["clock"]["anchor"]),
                "owner": by_id[document["owner_id"]]["github_login"],
                "worldfixture_person_id": document["owner_id"],
                "worldfixture_document_id": document["id"],
            }
            for document in communication.get("documents", [])
        ]
        buckets = [{"name": bucket, "region": "eu-west-2"}] if "documents" in communication else []
        for event in world.get("timeline", []):
            name = event.get("payload", {}).get("bucket")
            if event.get("kind") == "s3-object" and not any(row["name"] == name for row in buckets):
                buckets.append({"name": name, "region": "eu-west-2"})
        selected_ids = set(software.get("operator_ids", []))
        selected_teams = set(software.get("operator_teams", []))
        operators = [
            person for person in people if person["id"] in selected_ids or person.get("team") in selected_teams
        ]
        if software.get("operator_limit") is not None:
            operators = sorted(operators, key=lambda person: person["id"])[: software["operator_limit"]]
        aws = {
            "region": "eu-west-2",
            "account_id": str(int(hashlib.sha256(world["id"].encode()).hexdigest()[:12], 16) % 10**12).zfill(12),
            "s3": {"buckets": buckets, "objects": objects},
            "sqs": {"queues": copy.deepcopy(software.get("queues", []))},
            "iam": {
                "users": [
                    {
                        "user_name": person["github_login"],
                        "path": "/people/",
                        "create_access_key": False,
                        "worldfixture_person_id": person["id"],
                    }
                    for person in operators
                ],
                "roles": copy.deepcopy(software.get("service_roles", [])),
            },
        }
        if "queues" not in software:
            aws.pop("sqs")
        if not any(key in software for key in ("operator_ids", "operator_teams", "service_roles")):
            aws.pop("iam")
        projections["aws"] = aws
        if any(key in software for key in ("queues", "operator_ids", "operator_teams", "service_roles")):
            overlay["aws"] = {key: copy.deepcopy(value) for key, value in aws.items() if key != "s3"}
            token("aws_token", primary["github_login"] if primary else None, ["sqs:*", "iam:*", "sts:*"])

    if "site" in source:
        http_world = {
            **world,
            "organizations": organizations if organization else [{**workspace, "primary": True, "summary": ""}],
            "stories": world.get("stories", []),
        }
        site = source["site"]
        if {"feed", "status", "pages", "probes"} <= site.keys():
            projections["http-targets"] = c._http_targets_from_site(http_world, packs.get("finance", {}), site)
        else:
            target = {
                "api_version": "worldfixture.http-targets/v1",
                "world_id": world["id"],
                "world_version": world["version"],
                "synthetic_notice": world["synthetic_notice"],
            }
            for field in ("pages", "probes", "api"):
                if field in site:
                    target[field] = copy.deepcopy(site[field])
            if "feed" in site:
                feed = copy.deepcopy(site["feed"])
                events = {event["id"]: event for event in world.get("timeline", [])}
                for item in feed.get("items", []):
                    if "arrival_id" in item:
                        item["available_after_seconds"] = events[item.pop("arrival_id")]["after_seconds"]
                target["feeds"] = [feed]
            if "metrics" in site:
                target["metrics"] = [
                    {
                        "name": metric["name"],
                        "help": metric.get("help", metric["name"]),
                        "type": metric.get("type", "gauge"),
                        "value": c._metric_value(metric["source"], world, packs.get("finance", {})),
                    }
                    for metric in site["metrics"]
                ]
            projections["http-targets"] = target

    if "repositories" in software or "github" in oauth:
        github = {
            "users": [
                {
                    "login": person["github_login"],
                    "name": person["name"],
                    **({"email": person["email"]} if person.get("email") else {}),
                    "worldfixture_person_id": person["id"],
                }
                for person in people
            ],
            "orgs": [
                {
                    "login": row["slug"],
                    "name": row["name"],
                    "description": row.get("summary", ""),
                    "worldfixture_organization_id": row["id"],
                }
                for row in organizations
            ],
            "repos": [],
        }
        organization_ids = {row["id"]: row for row in organizations}
        for repository in software.get("repositories", []):
            owner = organization_ids[repository["owner_id"]]
            issues = copy.deepcopy(repository.get("issues", []))
            for issue in issues:
                for field in ("author", "assignee"):
                    source_id = issue.pop(f"{field}_id", issue.get(field))
                    if source_id in by_id:
                        issue[field] = by_id[source_id]["github_login"]
                if issue.get("assignee"):
                    issue["assignees"] = [issue["assignee"]]
            github["repos"].append(
                {
                    "id": repository["id"],
                    "owner": owner["slug"],
                    "name": repository.get("name", repository["id"]),
                    "description": repository.get("description", ""),
                    "language": repository.get("language", ""),
                    "topics": copy.deepcopy(repository.get("topics", [])),
                    "auto_init": True,
                    "issues": issues,
                    "collaborators": [
                        {"username": by_id[person_id]["github_login"], "permission": "push"}
                        for person_id in repository.get("member_ids", [])
                    ],
                }
            )
        projections["github"] = github
        overlay["github"] = copy.deepcopy(github)
        token("github_token", primary["github_login"] if primary else None, ["repo", "user", "admin:org"])

    finance = world.get("finance", {})
    if "customers" in finance and "resolved" in finance:
        stripe = c._stripe_projection(world)
        projections["stripe"] = stripe
        overlay["stripe"] = copy.deepcopy(stripe)
        token("stripe_token", email_actor["email"] if email_actor else None)
    elif "products" in world.get("commerce", {}) and all(
        product.get("currency") for product in world["commerce"]["products"]
    ):
        # A catalogue does not imply customer subscriptions or invoice history.
        catalog_world = {
            **world,
            "finance": {"customers": [], "currency": None, "resolved": {"invoices": [], "payments": [], "refunds": []}},
        }
        stripe = c._stripe_projection(catalog_world)
        stripe = {field: stripe[field] for field in ("products", "prices")}
        projections["stripe"] = stripe
        overlay["stripe"] = copy.deepcopy(stripe)
        token("stripe_token", email_actor["email"] if email_actor else None)

    if "database" in software:
        database = software["database"]
        mongo = {
            "projects": [{"name": workspace["name"], "org_id": workspace["id"]}],
            "clusters": [
                {
                    "name": database["cluster"],
                    "project": workspace["name"],
                    "provider_name": database.get("provider_name", "AWS"),
                    "region_name": database.get("region_name", "EU_WEST_2"),
                    "instance_size_name": database.get("instance_size_name", "M10"),
                }
            ],
            "databases": [
                {
                    "cluster": database["cluster"],
                    "name": database["name"],
                    "collections": copy.deepcopy(database.get("collections", [])),
                }
            ],
        }
        projections["mongoatlas"] = mongo
        overlay["mongoatlas"] = copy.deepcopy(mongo)
        token("mongoatlas_token", primary["github_login"] if primary else None)
    if "twilio" in communication:
        twilio = copy.deepcopy(communication["twilio"])
        projections["twilio"] = twilio
        overlay["twilio"] = copy.deepcopy(twilio)
        token("twilio_token", twilio.get("account", {}).get("sid"))

    # Identity adapters use actual people. An absent OAuth client list remains
    # authoritative: generating user records never creates an application.
    for provider in ("microsoft", "apple", "clerk", "okta"):
        if provider == "apple" and not world.get("software", {}).get("oauth_clients", {}).get("apple"):
            continue
        if provider not in oauth and not email_people:
            continue
        if provider in {"microsoft", "apple"}:
            users = [
                {
                    "email": person["email"],
                    "name": person["name"],
                    "given_name": person["name"].split()[0],
                    "family_name": " ".join(person["name"].split(maxsplit=1)[1:]),
                    "worldfixture_person_id": person["id"],
                    **({"tenant_id": workspace["id"]} if provider == "microsoft" else {"is_private_email": False}),
                }
                for person in email_people
            ]
        elif provider == "clerk":
            users = [
                {
                    "first_name": person["name"].split()[0],
                    "last_name": " ".join(person["name"].split(maxsplit=1)[1:]),
                    "email_addresses": [person["email"]],
                    "worldfixture_person_id": person["id"],
                }
                for person in email_people
            ]
        else:
            users = [
                {
                    "login": person["email"],
                    "email": person["email"],
                    "first_name": person["name"].split()[0],
                    "last_name": " ".join(person["name"].split(maxsplit=1)[1:]),
                    "worldfixture_person_id": person["id"],
                }
                for person in email_people
            ]
        projections[provider] = {"users": users}
        overlay[provider] = {"users": copy.deepcopy(users)}
        scopes = ["openid", "email", "profile"]
        if provider == "microsoft":
            scopes += ["User.Read", "User.ReadBasic.All"]
        token(f"{provider}_token", email_actor["email"] if email_actor else None, scopes)
    if "vercel" in oauth:
        vercel = {
            "users": [
                {
                    "username": person["github_login"],
                    "name": person["name"],
                    "email": person["email"],
                    "worldfixture_person_id": person["id"],
                }
                for person in email_people
            ]
        }
        projections["vercel"] = vercel
        overlay["vercel"] = copy.deepcopy(vercel)
        token("vercel_token", email_actor["github_login"] if email_actor else None)
    for provider, clients in oauth.items():
        if provider == "apple" and not clients.get("oauth_clients"):
            continue
        overlay.setdefault(provider, {}).update(copy.deepcopy(clients))
        projections.setdefault(provider, {}).update(copy.deepcopy(clients))
    if len(overlay) > 2 or overlay["tokens"] or overlay["worldfixture"]["arrivals"]:
        projections["emulator-overlay"] = overlay
    return projections
