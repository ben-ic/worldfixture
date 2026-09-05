# Workbench guide

The Workbench shows one running world. Run this command to open the correct
local URL:

```sh
npx worldfixture open
```

The port can change each time that you start a world.

## Your first visit

Use these areas in this order:

1. **Overview**: See what the world contains and copy important connection values.
2. **Services**: See which services are ready or still loading.
3. **Chat**, **Local Mail**, or another product area: Read and change provider state.
4. **Activity**: See events from Workbench, CLI, connector, and scheduled actions that the runtime originated.

Do not call a service until it shows **Ready**.

## Make a change

Write controls call the same provider API that your application calls. After a
successful write, refresh the provider page and open **Activity**. Both areas
show the result from the shared world state.

If a page has **Acting as**, select a world person. The page enables a write only
when that person has the required provider identity and credential.

## Find connection values

Copy values from **Overview**, or run `npx worldfixture env`. Use these values
instead of a fixed port. See [Connect an application](../getting-started/connect-an-app.md).

## Advanced: connect a target application

**Target** is for an application that implements the WorldFixture connector
protocol. It can preview a mapping, seed world data, and replay an event. You do
not need this area for a normal provider API connection.

## Reset

**Reset world** restores resettable services and clears the runtime event
ledger. It keeps PostgreSQL and MariaDB application data. Read the scope in the
confirmation dialog before you continue.
