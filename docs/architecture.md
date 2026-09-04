# WorldFixture architecture

How the system is built and how a world actually runs. This describes what is
implemented, not what is planned.

## What the pieces are

```mermaid
graph TB
  subgraph author["Authoring — your machine, or this repository"]
    SRC["World source<br/>world.json + fragments"]
    GEN["generate.py<br/>committed beside its output"]
    GEN -.->|reproduces byte-identically| SRC
  end

  subgraph compile["Compiler — Python, no dependencies"]
    VAL["validate<br/>schema + profile rules"]
    PROJ["project<br/>one file per service"]
    ART["Immutable artifact<br/>content-addressed"]
    VAL --> PROJ --> ART
  end

  subgraph container["One Docker container"]
    SUP["Supervisor<br/>starts services, proves readiness"]
    subgraph svc["Services — real protocols"]
      EMU["emulate<br/>15 provider APIs"]
      MAIL["Cyrus IMAP + SMTP"]
      S3["SeaweedFS S3"]
      HTTP["public site"]
      PG["PostgreSQL"]
      MY["MariaDB"]
    end
    RT["Runtime<br/>clock · scheduler · rules · ledger"]
    WB["Workbench UI"]
    SUP --> svc
    RT --> svc
    WB --> RT
  end

  subgraph consumers["What uses the world"]
    CLI["worldfixture CLI"]
    APP["Your application<br/>via a connector"]
    MCP["MCP client / agent"]
  end

  SRC --> VAL
  ART -->|mounted read-only| SUP
  CLI --> RT
  APP --> svc
  MCP --> svc
  RT -->|seed · events| APP

  classDef immutable fill:#1f2937,stroke:#60a5fa,color:#e5e7eb
  class ART,SRC immutable
```

The runtime owns time, schedules, causal rules and the observation ledger. Each
service owns its own provider-specific state. The artifact owns the starting
facts. Nothing owns two of those.

## Compiling a world

```mermaid
flowchart LR
  A["world.json<br/>manifest"] --> C{{"compiler"}}
  B["fragments/*.json<br/>contributed records"] --> C

  C --> D["world.json<br/>the resolved world"]
  C --> E["packs/*.json<br/>identity · communication · work<br/>finance · software · support"]
  C --> F["projections/*.json<br/>slack · github · google · notion<br/>stripe · mail · s3 · linear · okta …"]
  C --> G["timeline.json<br/>scheduled arrivals"]
  C --> H["manifest.json<br/>digest of every file"]

  E -.->|"sent to your app"| I["connector seed"]
  F -.->|"loaded at startup"| J["each service"]
  G -.->|"played by the clock"| K["scheduler"]
```

Packs are the vendor-neutral view an application connector receives.
Projections are per-service views a service loads through its own seed
interface. Both come from the same records, which is what makes the surfaces
agree with each other.

The compiler is deterministic: the same source bytes always produce the same
artifact digest. No clock, no randomness, no filesystem order, no host values.

## Starting an instance

```mermaid
sequenceDiagram
  autonumber
  actor U as You
  participant CLI as worldfixture CLI
  participant D as Docker
  participant S as Supervisor
  participant SV as Services
  participant CK as Clock

  U->>CLI: worldfixture up
  CLI->>CLI: ensure image, select free ports
  CLI->>D: docker run (token by name, not in argv)
  D->>S: start
  S->>S: rebase the world onto today
  S->>SV: start each service the environment requires
  SV-->>S: load my projection
  S->>SV: protocol readiness probe
  Note over S,SV: a capability with no measured check is refused
  SV-->>S: ready
  S-->>CLI: workbench.json
  CLI-->>U: Workbench URL (about 1s)
  S->>S: capture the accepted baseline
  S->>CK: start the clock
  Note over CK: world time begins AFTER readiness,<br/>so startup does not consume the timeline
  S-->>CLI: bindings.json + environment.lock.json
  CLI-->>U: the ready screen
```

## The clock, and why the world is both immutable and live

The artifact holds the whole arc. `now` is a cursor inside it. Liveness is the
cursor moving, so nothing is generated at run time and the world stays
reproducible.

```mermaid
flowchart LR
  subgraph arc["One immutable artifact"]
    direction LR
    P["PAST<br/>seeded history<br/>a year of mail, invoices,<br/>issues and messages"]
    N(("NOW"))
    F["FUTURE<br/>scheduled arrivals<br/>delivered as world time<br/>passes them"]
    P --- N --- F
  end
  N -.->|"clock advances"| F
  R["up rebases the arc onto today,<br/>so history ends just before now<br/>and arrivals are still ahead"] -.-> N

  classDef cursor fill:#1d4ed8,stroke:#93c5fd,color:#fff
  class N cursor
```

```mermaid
stateDiagram-v2
  [*] --> Starting
  Starting --> Running: readiness proven, clock starts
  Running --> Paused: pause
  Paused --> Running: resume
  Running --> Running: advance (costs no wall time)
  Paused --> Paused: advance
  Running --> Starting: reset (cursor returns to the anchor)
  Running --> [*]: down
```

A pause costs no world time and an advance costs no wall time. That separation
is what lets you step a world for debugging, or jump a month forward in a demo,
without the artifact changing.

## How an event happens

Only a completed provider action creates an event. A proposal is not evidence.

```mermaid
sequenceDiagram
  autonumber
  participant SCH as Scheduler
  participant AR as arrivals.mjs
  participant P as Provider service
  participant L as Event ledger
  participant R as Causal rules

  SCH->>SCH: due_at <= world elapsed?
  SCH->>AR: play this arrival
  AR->>P: the real provider API call
  Note over AR,P: never a direct write to a service database
  P-->>AR: provider evidence (ids, timestamps)
  AR->>L: completed event, caused_by the command
  L->>R: does any rule match this type?
  R->>SCH: emit follow-on events, after a bounded delay
  Note over R: rules match a type, copy fields,<br/>look up world values, delay, emit.<br/>They do not run scripts.
```

An arrival kind the runtime cannot play is skipped **with its name in the
reason**. A world may declare a kind this runtime does not implement yet; it may
not have that pass unremarked.

## Connecting your own application

```mermaid
sequenceDiagram
  autonumber
  participant W as WorldFixture
  participant A as Your application

  W->>A: GET /.well-known/worldfixture
  A-->>W: capabilities + accepted packs
  W->>A: POST /__worldfixture/plan (mode preview)
  A-->>W: mappings, counts, warnings — nothing written
  W->>A: POST /__worldfixture/seed (idempotency_key)
  A-->>W: receipt + application references
  loop as the world clock runs
    W->>A: POST /__worldfixture/events
    A-->>W: applied | already_applied
  end
```

The connector runs inside your application, so it maps world records onto your
own domain model through your ORM or service layer. WorldFixture owns the
records, the clock and the delivery order; your application owns the mapping.

A slice may be sent instead of the whole world. A slice is always referentially
whole: it never contains a record that refers to a record it does not contain,
and it never empties a collection the world has records in.

## The artifact and the runtime state

```mermaid
classDiagram
  class Artifact {
    +manifest.json
    +world.json
    +packs/
    +projections/
    +timeline.json
    immutable
    content-addressed
  }
  class EnvironmentLock {
    +world digest
    +one implementation per capability
    +projection digests
  }
  class RuntimeState {
    +clock
    +events
    +commands
    +scheduled_events
    +service_cursors
    +actor_leases
  }
  class Service {
    +name
    +provides[]
    +world.requires[]
    +readiness[]
    +lifecycle
  }

  Artifact --> EnvironmentLock : pinned by
  EnvironmentLock --> Service : selects one per capability
  Service --> Artifact : loads its projection
  RuntimeState --> Artifact : records facts about
```

`reset` restores provider, mail, storage, runtime, clock and timeline state to
the accepted baseline captured at startup. It preserves application database
data, because WorldFixture does not own your application's lifecycle.

## Rules that hold everywhere

1. A world is data. It is fully useful with no agents running.
2. Applications use real interfaces — Slack over the Slack Web API, mail over
   SMTP and IMAP, storage over S3, and so on. Nobody writes a service database.
3. The starting state is immutable. A run pins one artifact and one
   implementation per capability.
4. Each state has one authority.
5. Only a provider-shaped service can accept an action and change its state.
6. Cross-service behaviour is explicit world data, not code.
7. A capability with no measured readiness check is refused rather than claimed.
