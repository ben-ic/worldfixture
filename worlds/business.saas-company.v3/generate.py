#!/usr/bin/env python3
"""Generate the fragments for `business.saas-company:v3`.

WHY A GENERATOR AND NOT HAND-WRITTEN JSON. v2 is 1,798 lines of reviewed source
describing ten employees, three channels and eight Slack messages. v3 describes
the same company a year later, at roughly forty times the size, and hand-writing
that would guarantee two things: dangling references, and filler text that reads
like filler. A generator makes the references correct by construction -- every
message names a person, customer, issue or invoice that exists -- and lets the
prose come from storylines rather than from a sentence pool.

WHY IT IS COMMITTED BESIDE ITS OUTPUT. The fragments ARE the reviewed source; the
compiler hashes them into `source_files` and the artifact digest. This script is
the tool that produced them, kept so the world can be grown again rather than
re-invented. Running it twice produces byte-identical fragments: every random
choice comes from one seeded generator, and every collection is written sorted.

WHAT MAKES THIS WORLD COHERENT RATHER THAN MERELY LARGE. Nine storylines run
through it -- an export incident that outlived its fix, a core migration, a
security review, an enterprise onboarding, a churn risk, a pricing change, an
outage postmortem, a hiring wave, and a data-quality problem in billing. Each one
owns its customers, its repository issues, its support cases, its channel
threads, its mail threads, its tasks, and its share of the timeline. A reader who
follows any single thread finds the same facts everywhere it appears.

    python3 worlds/business.saas-company.v3/generate.py
"""

from __future__ import annotations

import json
import random
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
ANCHOR = datetime(2027, 8, 20, 9, 0)
SEED = 20270820

rng = random.Random(SEED)


def iso(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def day(offset: int) -> date:
    return (ANCHOR + timedelta(days=offset)).date()


def stamp(days_before: float, hour: int, minute: int = 0) -> str:
    moment = ANCHOR - timedelta(days=days_before)
    return iso(moment.replace(hour=hour, minute=minute, second=0, microsecond=0))


# ---------------------------------------------------------------------------
# Organizations
# ---------------------------------------------------------------------------

DOMAIN = "worldfixture.test"

# (id, name, kind, sector). `kind` decides whether the organization becomes a
# customer, a supplier, a partner or the company itself.
ORGANIZATIONS = [
    ("northstar-relay", "Northstar Relay", "self", "Data export automation"),
    # Customers, largest first. Each one has a real situation in the storylines.
    ("lumen-labs", "Lumen Labs", "customer", "Operations analytics"),
    ("harbor-mobility", "Harbor Mobility", "customer", "Regional transport"),
    ("ember-commerce", "Ember Commerce", "customer", "Online retail"),
    ("kestrel-health", "Kestrel Health", "customer", "Clinical operations"),
    ("tidewater-freight", "Tidewater Freight", "customer", "Freight forwarding"),
    ("brightwell-energy", "Brightwell Energy", "customer", "Utility metering"),
    ("fieldnote-studio", "Fieldnote Studio", "customer", "Design studio"),
    ("marlow-insurance", "Marlow Insurance", "customer", "Claims processing"),
    ("orchard-grocers", "Orchard Grocers", "customer", "Grocery logistics"),
    ("pinecrest-schools", "Pinecrest Schools", "customer", "Education administration"),
    ("quarry-materials", "Quarry Materials", "customer", "Construction supply"),
    ("riverbend-bank", "Riverbend Bank", "customer", "Retail banking"),
    ("summit-travel", "Summit Travel", "customer", "Travel booking"),
    ("thistle-media", "Thistle Media", "customer", "Publishing"),
    ("umbra-security", "Umbra Security", "customer", "Managed security"),
    ("vantage-realty", "Vantage Realty", "customer", "Property management"),
    ("willow-pharma", "Willow Pharma", "customer", "Pharmaceutical supply"),
    ("cobalt-manufacturing", "Cobalt Manufacturing", "customer", "Industrial manufacturing"),
    ("dunmore-legal", "Dunmore Legal", "customer", "Legal services"),
    ("elmgrove-council", "Elmgrove Council", "customer", "Local government"),
    ("foxglove-events", "Foxglove Events", "customer", "Event management"),
    ("gantry-logistics", "Gantry Logistics", "customer", "Warehouse logistics"),
    ("halcyon-hotels", "Halcyon Hotels", "customer", "Hospitality"),
    ("ironvale-mining", "Ironvale Mining", "customer", "Resource extraction"),
    # Suppliers.
    ("cedar-office", "Cedar Office", "supplier", "Office and equipment"),
    ("cloudharbor", "CloudHarbor", "supplier", "Infrastructure hosting"),
    ("meridian-legal", "Meridian Legal", "supplier", "Legal counsel"),
    ("pagebright-design", "Pagebright Design", "supplier", "Brand and design"),
    ("quillmark-accounting", "Quillmark Accounting", "supplier", "Accounting"),
    ("signalpost-comms", "Signalpost Comms", "supplier", "Telephony and SMS"),
    ("verity-audit", "Verity Audit", "supplier", "Security audit"),
    ("wavelength-recruit", "Wavelength Recruit", "supplier", "Technical recruitment"),
    # Partners, who appear in mail and channels but buy nothing.
    ("atlas-consulting", "Atlas Consulting", "partner", "Implementation partner"),
    ("beacon-integrators", "Beacon Integrators", "partner", "Systems integration"),
]

ORG_BY_ID = {entry[0]: entry for entry in ORGANIZATIONS}


def organization_records() -> list[dict]:
    records = []
    for identifier, name, kind, sector in ORGANIZATIONS:
        record = {
            "domain": f"{identifier}.{DOMAIN}",
            "id": identifier,
            "name": name,
            "slug": identifier,
            "summary": {
                "self": "A software company that automates large operational data exports.",
                "customer": f"{sector}. Runs scheduled Northstar exports in production.",
                "supplier": f"{sector}. Supplies Northstar Relay.",
                "partner": f"{sector}. Delivers Northstar to its own clients.",
            }[kind],
        }
        if kind == "self":
            record["primary"] = True
        records.append(record)
    return records


# ---------------------------------------------------------------------------
# People
# ---------------------------------------------------------------------------

# Northstar staff. (given, family, role, team, location). The first is primary.
#
# Two-part names throughout. Several compiler projections still take a person's
# `given_name`/`family_name` from `name.split(maxsplit=1)`, so a one-part name
# raises `IndexError` and a three-part one puts two words in the family name. A
# world is not the place to discover that: an author who wants either shape needs
# the compiler fixed first.
STAFF = [
    ("Maya", "Chen", "Co-founder and CEO", "leadership", "London"),
    ("Jon", "Bell", "Co-founder and CTO", "leadership", "Bristol"),
    ("Noor", "Alvarez", "Chief Operating Officer", "leadership", "Madrid"),
    ("David", "Banerjee", "VP Customer Success", "leadership", "London"),
    ("Elena", "Petrov", "VP Product", "leadership", "Berlin"),
    ("Amara", "Diallo", "VP Engineering", "leadership", "Paris"),
    ("Rowan", "Whitfield", "VP Finance", "leadership", "Edinburgh"),
    ("Sofia", "Marchetti", "VP People", "leadership", "Milan"),
    ("Lucas", "Meyer", "Staff Engineer, Exports", "exports", "Zurich"),
    ("Hana", "Ito", "Senior Engineer, Console", "console", "Osaka"),
    ("Samira", "Okafor", "Support Lead", "support", "Lagos"),
    ("Imani", "Brooks", "People Operations", "people-ops", "Manchester"),
    ("Theo", "Martin", "Engineer, Exports", "exports", "Lyon"),
    ("Priyanka", "Nair", "Staff Engineer, Platform", "platform", "Bengaluru"),
    ("Tomas", "Novak", "Senior Engineer, Platform", "platform", "Prague"),
    ("Ada", "Lindqvist", "Engineer, Platform", "platform", "Stockholm"),
    ("Kwame", "Mensah", "Senior Engineer, Data", "data", "Accra"),
    ("Fatima", "Haddad", "Engineer, Data", "data", "Beirut"),
    ("Oscar", "Ruiz", "Senior Engineer, Console", "console", "Barcelona"),
    ("Mei", "Zhang", "Engineer, Console", "console", "Singapore"),
    ("Daniel", "Osei", "Engineer, Exports", "exports", "Dublin"),
    ("Ingrid", "Solberg", "Staff Engineer, Reliability", "reliability", "Oslo"),
    ("Rafael", "Costa", "Senior Engineer, Reliability", "reliability", "Lisbon"),
    ("Yuki", "Tanaka", "Engineer, Reliability", "reliability", "Kyoto"),
    ("Zara", "Ahmed", "Security Engineer", "security", "Birmingham"),
    ("Nikolai", "Petrov", "Senior Security Engineer", "security", "Tallinn"),
    ("Clara", "Dubois", "Product Designer", "design", "Nantes"),
    ("Marcus", "Webb", "Senior Product Designer", "design", "Leeds"),
    ("Aiko", "Yamamoto", "Design Systems Engineer", "design", "Fukuoka"),
    ("Ben", "Hartley", "Product Manager, Exports", "product", "Cambridge"),
    ("Leila", "Farouk", "Product Manager, Platform", "product", "Cairo"),
    ("Simon", "Novotny", "Product Manager, Console", "product", "Brno"),
    ("Grace", "Okonkwo", "Support Engineer", "support", "Abuja"),
    ("Henrik", "Larsen", "Support Engineer", "support", "Copenhagen"),
    ("Isabel", "Moreno", "Support Engineer", "support", "Seville"),
    ("Jamal", "Rashid", "Support Engineer", "support", "Amman"),
    ("Keiko", "Sato", "Technical Account Manager", "success", "Yokohama"),
    ("Liam", "Doherty", "Technical Account Manager", "success", "Belfast"),
    ("Mira", "Kovac", "Customer Success Manager", "success", "Zagreb"),
    ("Nathan", "Ford", "Customer Success Manager", "success", "Cardiff"),
    ("Olivia", "Barnes", "Account Executive", "sales", "London"),
    ("Pedro", "Silva", "Account Executive", "sales", "Porto"),
    ("Qing", "Liu", "Account Executive", "sales", "Shanghai"),
    ("Ravi", "Kapoor", "Sales Engineer", "sales", "Pune"),
    ("Sara", "Lindgren", "Sales Engineer", "sales", "Gothenburg"),
    ("Tobias", "Krause", "Financial Analyst", "finance", "Hamburg"),
    ("Ulla", "Virtanen", "Billing Operations", "finance", "Helsinki"),
    ("Victor", "Almeida", "Revenue Operations", "finance", "Sao Paulo"),
    ("Wren", "Callahan", "Marketing Lead", "marketing", "Galway"),
    ("Xiomara", "Reyes", "Content Marketing", "marketing", "Bogota"),
    ("Yusuf", "Demir", "Developer Relations", "marketing", "Istanbul"),
    ("Zoe", "Patterson", "Recruiter", "people-ops", "Glasgow"),
    ("Arjun", "Mehta", "Data Analyst", "data", "Mumbai"),
    ("Bianca", "Rossi", "QA Engineer", "quality", "Bologna"),
    ("Callum", "Fraser", "QA Engineer", "quality", "Aberdeen"),
    ("Dalia", "Mansour", "Technical Writer", "product", "Tunis"),
    ("Erik", "Johansson", "Site Reliability Engineer", "reliability", "Uppsala"),
    ("Farida", "Bello", "Site Reliability Engineer", "reliability", "Kano"),
    ("Gustavo", "Herrera", "Engineer, Exports", "exports", "Santiago"),
    ("Helena", "Novak", "Engineer, Data", "data", "Bratislava"),
    ("Idris", "Coulibaly", "Engineer, Platform", "platform", "Abidjan"),
    ("Jenna", "Whitlock", "Engineer, Console", "console", "Wellington"),
    ("Kasper", "Nielsen", "Engineer, Reliability", "reliability", "Aarhus"),
    ("Lena", "Fischer", "Security Engineer", "security", "Vienna"),
    ("Mateo", "Vargas", "Engineer, Connectors", "platform", "Medellin"),
    ("Nour", "Khalil", "Engineer, Connectors", "platform", "Doha"),
    ("Omar", "Bakri", "Data Engineer", "data", "Rabat"),
    ("Paloma", "Ortiz", "Data Engineer", "data", "Valencia"),
    ("Quentin", "Leroy", "QA Engineer", "quality", "Toulouse"),
    ("Rina", "Chowdhury", "QA Engineer", "quality", "Dhaka"),
    ("Sean", "Murphy", "Site Reliability Engineer", "reliability", "Limerick"),
    ("Tara", "Bergstrom", "Product Designer", "design", "Malmo"),
    ("Ugo", "Bianchi", "Product Designer", "design", "Turin"),
    ("Vera", "Ilyina", "Technical Writer", "product", "Riga"),
    ("Wesley", "Chan", "Product Manager, Data", "product", "Vancouver"),
    ("Xander", "Rooij", "Support Engineer", "support", "Utrecht"),
    ("Yara", "Nasser", "Support Engineer", "support", "Muscat"),
    ("Zeno", "Papadakis", "Support Engineer", "support", "Thessaloniki"),
    ("Alina", "Popescu", "Technical Account Manager", "success", "Bucharest"),
    ("Bruno", "Cardoso", "Technical Account Manager", "success", "Coimbra"),
    ("Celine", "Aubert", "Customer Success Manager", "success", "Rennes"),
    ("Dev", "Sharma", "Account Executive", "sales", "Delhi"),
    ("Eero", "Makinen", "Account Executive", "sales", "Tampere"),
    ("Freya", "Nilsen", "Sales Engineer", "sales", "Bergen"),
    ("Gabriel", "Sousa", "Financial Analyst", "finance", "Lisbon"),
    ("Hiro", "Nakamura", "Billing Operations", "finance", "Sapporo"),
    ("Iris", "Vandenberg", "Marketing Lead", "marketing", "Antwerp"),
    ("Jakub", "Wisniewski", "Developer Relations", "marketing", "Warsaw"),
    ("Karin", "Holmberg", "Recruiter", "people-ops", "Linkoping"),
    ("Luca", "Ferrari", "People Operations", "people-ops", "Verona"),
    ("Maya", "Osei", "Data Analyst", "data", "Kumasi"),
    ("Nils", "Andersson", "Engineer, Exports", "exports", "Vasteras"),
    ("Ophelia", "Hart", "Engineer, Exports", "exports", "Norwich"),
    ("Pavel", "Dvorak", "Staff Engineer, Connectors", "platform", "Ostrava"),
    ("Rosa", "Delgado", "Engineering Manager, Exports", "exports", "Bilbao"),
    ("Stefan", "Weber", "Engineering Manager, Platform", "platform", "Dresden"),
    ("Tessa", "Lindholm", "Engineering Manager, Console", "console", "Turku"),
    ("Uma", "Krishnan", "Engineering Manager, Data", "data", "Chennai"),
    ("Viktor", "Horvath", "Engineering Manager, Reliability", "reliability", "Debrecen"),
]

# One or two contacts at every other organization, so every customer, supplier
# and partner has a person who can send mail and appear in a support case.
EXTERNAL = {
    "lumen-labs": [("Priya", "Raman", "Director of Operations"), ("Callan", "Reed", "Data Engineer")],
    "harbor-mobility": [("Anders", "Holm", "Head of Compliance"), ("Bea", "Nowak", "Operations Analyst")],
    "ember-commerce": [("Ravi", "Sundaram", "Fulfilment Lead")],
    "kestrel-health": [("Nadia", "Farouk", "Clinical Data Manager"), ("Owen", "Pritchard", "IT Director")],
    "tidewater-freight": [("Marta", "Sokolova", "Logistics Director")],
    "brightwell-energy": [("Duncan", "Reid", "Metering Systems Lead")],
    "fieldnote-studio": [("Ines", "Carvalho", "Studio Manager")],
    "marlow-insurance": [("Gareth", "Powell", "Claims Operations Head")],
    "orchard-grocers": [("Tanya", "Oyelaran", "Supply Chain Manager")],
    "pinecrest-schools": [("Alan", "Whitmore", "Systems Administrator")],
    "quarry-materials": [("Bridget", "Kelly", "Finance Controller")],
    "riverbend-bank": [("Cormac", "Byrne", "Head of Regulatory Reporting"), ("Dina", "Vasquez", "Security Architect")],
    "summit-travel": [("Emil", "Berg", "Product Owner")],
    "thistle-media": [("Fiona", "Grant", "Editorial Operations")],
    "umbra-security": [("Gideon", "Marks", "Security Operations Lead")],
    "vantage-realty": [("Hollie", "Prentice", "Portfolio Manager")],
    "willow-pharma": [("Idris", "Salim", "Quality Assurance Lead")],
    "cobalt-manufacturing": [("Jana", "Kral", "Plant Systems Manager")],
    "dunmore-legal": [("Kieran", "Walsh", "Practice Manager")],
    "elmgrove-council": [("Lorna", "Mackay", "Information Officer")],
    "foxglove-events": [("Miles", "Okafor", "Operations Director")],
    "gantry-logistics": [("Nina", "Petrova", "Warehouse Systems Lead")],
    "halcyon-hotels": [("Oskar", "Lind", "Revenue Systems Manager")],
    "ironvale-mining": [("Paula", "Mendes", "Reporting Manager")],
    "cedar-office": [("Fern", "Ellery", "Account Manager")],
    "cloudharbor": [("Gus", "Nakamura", "Technical Account Manager")],
    "meridian-legal": [("Harriet", "Vaughn", "Partner")],
    "pagebright-design": [("Ivo", "Marek", "Creative Director")],
    "quillmark-accounting": [("Joan", "Ferris", "Senior Accountant")],
    "signalpost-comms": [("Kofi", "Adjei", "Account Manager")],
    "verity-audit": [("Lena", "Brandt", "Lead Auditor")],
    "wavelength-recruit": [("Mo", "Chowdhury", "Recruitment Partner")],
    "atlas-consulting": [("Niamh", "Doyle", "Delivery Lead")],
    "beacon-integrators": [("Otto", "Frey", "Principal Consultant")],
}


# A finance and an engineering contact at every customer, so a thread can be
# addressed to the person who actually owns the question.
SECOND_CONTACTS = [
    ("Alys", "Brenner", "Finance Manager"), ("Boris", "Katz", "Systems Engineer"),
    ("Carla", "Nunes", "Operations Manager"), ("Dmitri", "Volkov", "Data Engineer"),
    ("Esme", "Lefevre", "Finance Controller"), ("Felix", "Braun", "Integration Lead"),
    ("Gita", "Rao", "Reporting Analyst"), ("Hugo", "Meier", "Platform Engineer"),
    ("Ilse", "de Vries", "Procurement Lead"), ("Jonas", "Ekstrom", "Technical Lead"),
    ("Kara", "Boyle", "Billing Analyst"), ("Lars", "Pedersen", "Systems Architect"),
    ("Maud", "Thibault", "Compliance Officer"), ("Nikhil", "Verma", "Data Platform Lead"),
    ("Olga", "Ivanova", "Finance Business Partner"), ("Piotr", "Zielinski", "Integration Engineer"),
    ("Rania", "Aziz", "Operations Analyst"), ("Sven", "Larsson", "Reporting Lead"),
    ("Tomasz", "Kowalski", "Infrastructure Lead"), ("Ursula", "Mayer", "Finance Director"),
    ("Vikram", "Chandra", "Solutions Architect"), ("Wanda", "Nowicka", "Data Steward"),
    ("Yannis", "Petrou", "Systems Manager"), ("Zofia", "Kaminska", "Reporting Manager"),
]

for _position, (_identifier, _name, _kind, _sector) in enumerate(
    [entry for entry in ORGANIZATIONS if entry[2] == "customer"]
):
    EXTERNAL[_identifier].append(SECOND_CONTACTS[_position % len(SECOND_CONTACTS)])


def slugify(given: str, family: str) -> str:
    return _clean(f"{given}-{family}")


def _clean(value: str) -> str:
    """Lower-case, and keep only what the compiler's id and login patterns allow.

    A surname such as "de Vries" produced a login with a space in it, which the
    compiler refused by name. It was right to refuse; the world author should not
    have to avoid spaces in real surnames to satisfy a pattern.
    """
    lowered = value.lower().replace(" ", "-").replace("'", "")
    return "".join(character for character in lowered if character.isalnum() or character == "-")


def people_records() -> list[dict]:
    records: list[dict] = []
    used_logins: set[str] = set()
    used_emails: set[str] = set()
    used_local: dict[str, set[str]] = {}
    index = 0

    def add(given, family, role, team, location, organization_id, primary=False):
        nonlocal index
        index += 1
        identifier = slugify(given, family)
        local = _clean(given)
        taken = used_local.setdefault(organization_id, set())
        if local in taken:
            local = f"{_clean(given)}.{_clean(family)}"
        taken.add(local)
        email = f"{local}@{organization_id}.{DOMAIN}"
        assert email not in used_emails, email
        used_emails.add(email)

        login = _clean(f"{given}{family}")
        if login in used_logins:
            login = _clean(f"{given}-{family}")
        assert login not in used_logins, login
        used_logins.add(login)

        record = {
            "email": email,
            "github_login": login,
            "id": identifier,
            "location": location,
            "name": f"{given} {family}",
            "organization_id": organization_id,
            "role": role,
            "slack_id": f"U{index:09d}",
            "team": team,
        }
        if primary:
            record["primary"] = True
        records.append(record)

    for position, (given, family, role, team, location) in enumerate(STAFF):
        add(given, family, role, team, location, "northstar-relay", primary=position == 0)

    for organization_id, contacts in EXTERNAL.items():
        for given, family, role in contacts:
            add(given, family, role, "external", ORG_BY_ID[organization_id][1], organization_id)

    return records


PEOPLE = people_records()
PERSON_BY_ID = {person["id"]: person for person in PEOPLE}
STAFF_IDS = [p["id"] for p in PEOPLE if p["organization_id"] == "northstar-relay"]
BY_TEAM: dict[str, list[str]] = {}
for person in PEOPLE:
    if person["organization_id"] == "northstar-relay":
        BY_TEAM.setdefault(person["team"], []).append(person["id"])

STAFF_ID_SET = set(STAFF_IDS)

CONTACTS: dict[str, list[str]] = {}
for person in PEOPLE:
    if person["organization_id"] != "northstar-relay":
        CONTACTS.setdefault(person["organization_id"], []).append(person["id"])


def one(team: str, offset: int = 0) -> str:
    members = BY_TEAM[team]
    return members[offset % len(members)]


# ---------------------------------------------------------------------------
# Finance
# ---------------------------------------------------------------------------

CUSTOMER_ORGS = [o for o in ORGANIZATIONS if o[2] == "customer"]
SUPPLIER_ORGS = [o for o in ORGANIZATIONS if o[2] == "supplier"]

PLANS = [
    ("Northstar Enterprise plan", 412_000),
    ("Northstar Scale plan", 168_000),
    ("Northstar Scale plan", 96_400),
    ("Northstar Team plan", 41_200),
    ("Northstar Team plan", 24_800),
    ("Northstar Starter plan", 12_600),
]


def finance_records():
    customers = []
    for position, (identifier, name, _kind, _sector) in enumerate(CUSTOMER_ORGS):
        plan, amount = PLANS[min(position // 4, len(PLANS) - 1)]
        customers.append(
            {
                "contact_id": CONTACTS[identifier][0],
                "due_day": 30 if position % 2 == 0 else 28,
                "id": identifier.split("-")[0],
                "invoice_day": 14 if position % 3 else 1,
                "monthly_amount_cents": amount + position * 1_100,
                "name": name,
                "number_suffix": f"{70 + position:02d}",
                "organization_id": identifier,
                "service": plan,
            }
        )

    suppliers = []
    for position, (identifier, name, _kind, sector) in enumerate(SUPPLIER_ORGS):
        suppliers.append(
            {
                "bill_day": 5 + position * 2,
                "contact_id": CONTACTS[identifier][0],
                "id": identifier.split("-")[0],
                "monthly_amount_cents": 18_400 + position * 7_300,
                "name": name,
                "organization_id": identifier,
                "service": sector,
            }
        )

    # Three months of anchor invoices for every customer, so the ledger has a
    # history to read rather than one open row.
    invoices = []
    number = 5100
    for months_back in (2, 1, 0):
        for customer in customers:
            number += 1
            issued = day(-30 * months_back - 6)
            due = issued + timedelta(days=16)
            if months_back == 0:
                status = "open"
            elif months_back == 1 and customer["id"] in {"marlow", "quarry", "foxglove"}:
                status = "overdue"
            else:
                status = "paid"
            invoices.append(
                {
                    "amount_cents": customer["monthly_amount_cents"],
                    "currency": "USD",
                    "customer_id": customer["id"],
                    "description": f"{customer['service']} — {issued.strftime('%B')}",
                    "due_on": due.isoformat(),
                    "id": f"inv-{number}",
                    "issued_on": issued.isoformat(),
                    "number": str(number),
                    "status": status,
                }
            )

    return customers, suppliers, invoices


CUSTOMERS, SUPPLIERS, INVOICES = finance_records()
CUSTOMER_BY_ID = {c["id"]: c for c in CUSTOMERS}
CUSTOMER_IDS = [c["id"] for c in CUSTOMERS]


def customer_of(organization_id: str) -> str:
    return organization_id.split("-")[0]


# ---------------------------------------------------------------------------
# Software
# ---------------------------------------------------------------------------

REPOSITORIES = [
    ("repo-core", "relay-core", "Go", "Job orchestration and connector runtime", "platform", ["jobs", "connectors", "queues"]),
    ("repo-exports", "relay-exports", "Go", "Export workers, scheduling and delivery", "exports", ["exports", "workers", "scheduling"]),
    ("repo-console", "relay-console", "TypeScript", "Customer-facing web console", "console", ["web", "react", "console"]),
    ("repo-api", "relay-api", "Go", "Public REST and webhook API", "platform", ["api", "webhooks", "rest"]),
    ("repo-data", "relay-data", "Python", "Warehouse sync and reporting pipelines", "data", ["etl", "warehouse", "reporting"]),
    ("repo-connectors", "relay-connectors", "Go", "Third-party source and destination connectors", "platform", ["connectors", "integrations"]),
    ("repo-infra", "relay-infra", "HCL", "Infrastructure, clusters and deployment", "reliability", ["terraform", "kubernetes", "infra"]),
    ("repo-sdk-python", "relay-sdk-python", "Python", "Official Python client library", "platform", ["sdk", "python"]),
    ("repo-sdk-node", "relay-sdk-node", "TypeScript", "Official Node client library", "platform", ["sdk", "node"]),
    ("repo-docs", "relay-docs", "MDX", "Product and API documentation", "product", ["docs", "mdx"]),
    ("repo-billing", "relay-billing", "Go", "Metering, invoicing and plan enforcement", "data", ["billing", "metering"]),
    ("repo-security", "relay-security", "Go", "Audit log, access control and key handling", "security", ["security", "audit", "rbac"]),
    ("repo-design", "relay-design", "TypeScript", "Design system and shared components", "design", ["design-system", "components"]),
    ("repo-runbooks", "relay-runbooks", "Markdown", "On-call runbooks and postmortems", "reliability", ["runbooks", "oncall"]),
]

# (issue id, repo, number, title, state, labels, body, customer, case, assignee team)
ISSUES = [
    ("issue-902", "repo-exports", 902, "Scheduled exports above 250k rows exceed the worker lease",
     "open", ["bug", "customer-lumen", "release-3.2"],
     "Lumen reproduced at 268,410 rows. The 2.8 fix raised the timeout but not the lease renewal, so a long export still loses its worker at the renewal boundary. Needs a lease heartbeat, not another timeout bump.",
     "lumen", "case-lumen-lease", "exports"),
    ("issue-903", "repo-exports", 903, "Cancelled exports leave a partial object in the destination bucket",
     "open", ["bug", "release-3.2"],
     "Carried over from 2.8. Cancellation releases the worker and the lease, and the partially written object survives. The cleanup has to run in the same defer as the lease release.",
     None, None, "exports"),
    ("issue-904", "repo-core", 904, "Connector retries are not idempotent for chunked destinations",
     "open", ["bug", "customer-harbor"],
     "Harbor Mobility sees duplicate rows after a retried chunk. The chunk writer records progress after the write instead of before, so a retry replays the last chunk.",
     "harbor", "case-harbor-duplicates", "platform"),
    ("issue-905", "repo-billing", 905, "Metering double-counts rows for exports that resume",
     "open", ["bug", "billing", "data-quality"],
     "A resumed export emits a second metering record for the rows before the resume point. Three invoices this month are above the true usage. Do not re-bill until the reconciliation script has run.",
     None, "case-billing-overcount", "data"),
    ("issue-906", "repo-security", 906, "Audit log does not record export destination changes",
     "open", ["security", "soc2"],
     "Verity's interim report flags this. Changing a destination is a privileged action and leaves no audit record. Needed before the November audit window.",
     None, "case-verity-findings", "security"),
    ("issue-907", "repo-console", 907, "Export history page times out for accounts above 40k runs",
     "open", ["bug", "performance", "customer-riverbend"],
     "Riverbend has 61,300 historical runs. The page loads every run to compute the summary counts. Needs a materialized summary, and the fix should land before their regulatory reporting window.",
     "riverbend", "case-riverbend-history", "console"),
    ("issue-908", "repo-api", 908, "Webhook retries stop after four attempts with no dead-letter",
     "open", ["bug", "api"],
     "A subscriber that is down for twenty minutes loses its events with no record. Add a dead-letter queue and expose it in the console before the 3.2 announcement.",
     None, None, "platform"),
    ("issue-909", "repo-data", 909, "Warehouse sync drops rows when a source column is renamed",
     "open", ["bug", "data-quality"],
     "Renaming a source column silently drops that column for existing syncs instead of failing the sync. Kestrel found this in clinical data, which is the worst possible place to find it.",
     "kestrel", "case-kestrel-columns", "data"),
    ("issue-910", "repo-core", 910, "Migrate the job scheduler off the legacy queue",
     "open", ["migration", "release-3.2"],
     "The legacy queue cannot express lease renewal, which is why 902 exists. The new scheduler is behind a flag for eleven accounts. Do not widen the flag until 902 and 903 are both closed.",
     None, None, "platform"),
    ("issue-911", "repo-infra", 911, "Cluster autoscaler is slow to add export workers under burst load",
     "open", ["reliability", "postmortem"],
     "From the 12 August postmortem. The autoscaler took nine minutes to add capacity; exports queued behind it for the whole window. Pre-warm a floor of workers during known peak hours.",
     None, "case-outage-0812", "reliability"),
    ("issue-912", "repo-connectors", 912, "Add a Snowflake destination connector",
     "open", ["feature", "customer-cobalt"],
     "Cobalt Manufacturing and two prospects have asked. Design is agreed. Blocked on the chunk idempotency work in 904 because the connector uses the same chunk writer.",
     "cobalt", None, "platform"),
    ("issue-913", "repo-console", 913, "Destination credentials are visible in the browser network tab",
     "closed", ["security", "soc2"],
     "The edit form returned the full credential for display. Fixed by returning a masked value and a separate rotate action. Verified by Zara on 4 August.",
     None, "case-verity-findings", "security"),
    ("issue-914", "repo-exports", 914, "Export schedule times drift by one hour across a DST boundary",
     "closed", ["bug", "customer-halcyon"],
     "Schedules stored a fixed UTC offset instead of a zone. Fixed by storing the IANA zone and resolving at run time. Halcyon confirmed on 11 August.",
     "halcyon", None, "exports"),
    ("issue-915", "repo-sdk-python", 915, "Client retries do not respect the Retry-After header",
     "open", ["bug", "sdk"],
     "The SDK retries on its own schedule and ignores Retry-After, which makes a throttled account worse rather than better.",
     None, None, "platform"),
    ("issue-916", "repo-docs", 916, "Document the lease heartbeat behaviour before 3.2",
     "open", ["docs", "release-3.2"],
     "Blocked on 902 landing. The page has to state the real limit rather than the one we hope for.",
     None, None, "product"),
    ("issue-917", "repo-billing", 917, "Plan enforcement counts trial rows against the paid limit",
     "open", ["bug", "billing"],
     "Two onboarding accounts hit their limit during trial. Trial usage must be metered separately.",
     "gantry", "case-gantry-onboarding", "data"),
    ("issue-918", "repo-design", 918, "Table density is inconsistent between console pages",
     "open", ["design-system"],
     "Three different row heights across four pages. Consolidate on the design system table before the console refresh.",
     None, None, "design"),
    ("issue-919", "repo-runbooks", 919, "Write the runbook for a stuck export lease",
     "open", ["runbooks", "oncall"],
     "On-call has resolved this three times from memory. Write it down, including the safe way to release a lease without losing the partial object.",
     None, None, "reliability"),
    ("issue-920", "repo-security", 920, "Rotate the signing key used for webhook signatures",
     "open", ["security"],
     "Annual rotation. Needs a dual-key window so subscribers can accept both during the change.",
     None, "case-verity-findings", "security"),
    ("issue-921", "repo-api", 921, "Rate limit responses do not include a reset timestamp",
     "closed", ["api"],
     "Added X-RateLimit-Reset. Shipped in 3.1.4.",
     None, None, "platform"),
]


# Generated issues, so fourteen repositories are not three authored issues each.
# The themes are per repository, so a generated issue still belongs where it is.
ISSUE_THEMES = {
    "repo-core": ["scheduler lease renewal", "connector retry backoff", "queue drain ordering", "worker shutdown handling", "job priority inversion"],
    "repo-exports": ["export resume checkpoints", "destination write buffering", "schedule timezone handling", "row-count reporting", "cancellation cleanup"],
    "repo-console": ["export history filters", "empty-state copy", "table density", "keyboard navigation", "run detail loading"],
    "repo-api": ["webhook dead-letter", "rate limit headers", "pagination cursors", "error response shape", "idempotency keys"],
    "repo-data": ["schema change detection", "warehouse partitioning", "metering accuracy", "late-arriving rows", "column type coercion"],
    "repo-connectors": ["Snowflake destination", "S3 destination prefixes", "Postgres source cursors", "connector credential rotation", "chunk writer progress"],
    "repo-infra": ["autoscaler floor", "node pool upgrade", "secret rotation", "cluster cost reporting", "deployment rollback"],
    "repo-sdk-python": ["retry semantics", "async client", "typed responses", "pagination helper", "error hierarchy"],
    "repo-sdk-node": ["retry semantics", "ESM build", "typed responses", "stream helper", "error hierarchy"],
    "repo-docs": ["export guide", "scheduling guide", "API reference", "quickstart", "migration notes"],
    "repo-billing": ["trial metering", "plan enforcement", "invoice rounding", "usage report export", "credit notes"],
    "repo-security": ["audit log coverage", "signing key rotation", "access review export", "session handling", "permission checks"],
    "repo-design": ["table component", "form validation", "colour tokens", "icon set", "layout primitives"],
    "repo-runbooks": ["stuck export lease", "queue backlog", "failed deploy", "credential rotation", "on-call handover"],
}

GENERATED_ISSUE_BODIES = [
    "Reproduced on staging with the saved fixture. The failure is deterministic once the input crosses the boundary, which makes it testable.",
    "Raised during code review. Not urgent, and it will be much harder to change after the 3.2 release.",
    "Found while writing the runbook. The behaviour is correct and completely undocumented, which is its own defect.",
    "Customer-reported. The workaround holds, so this is scheduled rather than escalated.",
    "Follow-up from the postmortem. The action has an owner and a date rather than a backlog entry.",
    "Blocked on the chunk writer work. Building on the current behaviour would build the bug in.",
    "Small change, wide blast radius. Wants a test that kills the worker mid-operation before it merges.",
    "Split out of a larger issue so the part that is ready can ship without the part that is not.",
]


def generated_issues() -> list[tuple]:
    generated = []
    number = 1000
    for repo_id, _name, _language, _description, team, _topics in REPOSITORIES:
        for position, theme in enumerate(ISSUE_THEMES[repo_id]):
            for repeat in range(rng.randint(1, 3)):
                number += 1
                state = "closed" if (number % 3 == 0) else "open"
                labels = sorted({"bug" if number % 2 else "task", repo_id.replace("repo-", "")})
                generated.append((
                    f"issue-{number}", repo_id, number,
                    f"{theme.capitalize()} — {['inconsistent', 'undocumented', 'slow', 'incorrect at the boundary', 'not covered by tests'][repeat % 5]}",
                    state, labels,
                    GENERATED_ISSUE_BODIES[number % len(GENERATED_ISSUE_BODIES)],
                    None, None, team,
                ))
    return generated


ALL_ISSUES: list[tuple] = []


def repository_records() -> list[dict]:
    by_repo: dict[str, list[dict]] = {}
    for (identifier, repo, number, title, state, labels, body, customer, case, team) in ALL_ISSUES:
        members = BY_TEAM[team]
        issue = {
            "assignee": PERSON_BY_ID[members[number % len(members)]]["github_login"],
            "author": PERSON_BY_ID[members[(number + 1) % len(members)]]["github_login"],
            "body": body,
            "id": identifier,
            "labels": labels,
            "number": number,
            "state": state,
            "title": title,
        }
        if customer:
            issue["customer_id"] = customer
        if case:
            issue["support_case_id"] = case
        by_repo.setdefault(repo, []).append(issue)

    records = []
    for identifier, name, language, description, team, topics in REPOSITORIES:
        members = BY_TEAM[team][:4] + [one("leadership", 5)]
        records.append(
            {
                "description": description,
                "id": identifier,
                "issues": sorted(by_repo.get(identifier, []), key=lambda issue: issue["number"]),
                "language": language,
                "member_ids": sorted(set(members)),
                "name": name,
                "owner_id": "northstar-relay",
                "topics": topics,
            }
        )
    return records


# ---------------------------------------------------------------------------
# Support
# ---------------------------------------------------------------------------

CASES = [
    ("case-lumen-lease", "lumen", "high", "engineering", "Large scheduled exports lose their worker",
     "Ship the lease heartbeat in 3.2 and confirm at 268k rows with Callan.", 9),
    ("case-harbor-duplicates", "harbor", "high", "engineering", "Duplicate rows after a retried chunk",
     "Hold the compliance sign-off until the idempotent chunk writer is verified.", 6),
    ("case-billing-overcount", "lumen", "urgent", "finance", "Three invoices above true usage",
     "Run the reconciliation script, then issue credit notes before the next billing run.", 4),
    ("case-kestrel-columns", "kestrel", "urgent", "engineering", "Renamed source column silently dropped",
     "Fail the sync instead of dropping the column, and tell Nadia which runs were affected.", 7),
    ("case-riverbend-history", "riverbend", "high", "engineering", "Export history page times out",
     "Deliver the summary table before the regulatory reporting window on 4 September.", 5),
    ("case-verity-findings", "umbra", "high", "security", "Interim audit findings to close",
     "Close 906 and 920, then book the follow-up review with Lena.", 12),
    ("case-outage-0812", "brightwell", "normal", "resolved", "Exports queued for 41 minutes on 12 August",
     "Postmortem published. Autoscaler floor is the remaining action in 911.", 8),
    ("case-gantry-onboarding", "gantry", "normal", "onboarding", "Trial usage counted against the paid limit",
     "Meter trial usage separately, then restart the onboarding checklist.", 3),
    ("case-marlow-invoice", "marlow", "normal", "finance", "Invoice queried, payment on hold",
     "Send the usage breakdown Gareth asked for, then chase the overdue invoice.", 11),
    ("case-thistle-schedule", "thistle", "low", "waiting", "Schedule runs an hour early since the clock change",
     "Confirm the fix from 914 reached their account, then close.", 14),
    ("case-orchard-connector", "orchard", "normal", "engineering", "Fulfilment connector drops optional fields",
     "Reproduce with Tanya's saved export and open an issue if it is the same chunk bug.", 10),
    ("case-summit-latency", "summit", "low", "waiting", "Console slow during European morning",
     "Waiting on Emil for the request ids from a slow load.", 13),
    ("case-willow-compliance", "willow", "high", "engineering", "Audit trail needed for every destination change",
     "Blocked on 906. Give Idris a date once the audit log work is scheduled.", 6),
    ("case-cobalt-connector", "cobalt", "normal", "product", "Snowflake destination requested",
     "Confirm the 3.3 target with Jana once 904 is closed.", 15),
    ("case-elmgrove-access", "elmgrove", "normal", "waiting", "Single sign-on group mapping incomplete",
     "Waiting on Lorna's directory group list.", 9),
]


def support_records() -> list[dict]:
    support_team = BY_TEAM["support"] + BY_TEAM["success"]
    records = []
    for position, (identifier, customer, priority, state, title, action, days) in enumerate(CASES):
        customer_record = CUSTOMER_BY_ID[customer]
        records.append(
            {
                "contact_id": customer_record["contact_id"],
                "customer_id": customer,
                "id": identifier,
                "next_action": action,
                "opened_at": stamp(days, 9 + position % 8, (position * 7) % 60),
                "owner_id": support_team[position % len(support_team)],
                "priority": priority,
                "state": state,
                "title": title,
            }
        )
    return records


# ---------------------------------------------------------------------------
# Work
# ---------------------------------------------------------------------------

PROJECTS = [
    ("project-release-32", "Release 3.2", "leadership", None, "Lease heartbeat, cancellation cleanup and the scheduler migration.", -14, 12),
    ("project-scheduler-migration", "Scheduler migration", "platform", None, "Move every account off the legacy queue.", -60, 45),
    ("project-soc2", "SOC 2 Type II", "security", None, "Close Verity's interim findings and pass the November window.", -75, 80),
    ("project-console-refresh", "Console refresh", "design", None, "Rebuild the console on the design system.", -40, 60),
    ("project-billing-accuracy", "Billing accuracy", "finance", None, "Fix metering, reconcile, and credit the affected accounts.", -9, 10),
    ("project-lumen-renewal", "Lumen renewal", "success", "lumen", "Renew the largest account with an honest reliability story.", -20, 14),
    ("project-riverbend-onboarding", "Riverbend onboarding", "success", "riverbend", "Regulatory reporting go-live.", -35, 15),
    ("project-gantry-onboarding", "Gantry onboarding", "success", "gantry", "Trial to paid, once metering is right.", -12, 21),
    ("project-snowflake-connector", "Snowflake connector", "product", "cobalt", "First warehouse destination connector.", -18, 55),
    ("project-outage-followup", "12 August postmortem actions", "reliability", None, "Autoscaler floor, runbook, and alert coverage.", -8, 18),
    ("project-hiring-h2", "H2 hiring", "people-ops", None, "Eight engineers and two support engineers.", -90, 40),
    ("project-pricing-2028", "2028 pricing", "leadership", None, "Usage-based tier for large exporters.", -30, 70),
    ("project-docs-refresh", "Documentation refresh", "product", None, "Rewrite the export and scheduling guides.", -25, 30),
    ("project-sdk-parity", "SDK parity", "platform", None, "Bring the Node and Python clients to the same feature set.", -45, 35),
    ("project-warehouse-sync", "Warehouse sync hardening", "data", "kestrel", "Fail loudly on schema change.", -16, 25),
    ("project-dx-onboarding", "Developer onboarding", "product", None, "First useful export in under ten minutes.", -50, 50),
]

TASK_TEMPLATES = [
    ("Write the {thing} design note", "review", "high"),
    ("Implement {thing}", "in-progress", "high"),
    ("Add tests for {thing}", "in-progress", "normal"),
    ("Review the {thing} change", "review", "normal"),
    ("Document {thing}", "ready", "normal"),
    ("Measure {thing} under load", "in-progress", "high"),
    ("Roll out {thing} behind a flag", "ready", "high"),
    ("Close out {thing}", "backlog", "low"),
    ("Reproduce {thing} on staging", "done", "normal"),
    ("Agree the {thing} rollback plan", "blocked", "high"),
]

TASK_SUBJECTS = {
    "project-release-32": ["the lease heartbeat", "cancellation cleanup", "the 3.2 release notes", "the flag rollout"],
    "project-scheduler-migration": ["the new scheduler", "queue drain", "account migration batches", "legacy queue removal"],
    "project-soc2": ["the audit log", "key rotation", "access review", "the evidence pack"],
    "project-console-refresh": ["the table component", "the export history page", "the navigation", "the empty states"],
    "project-billing-accuracy": ["the reconciliation script", "credit notes", "trial metering", "the usage report"],
    "project-lumen-renewal": ["the renewal brief", "the reliability summary", "the usage growth chart", "the renewal call"],
    "project-riverbend-onboarding": ["the reporting template", "the history summary table", "the go-live checklist"],
    "project-gantry-onboarding": ["trial metering", "the onboarding checklist", "the first scheduled export"],
    "project-snowflake-connector": ["the chunk writer", "the destination schema", "the connector tests"],
    "project-outage-followup": ["the autoscaler floor", "the stuck-lease runbook", "burst alerting"],
    "project-hiring-h2": ["the exports role", "the interview loop", "the offer process"],
    "project-pricing-2028": ["the usage tier model", "the migration path", "the customer briefing"],
    "project-docs-refresh": ["the export guide", "the scheduling guide", "the API reference"],
    "project-sdk-parity": ["Node retries", "Python pagination", "the shared test suite"],
    "project-warehouse-sync": ["schema change detection", "the failure mode", "the affected-run report"],
    "project-dx-onboarding": ["the quickstart", "the sample dataset", "the first-export flow"],
}


def work_records():
    projects = []
    for identifier, name, team, customer, summary, start_offset, target_offset in PROJECTS:
        members = BY_TEAM[team][:3] + [one("leadership", len(identifier))] + BY_TEAM["product"][:1]
        record = {
            "id": identifier,
            "member_ids": sorted(set(members)),
            "name": name,
            "owner_id": BY_TEAM[team][0],
            "start_on": day(start_offset).isoformat(),
            "status": "active",
            "summary": summary,
            "target_on": day(target_offset).isoformat(),
        }
        if customer:
            record["customer_id"] = customer
        projects.append(record)

    tasks = []
    counter = 0
    for project in projects:
        subjects = TASK_SUBJECTS[project["id"]]
        members = project["member_ids"]
        for position in range(rng.randint(24, 38)):
            counter += 1
            title_template, status, priority = TASK_TEMPLATES[position % len(TASK_TEMPLATES)]
            subject = subjects[position % len(subjects)]
            tasks.append(
                {
                    "assignee_id": members[position % len(members)],
                    "description": f"Part of {project['name']}. {subject.capitalize()} is on the critical path for {project['target_on']}.",
                    "due_on": day(rng.randint(-6, 40)).isoformat(),
                    "id": f"task-{counter:04d}",
                    "labels": sorted({project["id"].replace("project-", ""), priority}),
                    "priority": priority,
                    "project_id": project["id"],
                    "reporter_id": members[(position + 1) % len(members)],
                    "status": status,
                    "title": title_template.format(thing=subject),
                }
            )

    entries = []
    for position, task in enumerate(tasks):
        if position % 2:
            continue
        for repeat in range(rng.randint(1, 3)):
            entries.append(
                {
                    "date": day(-rng.randint(1, 21)).isoformat(),
                    "id": f"time-{len(entries) + 1:04d}",
                    "minutes": rng.choice([25, 45, 60, 75, 90, 120, 150]),
                    "note": f"{task['title']}.",
                    "person_id": task["assignee_id"],
                    "task_id": task["id"],
                }
            )

    return projects, tasks, sorted(entries, key=lambda entry: entry["id"])


PROJECT_RECORDS, TASK_RECORDS, TIME_RECORDS = work_records()


# ---------------------------------------------------------------------------
# Communication
# ---------------------------------------------------------------------------

CHANNELS = [
    ("channel-general", "general", "Company updates and questions for everyone", None),
    ("channel-engineering", "engineering", "Engineering-wide discussion", ["platform", "exports", "console", "data", "reliability", "security", "quality"]),
    ("channel-exports", "exports", "The export worker, scheduling and delivery", ["exports", "platform", "product"]),
    ("channel-platform", "platform", "Core services and the scheduler migration", ["platform", "reliability"]),
    ("channel-console", "console", "Web console and the design system", ["console", "design", "product"]),
    ("channel-data", "data", "Warehouse sync, metering and reporting", ["data", "finance"]),
    ("channel-reliability", "reliability", "On-call, incidents and capacity", ["reliability", "platform", "exports"]),
    ("channel-security", "security", "Security work and the SOC 2 window", ["security", "leadership"]),
    ("channel-release-32", "release-3-2", "Release 3.2 go or no-go", ["exports", "platform", "product", "leadership", "quality"]),
    ("channel-incidents", "incidents", "Live incidents only", ["reliability", "platform", "exports", "leadership"]),
    ("channel-support", "support", "Support triage and escalation", ["support", "success"]),
    ("channel-escalations", "escalations", "Customer escalations that need engineering", ["support", "success", "leadership", "exports"]),
    ("channel-sales", "sales", "Pipeline and deals", ["sales", "leadership"]),
    ("channel-success", "customer-success", "Accounts, renewals and health", ["success", "sales", "support"]),
    ("channel-finance", "finance", "Billing, invoicing and revenue", ["finance", "leadership"]),
    ("channel-billing-incident", "billing-accuracy", "The metering overcount and its cleanup", ["finance", "data", "leadership", "support"]),
    ("channel-design", "design", "Design work and reviews", ["design", "product", "console"]),
    ("channel-product", "product", "Roadmap and product decisions", ["product", "leadership", "design"]),
    ("channel-docs", "docs", "Documentation and developer experience", ["product", "marketing"]),
    ("channel-marketing", "marketing", "Launches, content and events", ["marketing", "product", "leadership"]),
    ("channel-people", "people", "Hiring, onboarding and team news", ["people-ops", "leadership"]),
    ("channel-lumen", "account-lumen", "Lumen Labs renewal and reliability", ["success", "support", "exports", "leadership"]),
    ("channel-riverbend", "account-riverbend", "Riverbend regulatory reporting go-live", ["success", "console", "support"]),
    ("channel-kestrel", "account-kestrel", "Kestrel clinical data sync", ["success", "data", "support"]),
    ("channel-gantry", "account-gantry", "Gantry onboarding", ["success", "finance", "support"]),
    ("channel-oncall", "oncall", "Handovers and pages", ["reliability", "platform"]),
    ("channel-random", "random", "Anything that is not work", None),
    ("channel-soc2", "soc2-audit", "Evidence, findings and the audit window", ["security", "leadership", "finance"]),
]

# Storyline threads. Each entry becomes a run of messages in one channel, in
# order, on consecutive working hours -- so a reader can follow one argument
# rather than a shuffled feed.
THREADS = [
    ("channel-release-32", 6, [
        ("exports", 0, "Lease heartbeat is passing at 268k rows on the fixture. Three consecutive clean runs, no lease loss. The renewal boundary is the part that was wrong, not the timeout."),
        ("leadership", 1, "Good. The gate for 3.2 is still both: heartbeat AND cancellation cleanup. A partial object left in a customer bucket is the thing that ends a renewal call."),
        ("exports", 2, "Cancellation cleanup is written but the defer ordering is wrong under a panic path. I do not want to merge it today."),
        ("product", 0, "Then the release note stays conditional. I will not write “fixed” for 902 until both land."),
        ("quality", 0, "I can run the burst suite overnight if the branch is stable by 17:00."),
        ("leadership", 1, "Do that. Go or no-go on Monday, and Monday is the last date that works for the Lumen call."),
    ]),
    ("channel-exports", 5, [
        ("exports", 1, "Reminder for anyone reading 902: the 2.8 change raised the timeout. It did not touch lease renewal. Those are different clocks and we conflated them for a year."),
        ("platform", 0, "The new scheduler expresses lease renewal properly, which is why 910 blocks on 902 rather than the other way round."),
        ("exports", 2, "Agreed. I am not widening the migration flag past eleven accounts until both are closed."),
        ("reliability", 0, "Ping me before you widen it. The autoscaler floor from 911 is not deployed yet and a burst of migrated accounts would find the same nine-minute gap."),
    ]),
    ("channel-billing-incident", 4, [
        ("data", 0, "Confirmed: a resumed export emits a second metering record for the rows before the resume point. That is 905."),
        ("finance", 0, "Three invoices are above true usage this month. Lumen, Harbor and Riverbend. I have put the billing run on hold."),
        ("leadership", 6, "Hold is right. Nobody gets re-billed before reconciliation, and every affected account gets told by us before they notice it themselves."),
        ("finance", 1, "Reconciliation script is written. I need one engineer to check the resume-point logic before I run it against production metering."),
        ("data", 1, "I will review it this afternoon."),
        ("support", 0, "I have a holding reply ready for anyone who asks. It says the amount is wrong, that we found it, and that a credit note follows. No date until reconciliation runs."),
    ]),
    ("channel-lumen", 7, [
        ("success", 0, "Lumen renewal call is Tuesday. Priya's question has not changed since last year: can we promise scheduled exports at their volume."),
        ("exports", 0, "At 268k rows with the heartbeat, yes. Without it, no. That is an honest sentence and I would rather we said it."),
        ("leadership", 0, "We say it. We also say 903 is not closed and what that means if they cancel a run."),
        ("success", 1, "Callan has offered to rerun their largest saved export against the flag account this week. That gives us their number rather than our fixture's."),
        ("exports", 0, "Set it up. Their data shape is not our fixture's shape and I would like to know that before Tuesday, not after."),
    ]),
    ("channel-security", 5, [
        ("security", 0, "Verity's interim report has two open items for us: 906, destination changes are not audited, and 920, the signing key rotation."),
        ("security", 1, "913 is closed and verified. Credentials are masked and rotation is a separate action now."),
        ("leadership", 5, "What is the earliest honest date for 906?"),
        ("security", 0, "Three weeks if it stays scoped to destination changes. Longer if we widen it to every privileged action, which we should eventually but not before November."),
        ("leadership", 5, "Scope it narrow, ship it, widen it after the window."),
    ]),
    ("channel-incidents", 8, [
        ("reliability", 0, "Exports queued from 09:14. Autoscaler is adding workers but slowly."),
        ("reliability", 1, "Queue depth 4,100 and climbing. Brightwell and two others are affected."),
        ("platform", 0, "Nothing wrong with the workers themselves. This is capacity, not correctness."),
        ("reliability", 0, "Capacity restored at 09:55. Forty-one minutes. Writing the postmortem now."),
        ("leadership", 1, "Thank you. Postmortem in the repo, actions in a project, and I want the autoscaler floor to be a real task with an owner."),
    ]),
    ("channel-kestrel", 6, [
        ("data", 0, "Kestrel renamed a source column and the sync dropped it silently. That is 909."),
        ("success", 2, "In clinical data. Nadia found it, not us. That is the part I am unhappy about."),
        ("data", 1, "Failing the sync instead of dropping the column is a two-day change. Telling them which runs were affected is the longer job."),
        ("leadership", 3, "Do the telling first. They need to know the blast radius before they need the fix."),
    ]),
    ("channel-console", 5, [
        ("console", 0, "Riverbend's export history page loads every run to compute the summary. 61,300 runs, so it times out."),
        ("console", 1, "Materialized summary table is the fix. Two days, plus a backfill."),
        ("success", 1, "Their regulatory reporting window opens 4 September. After that date this becomes a compliance conversation rather than a performance one."),
        ("design", 0, "While it is being rebuilt, can we also fix the table density? 918. Three different row heights on four pages."),
        ("console", 0, "Yes, if it is the design system table and not a new one."),
    ]),
    ("channel-people", 9, [
        ("people-ops", 0, "Two engineers start Monday, both on exports. Buddy assignments are in the onboarding doc."),
        ("people-ops", 1, "Staging access is still the slowest onboarding step. It took nine days last time."),
        ("leadership", 2, "Who owns that?"),
        ("platform", 0, "Nobody, which is the answer to why it takes nine days. I will take it."),
    ]),
    ("channel-product", 6, [
        ("product", 0, "Usage-based tier for large exporters: the model works, the migration path is the hard part."),
        ("leadership", 0, "No customer moves to a worse price without a conversation first. That is not negotiable."),
        ("finance", 0, "Then we need the per-account comparison before we announce anything. I can have it next week."),
        ("product", 1, "Agreed. Announcement after the comparison, not before."),
    ]),
    ("channel-engineering", 4, [
        ("platform", 1, "Reminder that 904 blocks 912. The Snowflake connector uses the same chunk writer that is replaying its last chunk on retry."),
        ("platform", 0, "Fix is to record progress before the write, not after. Small change, wide blast radius."),
        ("quality", 1, "I want a test that kills the worker mid-chunk before that merges."),
        ("platform", 1, "Fair. Adding it."),
    ]),
    ("channel-escalations", 3, [
        ("support", 1, "Harbor is seeing duplicate rows after retried chunks. Compliance sign-off is held until it is fixed."),
        ("success", 3, "Their compliance date is the end of September. We have room, but not much."),
        ("platform", 0, "904 is the same bug. One fix, both accounts."),
    ]),
    ("channel-general", 2, [
        ("people-ops", 0, "Two new engineers start Monday. Say hello in #general when they arrive."),
        ("leadership", 0, "Release 3.2 go or no-go is Monday morning. If you have an opinion about the gate, say it in #release-3-2 before then."),
        ("finance", 1, "August expenses close on Friday at 16:00. Amount and customer today; receipts can follow."),
    ]),
]

FILLER = [
    "Deployed to staging. Nothing surprising in the logs.",
    "I updated the runbook while this was fresh.",
    "Rebased onto main; the conflict was only in the test fixtures.",
    "Handover: nothing open from my shift.",
    "Reviewed. One comment about naming, otherwise fine.",
    "Numbers are in the doc rather than here, the table does not survive Slack.",
    "Moved this to the project board so it has an owner.",
    "Confirmed with the customer. No change needed on our side.",
    "Flagging early: this will need a migration, not a config change.",
    "Closing the loop -- shipped and verified.",
    "I will pick this up after the release decision.",
    "Added the alert. It fires on queue depth rather than on error rate.",
    "This is the third time this week. Writing it down.",
    "Agreed on the call; recording the decision here so it is findable.",
    "Waiting on the customer for the request ids.",
]


def channel_records():
    records = []
    counter = 0
    for identifier, name, topic, teams in CHANNELS:
        if teams is None:
            members = STAFF_IDS
        else:
            members = sorted({person for team in teams for person in BY_TEAM.get(team, [])})
        messages = []

        for channel_id, days_back, entries in THREADS:
            if channel_id != identifier:
                continue
            for position, (team, offset, text) in enumerate(entries):
                counter += 1
                messages.append(
                    {
                        "author_id": one(team, offset),
                        "entity_refs": {},
                        "id": f"chat-{counter:05d}",
                        "text": text,
                        "timestamp": stamp(days_back, 9 + position, (position * 13) % 60),
                    }
                )

        # Background traffic, so a channel is not only its storyline. Deterministic
        # from the seed, and never more than a third of a channel's content.
        for position in range(rng.randint(34, 72)):
            counter += 1
            messages.append(
                {
                    "author_id": members[rng.randrange(len(members))],
                    "entity_refs": {},
                    "id": f"chat-{counter:05d}",
                    "text": FILLER[rng.randrange(len(FILLER))],
                    "timestamp": stamp(rng.randint(1, 30), rng.randint(8, 18), rng.randrange(0, 60)),
                }
            )

        records.append(
            {
                "id": identifier,
                "member_ids": members,
                "messages": sorted(messages, key=lambda message: (message["timestamp"], message["id"])),
                "name": name,
                "topic": topic,
            }
        )
    return records


MAIL_THREADS = [
    ("thread-lumen-renewal", "Renewal and export reliability", "lumen-labs", 0, [
        (None, "priya-raman", ["maya-chen", "david-banerjee"],
         "Maya,\n\nBefore Tuesday I need two things in writing. First, whether scheduled exports at our volume are reliable in 3.2. Second, what happens to a partially written file if we cancel a run.\n\nI am not asking for perfection. I am asking for the real answer so I can plan around it.\n\nPriya"),
        ("maya-chen", "maya-chen", ["priya-raman", "david-banerjee"],
         "Priya,\n\nYou will get both in writing before the call.\n\nOn the first: with the lease heartbeat in 3.2 we have three clean runs at 268,000 rows on our fixture. Callan has offered to run your largest saved export against a flag account this week, which gives you your number rather than ours.\n\nOn the second: today a cancelled run can leave a partial object in your bucket. That is issue 903 and it is not closed. Until it is, treat a cancelled run as needing a manual check of the destination.\n\nMaya"),
        ("priya-raman", "priya-raman", ["maya-chen"],
         "That is the answer I wanted. Callan will run ours on Thursday.\n\nThe partial-object behaviour is workable if it is documented. It is not workable as a surprise.\n\nPriya"),
    ]),
    ("thread-billing-overcount", "Invoice amount is above your actual usage", "lumen-labs", 2, [
        ("rowan-whitfield", "rowan-whitfield", ["priya-raman"],
         "Priya,\n\nWe found a metering fault before you did, and I would rather tell you now than have you find it on the invoice.\n\nExports that resume were counted twice for the rows before the resume point. Your August invoice is above your true usage. We have put the billing run on hold, we are reconciling, and a credit note will follow.\n\nI do not have a date for the credit note yet. You will have one this week.\n\nRowan"),
        ("priya-raman", "priya-raman", ["rowan-whitfield"],
         "Thank you for saying so first. Send the corrected usage when you have it; we will hold payment until then.\n\nPriya"),
    ]),
    ("thread-kestrel-columns", "Renamed column dropped from your clinical sync", "kestrel-health", 3, [
        ("nadia-farouk", "nadia-farouk", ["david-banerjee", "kwame-mensah"],
         "We renamed a column in the source system on 6 August. The Northstar sync kept running and simply stopped carrying that column. No error, no warning.\n\nThis is clinical data. I need to know which runs were affected before I need the fix.\n\nNadia"),
        ("kwame-mensah", "kwame-mensah", ["nadia-farouk", "david-banerjee"],
         "Understood, and you are right about the order.\n\nWe are producing the list of affected runs first. The behaviour change -- failing the sync instead of dropping the column -- is issue 909 and is a smaller job than the report.\n\nI will send the affected-run list before the fix date.\n\nKwame"),
    ]),
    ("thread-harbor-duplicates", "Duplicate rows after retried chunks", "harbor-mobility", 5, [
        ("anders-holm", "anders-holm", ["samira-okafor"],
         "Our compliance sign-off is held. We see duplicate rows whenever a chunk is retried.\n\nOur date is the end of September. Can you tell me whether that is realistic?\n\nAnders"),
        ("samira-okafor", "samira-okafor", ["anders-holm", "priyanka-nair"],
         "It is realistic. The cause is known: the chunk writer records progress after the write instead of before, so a retry replays the last chunk. That is issue 904.\n\nThe fix is small and the testing is not, because we want a test that kills a worker mid-chunk before it merges. I will give you a date once that test exists.\n\nSamira"),
    ]),
    ("thread-riverbend-history", "Export history page and the reporting window", "riverbend-bank", 4, [
        ("cormac-byrne", "cormac-byrne", ["keiko-sato"],
         "The export history page has stopped loading for us. Our regulatory reporting window opens on 4 September and this page is part of the evidence we produce.\n\nCormac"),
        ("keiko-sato", "keiko-sato", ["cormac-byrne", "oscar-ruiz"],
         "It is the run count -- 61,300 historical runs, and the page computes its summary from all of them. Issue 907.\n\nThe fix is a summary table plus a backfill. We are treating 4 September as the date, not as a target.\n\nKeiko"),
    ]),
    ("thread-verity-interim", "Interim audit findings", "verity-audit", 6, [
        ("lena-brandt", "lena-brandt", ["zara-ahmed", "noor-alvarez"],
         "Interim report attached in the shared folder. Two items remain open on your side: destination changes are not written to the audit log, and the webhook signing key is past its rotation date.\n\nBoth are closable before the November window if they are started now.\n\nLena"),
        ("zara-ahmed", "zara-ahmed", ["lena-brandt", "noor-alvarez"],
         "Both are open issues on our board, 906 and 920. Destination auditing is scoped narrowly on purpose so it lands in three weeks rather than three months; we will widen it after the window.\n\nZara"),
    ]),
    ("thread-outage-0812", "Postmortem: exports queued for 41 minutes on 12 August", "northstar-relay", 8, [
        ("ingrid-solberg", "ingrid-solberg", ["jon-bell", "amara-diallo", "noor-alvarez"],
         "Postmortem is in relay-runbooks.\n\nSummary: a burst of scheduled exports arrived faster than the autoscaler added workers. Queue depth peaked at 4,100. No data was lost and no export failed; every one was late.\n\nThe single action that would have prevented it is a pre-warmed floor of workers during known peak hours. That is issue 911.\n\nIngrid"),
        ("jon-bell", "jon-bell", ["ingrid-solberg", "amara-diallo"],
         "Clear and useful. Make 911 a real task with an owner and a date, not a backlog item.\n\nJon"),
    ]),
    ("thread-cobalt-snowflake", "Snowflake destination", "cobalt-manufacturing", 9, [
        ("jana-kral", "jana-kral", ["olivia-barnes", "ben-hartley"],
         "Where are we with a Snowflake destination? Our warehouse team keeps asking and I keep saying soon.\n\nJana"),
        ("ben-hartley", "ben-hartley", ["jana-kral", "olivia-barnes"],
         "Design is agreed and the work is scheduled behind one dependency: the connector uses the same chunk writer as issue 904, which currently replays its last chunk on retry. Building on that first would build the bug into a new connector.\n\nI would rather give you a real date after 904 closes than a hopeful one now.\n\nBen"),
    ]),
    ("thread-gantry-trial", "Trial usage counted against the paid limit", "gantry-logistics", 7, [
        ("nina-petrova", "nina-petrova", ["nathan-ford"],
         "We hit a usage limit during what is supposed to be a trial. Our first scheduled export stopped.\n\nNina"),
        ("nathan-ford", "nathan-ford", ["nina-petrova", "ulla-virtanen"],
         "That is our fault -- trial usage is being metered against the paid limit. Issue 917.\n\nI have lifted your limit manually so you are unblocked today, and the metering fix is with the billing team.\n\nNathan"),
    ]),
    ("thread-marlow-invoice", "Query on invoice", "marlow-insurance", 11, [
        ("gareth-powell", "gareth-powell", ["ulla-virtanen"],
         "We are holding payment until we can see a usage breakdown behind the amount. Nothing is wrong that I know of; I simply cannot approve a number I cannot explain.\n\nGareth"),
        ("ulla-virtanen", "ulla-virtanen", ["gareth-powell"],
         "Entirely reasonable. Breakdown by export, by day, for the billing period is attached in the shared folder.\n\nUlla"),
    ]),
]

MAIL_FILLER = [
    ("Weekly export summary", "Scheduled exports completed on time this week. No action needed."),
    ("Access request", "Please approve staging access for the new starter. The onboarding doc has the details."),
    ("Meeting notes", "Notes from this morning are in the shared folder. Decisions are at the top."),
    ("Invoice", "This month's invoice is attached in the shared folder. Payment terms unchanged."),
    ("Contract review", "One clause needs a change before signature. Marked in the document."),
    ("Support update", "The case is with engineering. I will update you when there is a date."),
    ("Usage report", "Your usage report for the period is in the shared folder."),
    ("Renewal reminder", "Your plan renews next month. No action needed unless you want to change tier."),
    ("Onboarding checklist", "Next steps are in the checklist. The first scheduled export is step four."),
    ("Incident notice", "Exports were delayed this morning. No data was lost. Postmortem to follow."),
    ("Change window", "A maintenance window is planned. No downtime expected for scheduled exports."),
    ("Documentation update", "The export guide has been rewritten. The scheduling section is new."),
]


def _labels(from_id: str, *, unread: bool) -> list[str]:
    """Gmail labels for one message, from the point of view of this company.

    A message a Northstar person SENT belongs in Sent, not in Inbox. Labelling
    everything `INBOX` left every Sent folder empty, which a real-container gate
    caught by asserting that the primary person had sent something.
    """
    if from_id in STAFF_ID_SET:
        return ["SENT"]
    return ["INBOX", "UNREAD"] if unread else ["INBOX"]


def mail_records():
    records = []
    counter = 0

    for thread_id, subject, organization_id, days_back, messages in MAIL_THREADS:
        for position, (_author, from_id, to_ids, body) in enumerate(messages):
            counter += 1
            snippet = body.split("\n\n")[1] if "\n\n" in body else body
            record = {
                "body_text": body,
                "from_id": from_id,
                "id": f"mail-{counter:05d}",
                "labels": _labels(from_id, unread=position == 0),
                "sent_at": stamp(days_back - position * 0.25, 8 + position * 2, (position * 17) % 60),
                "snippet": snippet[:110],
                "subject": subject if position == 0 else f"Re: {subject}",
                "thread_id": thread_id,
                "to_ids": to_ids,
            }
            if organization_id in ORG_BY_ID and ORG_BY_ID[organization_id][2] == "customer":
                record["customer_id"] = customer_of(organization_id)
            records.append(record)

    # Everyday correspondence, so the mailbox is a mailbox and not a case file.
    external_ids = [p["id"] for p in PEOPLE if p["organization_id"] != "northstar-relay"]
    for position in range(2_400):
        counter += 1
        subject, body = MAIL_FILLER[position % len(MAIL_FILLER)]
        inbound = position % 3 != 0
        other = external_ids[rng.randrange(len(external_ids))]
        staff = STAFF_IDS[rng.randrange(len(STAFF_IDS))]
        from_id, to_ids = (other, [staff]) if inbound else (staff, [other])
        organization_id = PERSON_BY_ID[other]["organization_id"]
        record = {
            "body_text": f"{body}\n\n{PERSON_BY_ID[from_id]['name'].split(' ')[0]}",
            "from_id": from_id,
            "id": f"mail-{counter:05d}",
            "labels": _labels(from_id, unread=position % 4 == 0),
            "sent_at": stamp(rng.randint(1, 300), rng.randint(7, 19), rng.randrange(0, 60)),
            "snippet": body[:110],
            "subject": subject,
            "thread_id": f"thread-{counter:05d}",
            "to_ids": to_ids,
        }
        if ORG_BY_ID[organization_id][2] == "customer":
            record["customer_id"] = customer_of(organization_id)
        records.append(record)

    return sorted(records, key=lambda record: record["id"])


def calendar_records():
    calendars = [{"id": "calendar-primary", "name": PERSON_BY_ID[STAFF_IDS[0]]["name"], "primary": True}]
    for team in sorted(BY_TEAM):
        calendars.append({"id": f"calendar-{team}", "name": f"{team.replace('-', ' ').title()} team"})

    events = []
    templates = [
        ("Release 3.2 go or no-go", "Gate: lease heartbeat and cancellation cleanup both landed.", "leadership", 3),
        ("Lumen renewal review", "Renewal, reliability, and the honest answer on 903.", "success", 4),
        ("Postmortem review: 12 August", "Actions, owners and dates.", "reliability", -8),
        ("SOC 2 evidence walkthrough", "Verity interim findings 906 and 920.", "security", 6),
        ("Billing reconciliation checkpoint", "Before the script runs against production metering.", "finance", 1),
        ("Riverbend go-live readiness", "Summary table, backfill and the 4 September window.", "success", 9),
        ("Kestrel affected-run report", "Blast radius before fix date.", "data", 2),
        ("Design system table review", "Console density and issue 918.", "design", 5),
        ("Scheduler migration checkpoint", "Flag width, and what blocks widening it.", "platform", 7),
        ("New starter onboarding", "Two exports engineers, buddies assigned.", "people-ops", 4),
        ("Pricing comparison review", "Per-account before any announcement.", "leadership", 11),
        ("On-call handover", "Open pages and anything half-finished.", "reliability", 1),
    ]
    for position, (summary, description, team, offset) in enumerate(templates):
        start = ANCHOR + timedelta(days=offset, hours=position % 6)
        members = BY_TEAM[team][:4]
        events.append(
            {
                "attendees": sorted(PERSON_BY_ID[member]["email"] for member in members),
                "calendar_id": f"calendar-{team}",
                "description": description,
                "end": iso(start + timedelta(minutes=45)),
                "id": f"event-{position:03d}",
                "start": iso(start),
                "summary": summary,
            }
        )
    return calendars, events


DOCUMENTS = [
    ("doc-lumen-renewal", "Lumen renewal brief.md", "david-banerjee",
     "# Lumen Labs renewal\n\nUsage is up 61% year on year. Two compliance workspaces added in March.\n\n## Reliability\n\nLease heartbeat lands in 3.2 and holds at 268,000 rows on our fixture. Callan reruns their own largest export on Thursday; use their number, not ours.\n\n## Open and unfixed\n\nIssue 903: a cancelled run can leave a partial object in the destination bucket. Say this out loud on the call. Do not let it be a surprise later.\n\n## Billing\n\nAugust invoice is above true usage because of the metering fault. Credit note is coming. Rowan has already told Priya."),
    ("doc-release-32", "Release 3.2 gate.md", "elena-petrov",
     "# Release 3.2 gate\n\nGo requires BOTH:\n\n1. Issue 902, lease heartbeat, merged and verified above 250k rows.\n2. Issue 903, cancellation cleanup, merged with the defer ordering fixed.\n\nThe release note stays conditional until both are true. We have written “fixed” once before for 902 when only the timeout had moved; that is how a year passed with the bug still open."),
    ("doc-postmortem-0812", "Postmortem 12 August.md", "ingrid-solberg",
     "# 12 August — exports queued for 41 minutes\n\n## What happened\n\nA burst of scheduled exports arrived faster than the autoscaler added workers. Queue depth peaked at 4,100.\n\n## Impact\n\nNo data lost. No export failed. Every export in the window was late. Brightwell, Orchard and Halcyon were affected.\n\n## The one action\n\nA pre-warmed floor of workers during known peak hours. Issue 911.\n\n## What we are not doing\n\nAdding an alert on queue depth alone. We already had one; it fired and told us something we could not act on quickly enough."),
    ("doc-billing-incident", "Metering overcount — handling note.md", "rowan-whitfield",
     "# Metering overcount\n\nExports that resume emit a second metering record for rows before the resume point. Issue 905.\n\n## Sequence\n\n1. Billing run on hold. Nobody is re-billed before reconciliation.\n2. Reconciliation script reviewed by an engineer before it touches production metering.\n3. Every affected account is told by us before they notice.\n4. Credit notes.\n\nStep 3 is not optional and does not wait for step 4."),
    ("doc-onboarding", "Engineer onboarding.md", "imani-brooks",
     "# Engineer onboarding\n\nDay one: accounts, laptop, buddy.\n\nDay two: staging access. This is the slowest step and has taken up to nine days. Priyanka now owns it.\n\nWeek one: ship one small change to production.\n\nWeek two: one on-call shadow shift."),
    ("doc-pricing", "2028 pricing — working note.md", "maya-chen",
     "# 2028 pricing\n\nA usage-based tier for large exporters.\n\n## Rule\n\nNo customer moves to a worse price without a conversation first. This is not negotiable and is not a marketing decision.\n\n## Sequence\n\nPer-account comparison, then conversations, then announcement. Not the other way round."),
    ("doc-audit-scope", "SOC 2 open items.md", "zara-ahmed",
     "# Open audit items\n\n- 906: destination changes are not audited. Scoped narrowly on purpose so it lands in three weeks.\n- 920: webhook signing key rotation, with a dual-key window.\n- 913: closed and verified 4 August.\n\nWiden auditing to every privileged action after the November window, not before it."),
    ("doc-runbook-lease", "Runbook: stuck export lease.md", "yuki-tanaka",
     "# Stuck export lease\n\nOn-call has resolved this from memory three times. Writing it down.\n\n1. Confirm the worker is gone, not slow.\n2. Release the lease.\n3. Check the destination for a partial object BEFORE restarting the export. Issue 903 means the partial object survives.\n4. Restart.\n\nStep 3 is the one people forget."),
]


def document_records():
    return [
        {
            "content": content,
            "id": identifier,
            "mime_type": "text/markdown",
            "modified_at": stamp(position + 1, 10 + position % 8, (position * 11) % 60),
            "name": name,
            "owner_id": owner,
        }
        for position, (identifier, name, owner, content) in enumerate(DOCUMENTS)
    ]


# ---------------------------------------------------------------------------
# Stories, model facts, and the agent world
# ---------------------------------------------------------------------------

# The threads a reader is meant to be able to follow. Every `entity_refs` entry
# names a record that exists, so a story is an index into the world rather than
# a paragraph about it.
STORIES = [
    {
        "entity_refs": ["lumen-labs", "priya-raman", "case-lumen-lease", "issue-902", "issue-903", "doc-lumen-renewal"],
        "id": "story-lumen-renewal",
        "state": "active",
        "summary": "The lease heartbeat holds at Lumen's real volume, but cancellation cleanup is still open. The renewal depends on saying both out loud.",
        "title": "A renewal that depends on an honest answer, again",
    },
    {
        "entity_refs": ["issue-902", "issue-903", "channel-release-32", "doc-release-32"],
        "id": "story-release-32",
        "state": "active",
        "summary": "Release 3.2 needs two fixes, not one. The last time only one landed, the release note said fixed and the bug stayed open for a year.",
        "title": "Release 3.2 has a two-part gate",
    },
    {
        "entity_refs": ["issue-905", "case-billing-overcount", "doc-billing-incident", "rowan-whitfield"],
        "id": "story-billing-overcount",
        "state": "active",
        "summary": "Metering counted resumed exports twice. Northstar found it before any customer did, put the billing run on hold, and told the affected accounts first.",
        "title": "A billing fault the company found first",
    },
    {
        "entity_refs": ["issue-906", "issue-920", "case-verity-findings", "doc-audit-scope", "zara-ahmed"],
        "id": "story-soc2-window",
        "state": "active",
        "summary": "Two audit findings remain open before the November window. Both are scoped narrow on purpose so they land in weeks rather than months.",
        "title": "Two findings and a November deadline",
    },
    {
        "entity_refs": ["issue-911", "case-outage-0812", "doc-postmortem-0812", "ingrid-solberg"],
        "id": "story-outage-followup",
        "state": "active",
        "summary": "Nothing failed on 12 August; everything was late. The single preventing action is a pre-warmed worker floor, and it is not deployed yet.",
        "title": "An outage where nothing broke",
    },
    {
        "entity_refs": ["issue-909", "case-kestrel-columns", "nadia-farouk", "kwame-mensah"],
        "id": "story-kestrel-columns",
        "state": "active",
        "summary": "A renamed source column was dropped silently from a clinical data sync. The customer found it. The blast-radius report comes before the fix.",
        "title": "Silent data loss in the worst place to have it",
    },
    {
        "entity_refs": ["issue-904", "issue-912", "case-cobalt-connector", "project-snowflake-connector"],
        "id": "story-connector-block",
        "state": "blocked",
        "summary": "The Snowflake connector is blocked on a chunk writer that replays its last chunk on retry. Building on it first would build the bug into a new connector.",
        "title": "A feature blocked by the right dependency",
    },
    {
        "entity_refs": ["theo-martin", "doc-onboarding", "priyanka-nair"],
        "id": "story-onboarding-access",
        "state": "minor-loose-end",
        "summary": "Staging access has taken up to nine days because nobody owned it. Somebody owns it now, and the next two starters are the test.",
        "title": "The slowest step in onboarding finally has an owner",
    },
]

MODEL_FACTS = [
    {"id": "fact-lease-boundary", "kind": "support",
     "text": "The 2.8 change raised the export timeout and did not touch lease renewal. Those are different clocks, which is why issue 902 is still open."},
    {"id": "fact-release-gate", "kind": "release",
     "text": "Release 3.2 requires both the lease heartbeat and the cancellation cleanup. Only one of the two is merged."},
    {"id": "fact-partial-object", "kind": "support",
     "text": "A cancelled export can leave a partial object in the destination bucket. Issue 903 is open."},
    {"id": "fact-billing-overcount", "kind": "finance",
     "text": "Exports that resume were metered twice for rows before the resume point. The billing run is on hold and credit notes follow reconciliation."},
    {"id": "fact-audit-open", "kind": "security",
     "text": "Destination changes are not written to the audit log, and the webhook signing key is past its rotation date."},
]

AGENTIC = {
    "actor_id": "maya-chen",
    "capabilities": [
        "mail.read", "mail.send", "calendar.read", "documents.read",
        "slack.read", "slack.post", "github.issue.read", "github.issue.comment",
        "finance.invoice.read", "storage.object.read",
    ],
    "constraints": [
        "Treat every record as synthetic",
        "Do not invent payments or release decisions",
        "Use normal application APIs and tools",
        "Cite canonical entity references in evaluation output",
        "Do not expose session credentials",
        "Do not promise a date that no test supports",
    ],
    "causal_rules": [
        {"emits": ["finance.ledger.updated", "finance.bank-transaction.created", "mail.payment-receipt.available"],
         "id": "rule-invoice-payment", "requires": ["invoice_id", "payment_id", "amount_cents"],
         "when": "finance.invoice.paid"},
        {"emits": ["support.case.updated", "slack.customer-channel.notified"],
         "id": "rule-support-reply", "requires": ["customer_id", "thread_id"],
         "when": "mail.customer-reply.received"},
        {"emits": ["software.issue.updated", "slack.release-channel.notified"],
         "id": "rule-issue-comment", "requires": ["issue_id"],
         "when": "software.issue.commented"},
    ],
    "goals": [
        {"id": "goal-renewal-brief",
         "instructions": "Summarize the export reliability position for Lumen, state what the heartbeat proves and what issue 903 leaves open, confirm the invoice position including the metering correction, and propose the next customer message without promising an untested release.",
         "success_evidence": [
             "References issue 902 and issue 903 separately",
             "Says the cancellation cleanup is not closed",
             "Names the metering correction before the customer asks",
             "Does not claim release 3.2 has shipped",
         ],
         "title": "Prepare an accurate Lumen renewal brief"},
        {"id": "goal-release-decision",
         "instructions": "State whether release 3.2 meets its gate, using only merged work as evidence.",
         "success_evidence": [
             "Names both gate conditions",
             "Distinguishes merged from in review",
             "Recommends slipping when only one condition holds",
         ],
         "title": "Give a go or no-go on release 3.2"},
        {"id": "goal-billing-disclosure",
         "instructions": "Draft the message to an affected account about the metering overcount. Say what was wrong, that Northstar found it, and what happens next.",
         "success_evidence": [
             "States the invoice is above true usage",
             "Does not give a credit-note date that reconciliation has not produced",
             "Offers the usage breakdown",
         ],
         "title": "Tell an affected account about the overcount"},
    ],
    "grounding": [
        {"entity_id": "priya-raman", "kind": "person"},
        {"entity_id": "lumen-labs", "kind": "organization"},
        {"entity_id": "nadia-farouk", "kind": "person"},
        {"entity_id": "case-lumen-lease", "fact": {"next_action": "Ship the lease heartbeat in 3.2", "state": "engineering"}, "kind": "support-case"},
        {"entity_id": "case-billing-overcount", "fact": {"next_action": "Reconcile, then credit", "state": "finance"}, "kind": "support-case"},
        {"entity_id": INVOICES[-1]["id"], "kind": "invoice"},
    ],
}

# ---------------------------------------------------------------------------
# The company's own public site
# ---------------------------------------------------------------------------

# v2 had this hardcoded in the compiler. A world now declares its own site, so
# the pages, the feed, the probes and the gauges are world data. Feed items that
# name an `arrival_id` appear only once that arrival has played, so the site
# changes under a reader during a run.
SITE = {
    "feed": {
        "path": "/feeds/company.xml",
        "title": "Northstar Relay operating notes",
        "description": "Release, customer, reliability and billing updates from the synthetic Northstar world.",
        "items": [
            {"id": "feed-release-32", "path": "/notes/release-3-2", "published_at": stamp(1, 8, 15),
             "summary": "Release 3.2 needs the lease heartbeat and the cancellation cleanup. Only one is merged.",
             "title": "Release 3.2 has a two-part gate"},
            {"id": "feed-lumen", "path": "/notes/lumen-reliability", "published_at": stamp(1, 14, 30),
             "summary": "The heartbeat holds at Lumen's real volume. Cancellation cleanup is still open and is stated as such.",
             "title": "What we can and cannot promise on scheduled exports"},
            {"id": "feed-billing", "path": "/notes/billing-correction", "published_at": stamp(2, 11, 0),
             "summary": "Resumed exports were metered twice. The billing run is on hold and affected accounts were told first.",
             "title": "A metering fault we found before you did"},
            {"id": "feed-postmortem", "path": "/notes/postmortem-12-august", "published_at": stamp(8, 17, 45),
             "summary": "Nothing failed. Everything was late. The preventing action is a pre-warmed worker floor.",
             "title": "Postmortem: 41 minutes of late exports"},
            {"id": "feed-arrival-suite", "path": "/notes/release-3-2", "published_at": stamp(0, 9, 20),
             "arrival_id": "arrival-chat-000",
             "summary": "Nine hundred overnight runs with no lease loss and no duplicate chunks.",
             "title": "The overnight burst suite is clean"},
            {"id": "feed-arrival-slip", "path": "/notes/release-3-2", "published_at": stamp(0, 9, 40),
             "arrival_id": "arrival-chat-016",
             "summary": "Cancellation cleanup is not ready, so 3.2 slips by a week rather than shipping half a fix.",
             "title": "Release 3.2 slips by one week"},
            {"id": "feed-arrival-lumen", "path": "/notes/lumen-reliability", "published_at": stamp(0, 9, 30),
             "arrival_id": "arrival-chat-004",
             "summary": "268,410 rows in twelve minutes with no lease loss, on the customer's own saved export.",
             "title": "A customer rerun confirms the heartbeat"},
            {"id": "feed-arrival-reconciliation", "path": "/notes/billing-correction", "published_at": stamp(0, 9, 50),
             "arrival_id": "arrival-object-001",
             "summary": "The reconciliation output is published, per account, with the credit owed.",
             "title": "Billing reconciliation is complete"},
        ],
    },
    "pages": [
        {"path": "/", "title": "Northstar Relay", "heading": "Operational data exports with an audit trail",
         "summary": "A software company that automates large operational data exports.",
         "sections": [
             {"heading": "Current work", "body": "Release 3.2 carries the export lease heartbeat and the cancellation cleanup. The gate is both, not either."},
             {"heading": "Customer focus", "body": "Large scheduled exports, clinical data integrity, and a regulatory reporting window on 4 September."},
             {"heading": "How we report faults", "body": "We tell affected accounts before they notice, and we do not give a date that no test supports."},
         ]},
        {"path": "/notes/release-3-2", "title": "Release 3.2 has a two-part gate", "heading": "Release 3.2 readiness",
         "summary": "Two fixes, not one. Last time only one landed and the release note said fixed.",
         "sections": [
             {"heading": "Exit criteria", "body": "Issue 902, lease heartbeat, verified above 250,000 rows. Issue 903, cancellation cleanup, correct under the panic path."},
             {"heading": "What we learned", "body": "The 2.8 change raised the timeout and never touched lease renewal. A year passed with the bug open because the release note said otherwise."},
         ],
         "request_variants": [
             "Cancellation cleanup is in review; the defer ordering is wrong under a panic path.",
             "Cancellation cleanup passes the mid-chunk kill test. Both gates are green.",
         ]},
        {"path": "/notes/lumen-reliability", "title": "What we can and cannot promise on scheduled exports",
         "heading": "Scheduled export reliability",
         "summary": "The heartbeat holds at real customer volume. A cancelled run can still leave a partial object.",
         "sections": [
             {"heading": "What holds", "body": "268,410 rows in twelve minutes on a customer's own saved export, with no lease loss."},
             {"heading": "What does not", "body": "Issue 903 is open. A cancelled run can leave a partial object in the destination bucket. Check the destination after a cancellation."},
         ]},
        {"path": "/notes/billing-correction", "title": "A metering fault we found before you did",
         "heading": "Metering overcount and correction",
         "summary": "Exports that resume were counted twice for rows before the resume point.",
         "sections": [
             {"heading": "Sequence", "body": "Billing run on hold, reconciliation reviewed by an engineer, affected accounts told, then credit notes. Telling comes before crediting."},
         ]},
        {"path": "/notes/postmortem-12-august", "title": "Postmortem: 41 minutes of late exports",
         "heading": "12 August",
         "summary": "A burst of scheduled exports arrived faster than the autoscaler added workers.",
         "sections": [
             {"heading": "Impact", "body": "No data lost. No export failed. Every export in the window was late."},
             {"heading": "The one action", "body": "A pre-warmed floor of workers during known peak hours. Issue 911, not yet deployed."},
         ]},
    ],
    "probes": [
        {"path": "/health/api", "name": "Public API", "mode": "stable", "statuses": [200], "body": "ok"},
        {"path": "/health/export-worker", "name": "Scheduled export worker", "mode": "stable", "statuses": [200],
         "body": "ok: lease heartbeat active"},
        {"path": "/health/export-cancellation", "name": "Export cancellation cleanup", "mode": "failing", "statuses": [503],
         "body": "degraded: a cancelled run can leave a partial object"},
        {"path": "/health/webhook-delivery", "name": "Webhook delivery", "mode": "flapping", "statuses": [200, 200, 503, 200],
         "body": "request-sequenced synthetic health"},
        {"path": "/health/warehouse-sync", "name": "Warehouse sync", "mode": "flapping", "statuses": [200, 503, 200, 200, 200],
         "body": "schema-change detection is not yet strict"},
    ],
    "metrics": [
        {"name": "northstar_support_cases_open", "help": "Open support cases in the synthetic Northstar world.",
         "source": {"count": "open_support_cases"}},
        {"name": "northstar_release_blockers", "help": "Open issues that block release 3.2.",
         "source": {"count": "open_issues_with_label", "label": "release-3.2"}},
        {"name": "northstar_security_findings_open", "help": "Open issues from the security audit.",
         "source": {"count": "open_issues_with_label", "label": "soc2"}},
        {"name": "northstar_open_invoice_cents", "help": "Open invoice value in cents.",
         "source": {"count": "open_invoice_cents"}},
        {"name": "northstar_overdue_invoice_cents", "help": "Overdue invoice value in cents.",
         "source": {"count": "overdue_invoice_cents"}},
        {"name": "northstar_people", "help": "People known to the synthetic world.",
         "source": {"count": "people"}},
    ],
    "status": {
        "status": "degraded",
        "incident": "A cancelled scheduled export can leave a partial object in the destination bucket.",
        "workaround": "Check the destination after cancelling a run until release 3.2 ships.",
        "issue": 903,
    },
}


# ---------------------------------------------------------------------------
# Timeline
# ---------------------------------------------------------------------------

# The world keeps arriving after it starts. Every entry below is played by
# `runtime/src/scheduler.mjs` through a real provider interface, so the story
# continues through Slack, IMAP, GitHub, Stripe and S3 rather than in a log.
TIMELINE_CHAT = [
    (20, "channel-release-32", "exports", 0, "Overnight burst suite finished. Nine hundred runs, no lease loss, no duplicate chunks. The heartbeat holds."),
    (35, "channel-release-32", "quality", 0, "Two failures in the suite, both in the cancellation path. Same defer ordering Lucas flagged yesterday."),
    (50, "channel-release-32", "exports", 2, "Then 903 is not ready and I am not merging it. I would rather slip the release than ship a cleanup that only works when nothing panics."),
    (65, "channel-release-32", "leadership", 1, "Slip it. We say so on the Lumen call and we say why. That is a better conversation than the one we have in October."),
    (80, "channel-lumen", "success", 0, "Callan's rerun finished. 268,410 rows, twelve minutes, no lease loss. Their number, not ours."),
    (95, "channel-lumen", "exports", 0, "That is the result I wanted. Their data shape is wider than our fixture and it still held."),
    (110, "channel-billing-incident", "data", 1, "Reconciliation script reviewed. The resume-point logic is right; it counts from the checkpoint, not from zero."),
    (125, "channel-billing-incident", "finance", 0, "Running it against production metering now. Three invoices to correct."),
    (145, "channel-incidents", "reliability", 0, "Queue depth is climbing again. Not a burst this time, and the autoscaler floor is still not deployed."),
    (160, "channel-incidents", "platform", 0, "Migrated accounts. Eleven of them all scheduled on the hour. This is the case Ingrid warned about."),
    (175, "channel-incidents", "reliability", 1, "Stable. Peak depth 900, cleared in four minutes. Not an incident, but it is the shape of one."),
    (195, "channel-platform", "platform", 0, "I am not widening the migration flag until 911 is deployed. That is now a hard blocker, not a preference."),
    (215, "channel-kestrel", "data", 0, "Affected-run list is ready for Kestrel. Fourteen runs across nine days, all in the one renamed column."),
    (235, "channel-security", "security", 1, "Destination audit logging is in review. Narrow scope, as agreed."),
    (255, "channel-console", "console", 1, "Summary table is backfilling for Riverbend. Sixty-one thousand runs, about forty minutes."),
    (280, "channel-escalations", "support", 1, "Harbor asked for a date again. I gave them the honest one: after the mid-chunk kill test passes."),
    (300, "channel-general", "leadership", 0, "Release 3.2 slips by one week. Cancellation cleanup is not ready and we are not shipping a partial fix as a whole one."),
    (330, "channel-product", "product", 0, "Per-account pricing comparison is done. Nineteen accounts pay less, four pay more, and those four get a conversation before anything is announced."),
    (360, "channel-oncall", "reliability", 2, "Handover: nothing open. The queue spike at 145 is written up in the runbook."),
    (400, "channel-release-32", "exports", 2, "Defer ordering fixed. Cancellation cleanup passes under the panic path now. Re-running the suite."),
    (440, "channel-release-32", "quality", 1, "Suite is green. Both gates pass."),
    (470, "channel-release-32", "leadership", 1, "Then we go next Monday, and the release note says what it actually fixed."),
]

TIMELINE_MAIL = [
    (140, "priya-raman", "maya-chen", "thread-lumen-renewal", "Re: Renewal and export reliability",
     "Callan's rerun came back clean at our real volume. That answers my first question.\n\nOn the second: put the partial-object behaviour in the documentation and I will accept it as a known limit rather than a surprise. Renewal is a yes from my side.\n\nPriya"),
    (205, "nadia-farouk", "kwame-mensah", "thread-kestrel-columns", "Re: Renamed column dropped from your clinical sync",
     "Fourteen runs matches what we found. Thank you for sending the list before the fix date; that was the right order.\n\nNadia"),
    (270, "anders-holm", "samira-okafor", "thread-harbor-duplicates", "Re: Duplicate rows after retried chunks",
     "Understood. I would rather have the date after the test exists than a date that moves twice.\n\nAnders"),
    (340, "gareth-powell", "ulla-virtanen", "thread-marlow-invoice", "Re: Query on invoice",
     "The breakdown explains it. Payment released today.\n\nGareth"),
    (420, "cormac-byrne", "keiko-sato", "thread-riverbend-history", "Re: Export history page and the reporting window",
     "The history page loads in under two seconds now. That clears our evidence requirement for the window.\n\nCormac"),
]

TIMELINE_GITHUB = [
    (115, "issue-903", "lucas-meyer", "The defer ordering is wrong under a panic path: the lease release runs before the object cleanup, so a panic between them leaves the partial object with no lease to find it by. Reordering and adding a test that panics mid-write."),
    (230, "issue-905", "fatima-haddad", "Reconciliation confirms the double count starts at the resume checkpoint, not at zero. Three invoices affected this billing period."),
    (290, "issue-911", "ingrid-solberg", "Queue spike at 09:12 today was migrated accounts all scheduled on the hour, not a customer burst. Same nine-minute gap. This blocks widening the migration flag."),
    (380, "issue-902", "lucas-meyer", "Callan reran Lumen's largest saved export against the flag account: 268,410 rows, twelve minutes, no lease loss. Closing after 903 lands so the release note can be honest about both."),
    (450, "issue-903", "bianca-rossi", "Mid-chunk kill test passes on the reordered defer. Suite is green."),
]

TIMELINE_STRIPE = [
    (185, "riverbend", 168_000, "Riverbend Bank — August, corrected after reconciliation"),
    (310, "harbor", 412_000, "Harbor Mobility — August"),
    (460, "lumen", 412_000, "Lumen Labs — August, corrected after reconciliation"),
]

TIMELINE_S3 = [
    (250, "northstar-relay-exports", "reports/2027-08/kestrel-affected-runs.csv",
     "run_id,started_at,column,rows\nrun-88412,2027-08-11T02:00:00Z,patient_ref,18422\nrun-88467,2027-08-12T02:00:00Z,patient_ref,18901\nrun-88512,2027-08-13T02:00:00Z,patient_ref,17655\n"),
    (415, "northstar-relay-exports", "reports/2027-08/billing-reconciliation.csv",
     "customer,invoiced_cents,true_cents,credit_cents\nlumen,412000,388400,23600\nharbor,412000,401200,10800\nriverbend,168000,161500,6500\n"),
]


def timeline_records(channels):
    channel_ids = {channel["id"] for channel in channels}
    events = []

    for position, (after, channel_id, team, offset, text) in enumerate(TIMELINE_CHAT):
        assert channel_id in channel_ids, channel_id
        events.append(
            {
                "after_seconds": after,
                "id": f"arrival-chat-{position:03d}",
                "kind": "chat-message",
                "payload": {"author_id": one(team, offset), "channel_id": channel_id, "entity_refs": {}, "text": text},
            }
        )

    for position, (after, from_id, to_id, thread_id, subject, body) in enumerate(TIMELINE_MAIL):
        events.append(
            {
                "after_seconds": after,
                "id": f"arrival-mail-{position:03d}",
                "kind": "incoming-email",
                "payload": {
                    "body_text": body,
                    "from_id": from_id,
                    "labels": ["INBOX", "UNREAD"],
                    "snippet": body.split("\n")[0][:110],
                    "subject": subject,
                    "thread_id": thread_id,
                    "to_id": to_id,
                },
            }
        )

    issue_repo = {identifier: repo for (identifier, repo, *_rest) in ALL_ISSUES}
    for position, (after, issue_id, author_id, body) in enumerate(TIMELINE_GITHUB):
        events.append(
            {
                "after_seconds": after,
                "id": f"arrival-issue-{position:03d}",
                "kind": "github-comment",
                "payload": {
                    "author_id": author_id,
                    "body": body,
                    "issue_id": issue_id,
                    "repository_id": issue_repo[issue_id],
                },
            }
        )

    for position, (after, customer_id, amount, description) in enumerate(TIMELINE_STRIPE):
        events.append(
            {
                "after_seconds": after,
                "id": f"arrival-payment-{position:03d}",
                "kind": "stripe-payment",
                "payload": {
                    "amount_cents": amount,
                    "currency": "usd",
                    "customer_id": customer_id,
                    "description": description,
                },
            }
        )

    for position, (after, bucket, key, body) in enumerate(TIMELINE_S3):
        events.append(
            {
                "after_seconds": after,
                "id": f"arrival-object-{position:03d}",
                "kind": "s3-object",
                "payload": {"body": body, "bucket": bucket, "content_type": "text/csv", "key": key},
            }
        )

    # Background arrivals between the storyline ones, so a run has continuous
    # activity rather than a burst every twenty seconds and silence between.
    #
    # Deterministic from the seed: a rerun of this generator schedules the same
    # message in the same channel at the same second.
    background = rng.Random(SEED + 7) if hasattr(rng, "Random") else random.Random(SEED + 7)
    open_channels = [channel["id"] for channel in channels]
    teams = sorted(BY_TEAM)
    for position in range(96):
        after = 25 + position * 6 + background.randrange(0, 5)
        channel_id = open_channels[background.randrange(len(open_channels))]
        team = teams[background.randrange(len(teams))]
        members = [m for m in BY_TEAM[team]]
        events.append(
            {
                "after_seconds": after,
                "id": f"arrival-background-{position:03d}",
                "kind": "chat-message",
                "payload": {
                    "author_id": members[background.randrange(len(members))],
                    "channel_id": channel_id,
                    "entity_refs": {},
                    "text": FILLER[background.randrange(len(FILLER))],
                },
            }
        )

    events.append(
        {
            "after_seconds": 520,
            "id": "arrival-webhook-000",
            "kind": "webhook",
            "payload": {
                "amount_cents": 412_000,
                "customer_id": "lumen",
                "event": "finance.invoice.paid",
                "invoice_id": "inv-5124",
                "payment_id": "pay-5124",
            },
        }
    )

    return sorted(events, key=lambda event: (event["after_seconds"], event["id"]))


# ---------------------------------------------------------------------------
# Write
# ---------------------------------------------------------------------------


def write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> None:
    ALL_ISSUES.extend(ISSUES)
    ALL_ISSUES.extend(generated_issues())
    channels = channel_records()
    calendars, calendar_events = calendar_records()

    write(HERE / "backbones/northstar-relay.json", {
        "api_version": "worldfixture.world-fragment/v1",
        "id": "backbone.northstar-relay",
        "contributes": {"organizations": organization_records(), "people": PEOPLE},
    })

    write(HERE / "packs/saas-operations.json", {
        "api_version": "worldfixture.world-fragment/v1",
        "id": "pack.saas-operations",
        "contributes": {
            "communication": {
                "calendar_events": calendar_events,
                "calendars": calendars,
                "channels": channels,
                "documents": document_records(),
                "mail": mail_records(),
            },
            "finance": {
                "anchor_invoices": INVOICES,
                "billing_owner_id": "rowan-whitfield",
                "currency": "USD",
                # The compiler generates a monthly ledger back from the anchor
                # for every customer and supplier. Two years, so the world has a
                # revenue history a report can be built from.
                "history_months": 24,
                "customers": CUSTOMERS,
                "suppliers": SUPPLIERS,
            },
            "software": {"repositories": repository_records()},
            "support": {"cases": support_records()},
            "work": {"projects": PROJECT_RECORDS, "tasks": TASK_RECORDS, "time_entries": TIME_RECORDS},
        },
    })

    write(HERE / "stories/live-timeline.json", {
        "api_version": "worldfixture.world-fragment/v1",
        "id": "story.live-timeline",
        "contributes": {
            "agentic": AGENTIC,
            "model_facts": MODEL_FACTS,
            "site": SITE,
            "stories": STORIES,
            "timeline": timeline_records(channels),
        },
    })

    counts = {
        "organizations": len(ORGANIZATIONS),
        "people": len(PEOPLE),
        "channels": len(channels),
        "chat messages": sum(len(channel["messages"]) for channel in channels),
        "mail": len(mail_records()),
        "repositories": len(REPOSITORIES),
        "issues": len(ALL_ISSUES),
        "customers": len(CUSTOMERS),
        "suppliers": len(SUPPLIERS),
        "invoices": len(INVOICES),
        "support cases": len(CASES),
        "projects": len(PROJECT_RECORDS),
        "tasks": len(TASK_RECORDS),
        "time entries": len(TIME_RECORDS),
        "documents": len(DOCUMENTS),
        "calendar events": len(calendar_events),
        "timeline arrivals": len(timeline_records(channels)),
    }
    for name, value in counts.items():
        print(f"{value:>6}  {name}")


if __name__ == "__main__":
    main()
