# What a connector receives

This is the `packs` object in a seed or plan request, described from the world
it documents: `business.saas-company:v3`, artifact
`c4b16ab16442…`.

It is generated from the built artifact and checked by a test, so it cannot
drift from what is actually sent. Run `worldfixture connector docs` to read the
version installed alongside your build.

## The shape

```json
{
  "api_version": "worldfixture.connector-request/v1",
  "request_id": "req_…",
  "idempotency_key": "seed:…",        // seed only
  "world": {"id": "…", "version": "…", "artifact_sha256": "…", "title": "…", "clock": {…}},
  "options": {"mode": "apply" | "preview", "scale": {…}},
  "packs": {"communication": {…}, "finance": {…}, "identity": {…}, "software": {…}, "support": {…}, "work": {…}}
}
```

## Rules that hold across every pack

- A record's `id` is a stable slug, not a number, and it is the identifier a
  `worldfixture_ref` addresses: `person/maya-chen`, `channel/channel-soc2`.
- A field ending `_id` names one record. A field ending `_ids` names several.
  A list of ids is a membership list and may be trimmed by a scale slice; a
  single id is a dependency and never dangles.
- People are also addressable by `email`, `github_login` and `slack_id`, and
  some collections use those rather than the person's `id`.
- Collections arrive in a deterministic order, and messages within a channel
  are ordered by `timestamp`.
- A slice is referentially whole. It never contains a record that refers to a
  record it does not contain, so a connector needs no special handling for one.
- `communication.mail` and `communication.resolved_mail` hold the same records. Read one of them; seeding both creates every record twice.

## Collections

19 top-level collections and 2 nested ones, 11,747 top-level records in the full world.

| Pack | Collection | Records |
| --- | --- | --- |
| `communication` | `calendar_events` | 12 |
| `communication` | `calendars` | 17 |
| `communication` | `channels` | 28 |
| `communication` | `channels[].messages` | 1,517 |
| `communication` | `documents` | 8 |
| `communication` | `mail` | 3,069 |
| `communication` | `resolved_mail` | 3,069 |
| `finance` | `bills` | 192 |
| `finance` | `customers` | 24 |
| `finance` | `invoices` | 648 |
| `finance` | `ledger_entries` | 2,832 |
| `finance` | `payments` | 576 |
| `finance` | `suppliers` | 8 |
| `identity` | `organizations` | 35 |
| `identity` | `people` | 161 |
| `software` | `repositories` | 14 |
| `software` | `repositories[].issues` | 153 |
| `support` | `cases` | 15 |
| `work` | `projects` | 16 |
| `work` | `tasks` | 514 |
| `work` | `time_entries` | 509 |

### `communication.calendar_events`

| Field | Type | On every record |
| --- | --- | --- |
| `attendees` | array of string | yes |
| `calendar_id` | string | yes |
| `description` | string | yes |
| `end` | string | yes |
| `id` | string | yes |
| `start` | string | yes |
| `summary` | string | yes |

```json
{
  "attendees": [
    "david@northstar-relay.worldfixture.test",
    "jon@northstar-relay.worldfixture.test",
    "maya@northstar-relay.worldfixture.test",
    "… 1 more"
  ],
  "calendar_id": "calendar-leadership",
  "description": "Gate: lease heartbeat and cancellation cleanup both landed.",
  "end": "2027-08-23T09:45:00Z",
  "id": "event-000",
  "start": "2027-08-23T09:00:00Z",
  "summary": "Release 3.2 go or no-go"
}
```

### `communication.calendars`

| Field | Type | On every record |
| --- | --- | --- |
| `id` | string | yes |
| `name` | string | yes |
| `primary` | boolean | no |

```json
{
  "id": "calendar-primary",
  "name": "Maya Chen",
  "primary": true
}
```

### `communication.channels`

| Field | Type | On every record |
| --- | --- | --- |
| `id` | string | yes |
| `member_ids` | array of string | yes |
| `messages` | array of object | yes |
| `name` | string | yes |
| `topic` | string | yes |

```json
{
  "id": "channel-general",
  "member_ids": [
    "maya-chen",
    "jon-bell",
    "noor-alvarez",
    "… 96 more"
  ],
  "messages": [
    {
      "author_id": "omar-bakri",
      "entity_refs": {},
      "id": "chat-00047",
      "text": "I will pick this up after the release decision.",
      "timestamp": "2027-07-21T09:53:00Z"
    },
    {
      "author_id": "luca-ferrari",
      "entity_refs": {},
      "id": "chat-00018",
      "text": "I updated the runbook while this was fresh.",
      "timestamp": "2027-07-21T15:31:00Z"
    },
    {
      "author_id": "daniel-osei",
      "entity_refs": {},
      "id": "chat-00053",
      "text": "I will pick this up after the release decision.",
      "timestamp": "2027-07-23T16:52:00Z"
    },
    "… 53 more"
  ],
  "name": "general",
  "topic": "Company updates and questions for everyone"
}
```

### `communication.channels[].messages`

Nested inside each `channels` record, not a collection of its own.

| Field | Type | On every record |
| --- | --- | --- |
| `author_id` | string | yes |
| `entity_refs` | object | yes |
| `id` | string | yes |
| `text` | string | yes |
| `timestamp` | string | yes |

```json
{
  "author_id": "omar-bakri",
  "entity_refs": {},
  "id": "chat-00047",
  "text": "I will pick this up after the release decision.",
  "timestamp": "2027-07-21T09:53:00Z"
}
```

### `communication.documents`

| Field | Type | On every record |
| --- | --- | --- |
| `content` | string | yes |
| `id` | string | yes |
| `mime_type` | string | yes |
| `modified_at` | string | yes |
| `name` | string | yes |
| `owner_id` | string | yes |

```json
{
  "content": "# Lumen Labs renewal\n\nUsage is up 61% year on year. Two compliance workspaces added in March.\n\n## Reliability\n\nLease heartbeat lands in 3.2 and holds at 268,000 rows on our fixture. Callan reruns their own largest export on Thursday; use th… (trimmed for this document)",
  "id": "doc-lumen-renewal",
  "mime_type": "text/markdown",
  "modified_at": "2027-08-19T10:00:00Z",
  "name": "Lumen renewal brief.md",
  "owner_id": "david-banerjee"
}
```

### `communication.mail`

| Field | Type | On every record |
| --- | --- | --- |
| `body_text` | string | yes |
| `customer_id` | string | no |
| `from_id` | string | yes |
| `id` | string | yes |
| `invoice_id` | string | no |
| `labels` | array of string | yes |
| `sent_at` | string | yes |
| `snippet` | string | yes |
| `subject` | string | yes |
| `thread_id` | string | yes |
| `to_ids` | array of string | yes |

```json
{
  "body_text": "Hi Kieran,\n\nInvoice 2508-88 for Northstar Team plan is attached. The total is 446.00 USD, due 2025-09-30.\n\nRowan Whitfield",
  "customer_id": "dunmore",
  "from_id": "rowan-whitfield",
  "id": "mail-inv-202508-dunmore",
  "invoice_id": "inv-202508-dunmore",
  "labels": [
    "SENT",
    "Finance"
  ],
  "sent_at": "2025-08-01T09:15:00Z",
  "snippet": "Northstar Team plan · 446.00 USD",
  "subject": "Invoice 2508-88 — Dunmore Legal",
  "thread_id": "thread-inv-202508-dunmore",
  "to_ids": [
    "kieran-walsh"
  ]
}
```

### `communication.resolved_mail`

| Field | Type | On every record |
| --- | --- | --- |
| `body_text` | string | yes |
| `customer_id` | string | no |
| `from_id` | string | yes |
| `id` | string | yes |
| `invoice_id` | string | no |
| `labels` | array of string | yes |
| `sent_at` | string | yes |
| `snippet` | string | yes |
| `subject` | string | yes |
| `thread_id` | string | yes |
| `to_ids` | array of string | yes |

```json
{
  "body_text": "Hi Kieran,\n\nInvoice 2508-88 for Northstar Team plan is attached. The total is 446.00 USD, due 2025-09-30.\n\nRowan Whitfield",
  "customer_id": "dunmore",
  "from_id": "rowan-whitfield",
  "id": "mail-inv-202508-dunmore",
  "invoice_id": "inv-202508-dunmore",
  "labels": [
    "SENT",
    "Finance"
  ],
  "sent_at": "2025-08-01T09:15:00Z",
  "snippet": "Northstar Team plan · 446.00 USD",
  "subject": "Invoice 2508-88 — Dunmore Legal",
  "thread_id": "thread-inv-202508-dunmore",
  "to_ids": [
    "kieran-walsh"
  ]
}
```

### `finance.bills`

| Field | Type | On every record |
| --- | --- | --- |
| `amount_cents` | number | yes |
| `currency` | string | yes |
| `description` | string | yes |
| `id` | string | yes |
| `issued_on` | string | yes |
| `status` | string | yes |
| `supplier_id` | string | yes |

```json
{
  "amount_cents": 18400,
  "currency": "USD",
  "description": "Office and equipment",
  "id": "bill-202508-cedar",
  "issued_on": "2025-08-05",
  "status": "paid",
  "supplier_id": "cedar"
}
```

### `finance.customers`

| Field | Type | On every record |
| --- | --- | --- |
| `contact_id` | string | yes |
| `due_day` | number | yes |
| `id` | string | yes |
| `invoice_day` | number | yes |
| `monthly_amount_cents` | number | yes |
| `name` | string | yes |
| `number_suffix` | string | yes |
| `organization_id` | string | yes |
| `service` | string | yes |

```json
{
  "contact_id": "priya-raman",
  "due_day": 30,
  "id": "lumen",
  "invoice_day": 1,
  "monthly_amount_cents": 412000,
  "name": "Lumen Labs",
  "number_suffix": "70",
  "organization_id": "lumen-labs",
  "service": "Northstar Enterprise plan"
}
```

### `finance.invoices`

| Field | Type | On every record |
| --- | --- | --- |
| `amount_cents` | number | yes |
| `currency` | string | yes |
| `customer_id` | string | yes |
| `description` | string | yes |
| `due_on` | string | yes |
| `id` | string | yes |
| `issued_on` | string | yes |
| `number` | string | yes |
| `status` | string | yes |

```json
{
  "amount_cents": 44600,
  "currency": "USD",
  "customer_id": "dunmore",
  "description": "Northstar Team plan",
  "due_on": "2025-09-30",
  "id": "inv-202508-dunmore",
  "issued_on": "2025-08-01",
  "number": "2508-88",
  "status": "paid"
}
```

### `finance.ledger_entries`

| Field | Type | On every record |
| --- | --- | --- |
| `account` | string | yes |
| `credit_cents` | number | yes |
| `date` | string | yes |
| `debit_cents` | number | yes |
| `id` | string | yes |
| `record_id` | string | yes |

```json
{
  "account": "accounts-receivable",
  "credit_cents": 0,
  "date": "2025-08-01",
  "debit_cents": 44600,
  "id": "entry-inv-202508-dunmore-receivable",
  "record_id": "inv-202508-dunmore"
}
```

### `finance.payments`

| Field | Type | On every record |
| --- | --- | --- |
| `amount_cents` | number | yes |
| `currency` | string | yes |
| `customer_id` | string | yes |
| `id` | string | yes |
| `invoice_id` | string | yes |
| `paid_on` | string | yes |

```json
{
  "amount_cents": 173500,
  "currency": "USD",
  "customer_id": "brightwell",
  "id": "pay-inv-202508-brightwell",
  "invoice_id": "inv-202508-brightwell",
  "paid_on": "2025-09-28"
}
```

### `finance.suppliers`

| Field | Type | On every record |
| --- | --- | --- |
| `bill_day` | number | yes |
| `contact_id` | string | yes |
| `id` | string | yes |
| `monthly_amount_cents` | number | yes |
| `name` | string | yes |
| `organization_id` | string | yes |
| `service` | string | yes |

```json
{
  "bill_day": 5,
  "contact_id": "fern-ellery",
  "id": "cedar",
  "monthly_amount_cents": 18400,
  "name": "Cedar Office",
  "organization_id": "cedar-office",
  "service": "Office and equipment"
}
```

### `identity.organizations`

| Field | Type | On every record |
| --- | --- | --- |
| `domain` | string | yes |
| `id` | string | yes |
| `name` | string | yes |
| `primary` | boolean | no |
| `slug` | string | yes |
| `summary` | string | yes |

```json
{
  "domain": "northstar-relay.worldfixture.test",
  "id": "northstar-relay",
  "name": "Northstar Relay",
  "primary": true,
  "slug": "northstar-relay",
  "summary": "A software company that automates large operational data exports."
}
```

### `identity.people`

| Field | Type | On every record |
| --- | --- | --- |
| `email` | string | yes |
| `github_login` | string | yes |
| `id` | string | yes |
| `location` | string | yes |
| `name` | string | yes |
| `organization_id` | string | yes |
| `primary` | boolean | no |
| `role` | string | yes |
| `slack_id` | string | yes |
| `team` | string | yes |

```json
{
  "email": "maya@northstar-relay.worldfixture.test",
  "github_login": "mayachen",
  "id": "maya-chen",
  "location": "London",
  "name": "Maya Chen",
  "organization_id": "northstar-relay",
  "primary": true,
  "role": "Co-founder and CEO",
  "slack_id": "U000000001",
  "team": "leadership"
}
```

### `software.repositories`

| Field | Type | On every record |
| --- | --- | --- |
| `description` | string | yes |
| `id` | string | yes |
| `issues` | array of object | yes |
| `language` | string | yes |
| `member_ids` | array of string | yes |
| `name` | string | yes |
| `owner_id` | string | yes |
| `topics` | array of string | yes |

```json
{
  "description": "Job orchestration and connector runtime",
  "id": "repo-core",
  "issues": [
    {
      "assignee": "priyankanair",
      "author": "tomasnovak",
      "body": "Harbor Mobility sees duplicate rows after a retried chunk. The chunk writer records progress after the write instead of before, so a retry replays the last chunk.",
      "customer_id": "harbor",
      "id": "issue-904",
      "labels": [
        "bug",
        "customer-harbor"
      ],
      "number": 904,
      "state": "open",
      "support_case_id": "case-harbor-duplicates",
      "title": "Connector retries are not idempotent for chunked destinations"
    },
    {
      "assignee": "paveldvorak",
      "author": "stefanweber",
      "body": "The legacy queue cannot express lease renewal, which is why 902 exists. The new scheduler is behind a flag for eleven accounts. Do not widen the flag until 902 and 903 are both closed.",
      "id": "issue-910",
      "labels": [
        "migration",
        "release-3.2"
      ],
      "number": 910,
      "state": "open",
      "title": "Migrate the job scheduler off the legacy queue"
    },
    {
      "assignee": "tomasnovak",
      "author": "adalindqvist",
      "body": "Raised during code review. Not urgent, and it will be much harder to change after the 3.2 release.",
      "id": "issue-1001",
      "labels": [
        "bug",
        "core"
      ],
      "number": 1001,
      "state": "open",
      "title": "Scheduler lease renewal — inconsistent"
    },
    "… 8 more"
  ],
  "language": "Go",
  "member_ids": [
    "ada-lindqvist",
    "amara-diallo",
    "idris-coulibaly",
    "… 2 more"
  ],
  "name": "relay-core",
  "owner_id": "northstar-relay",
  "topics": [
    "jobs",
    "connectors",
    "queues"
  ]
}
```

### `software.repositories[].issues`

Nested inside each `repositories` record, not a collection of its own.

| Field | Type | On every record |
| --- | --- | --- |
| `assignee` | string | yes |
| `author` | string | yes |
| `body` | string | yes |
| `customer_id` | string | no |
| `id` | string | yes |
| `labels` | array of string | yes |
| `number` | number | yes |
| `state` | string | yes |
| `support_case_id` | string | no |
| `title` | string | yes |

```json
{
  "assignee": "priyankanair",
  "author": "tomasnovak",
  "body": "Harbor Mobility sees duplicate rows after a retried chunk. The chunk writer records progress after the write instead of before, so a retry replays the last chunk.",
  "customer_id": "harbor",
  "id": "issue-904",
  "labels": [
    "bug",
    "customer-harbor"
  ],
  "number": 904,
  "state": "open",
  "support_case_id": "case-harbor-duplicates",
  "title": "Connector retries are not idempotent for chunked destinations"
}
```

### `support.cases`

| Field | Type | On every record |
| --- | --- | --- |
| `contact_id` | string | yes |
| `customer_id` | string | yes |
| `id` | string | yes |
| `next_action` | string | yes |
| `opened_at` | string | yes |
| `owner_id` | string | yes |
| `priority` | string | yes |
| `state` | string | yes |
| `title` | string | yes |

```json
{
  "contact_id": "priya-raman",
  "customer_id": "lumen",
  "id": "case-lumen-lease",
  "next_action": "Ship the lease heartbeat in 3.2 and confirm at 268k rows with Callan.",
  "opened_at": "2027-08-11T09:00:00Z",
  "owner_id": "samira-okafor",
  "priority": "high",
  "state": "engineering",
  "title": "Large scheduled exports lose their worker"
}
```

### `work.projects`

| Field | Type | On every record |
| --- | --- | --- |
| `customer_id` | string | no |
| `id` | string | yes |
| `member_ids` | array of string | yes |
| `name` | string | yes |
| `owner_id` | string | yes |
| `start_on` | string | yes |
| `status` | string | yes |
| `summary` | string | yes |
| `target_on` | string | yes |

```json
{
  "id": "project-release-32",
  "member_ids": [
    "ben-hartley",
    "jon-bell",
    "maya-chen",
    "… 1 more"
  ],
  "name": "Release 3.2",
  "owner_id": "maya-chen",
  "start_on": "2027-08-06",
  "status": "active",
  "summary": "Lease heartbeat, cancellation cleanup and the scheduler migration.",
  "target_on": "2027-09-01"
}
```

### `work.tasks`

| Field | Type | On every record |
| --- | --- | --- |
| `assignee_id` | string | yes |
| `description` | string | yes |
| `due_on` | string | yes |
| `id` | string | yes |
| `labels` | array of string | yes |
| `priority` | string | yes |
| `project_id` | string | yes |
| `reporter_id` | string | yes |
| `status` | string | yes |
| `title` | string | yes |

```json
{
  "assignee_id": "ben-hartley",
  "description": "Part of Release 3.2. The lease heartbeat is on the critical path for 2027-09-01.",
  "due_on": "2027-09-12",
  "id": "task-0001",
  "labels": [
    "high",
    "release-32"
  ],
  "priority": "high",
  "project_id": "project-release-32",
  "reporter_id": "jon-bell",
  "status": "review",
  "title": "Write the the lease heartbeat design note"
}
```

### `work.time_entries`

| Field | Type | On every record |
| --- | --- | --- |
| `date` | string | yes |
| `id` | string | yes |
| `minutes` | number | yes |
| `note` | string | yes |
| `person_id` | string | yes |
| `task_id` | string | yes |

```json
{
  "date": "2027-08-07",
  "id": "time-0001",
  "minutes": 150,
  "note": "Write the the lease heartbeat design note.",
  "person_id": "ben-hartley",
  "task_id": "task-0001"
}
```
