# Workbench guide

The Workbench shows one running world. Run this command to open the correct
local URL:

```sh
npx worldfixture open
```

The port can change each time that you start a world.

## Find your way around

![Workbench Overview: navigation on the left, the current actor and readiness at the top, and connection values below the world summary.](/workbench/overview.png)

Use the **left sidebar** to move between product areas. The **top bar** shows
who you act as, service readiness, and **Reset world**. **Overview** shows the
world summary and connection values.

[Open the full-size Overview screenshot](/workbench/overview.png).

These screenshots show a running `business.saas-company:v3` world with Slack
and GitHub selected. Your services, people, counts, and ports can differ. Use
the values in your own Workbench. Credentials remain hidden in the images.

<!-- Captured 2026-09-05 with the repository Workbench UI at 5c19dc6, served
     locally against the existing running world's API. The container had an
     older Workbench build. Chat was captured with the current repository
     /api/provider/slack handler connected to that same live Slack service,
     so sender names come from users.list. These are browser captures. -->

## Your first visit

Use these areas in this order:

1. **Overview**: See what the world contains and copy important connection values.
2. **Services**: See which services are ready or still loading.
3. **Chat**, **Local Mail**, or another product area: Read and change provider state.
4. **Activity**: See events from Workbench, CLI, connector, and scheduled actions that the runtime originated.

Do not call a service until it shows **Ready**.

## Find connection values

In **Overview**, find **How does my app connect?**. Select **Copy .env** for the
connection values together, or **Copy** beside one value. Tokens are hidden;
**Show** reveals the selected token when you need it.

You can also run `npx worldfixture env`. Use these values instead of a fixed
port. See [Connect an application](../getting-started/connect-an-app.md).

## Check service readiness

![Services screen: GitHub and Slack are ready, each has an Open button, and an unselected service has a disabled Start button.](/workbench/services.png)

Select **Services** in the sidebar. Check the **State** column before you use a
provider. This image shows two ready services. **Open** takes you to the
selected provider's Workbench page. A disabled **Start** button does not add a
service to the current run.

[Open the full-size Services screenshot](/workbench/services.png).

## Read data and make a change

![Chat screen: channels on the left, messages with sender names on the right, and the Message field and Post message button below.](/workbench/chat.png)

Select **Chat**, then select a channel. Read its history on the right. Check
**Acting as** in the top bar before you enter text in **Message** and select
**Post message**. The composer stays below the message history.

[Open the full-size Chat screenshot](/workbench/chat.png).

Write controls call the same provider API that your application calls. After a
successful write, refresh the provider page to see the updated state.

If a page has **Acting as**, select a world person. The page enables a write only
when that person has the required provider identity and credential.

## Check what happened

![Activity screen: each row shows the time, actor, action, accepting provider, and observed event ID.](/workbench/activity.png)

Select **Activity** to inspect actions that the runtime recorded. Read across
a row to see **Actor**, **Action**, **Accepted by**, and **Observed**. Select
**Refresh** to reload the list.

An API write can change provider state without creating a runtime event. See
[Events and webhooks](./events-and-webhooks.md) for the observation limits.

[Open the full-size Activity screenshot](/workbench/activity.png).

## Advanced: connect a target application

**Target** is for an application that implements the WorldFixture connector
protocol. It can preview a mapping, seed world data, and replay an event. You do
not need this area for a normal provider API connection.

## Reset

**Reset world** restores resettable services and clears the runtime event
ledger. It keeps PostgreSQL and MariaDB application data. Read the scope in the
confirmation dialog before you continue.
