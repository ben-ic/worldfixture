# Workbench guide

The Workbench shows one running world. Run this command to open the correct
local URL:

```sh
npx worldfixture open
```

The Workbench normally uses port `4715`. It uses a free fallback if that port is
busy.

## Find your way around

![Workbench Overview: navigation on the left, the current actor and readiness at the top, and connection values below the world summary.](/workbench/overview.png)

Use the **left sidebar** to move between product areas. The **top bar** shows
who you act as, service readiness, and **Reset world**. **Overview** shows the
world clock, Loop controls, recent activity, and connection values. Expand
**Explore services** to see the service inventory.

[Open the full-size Overview screenshot](/workbench/overview.png).

The Overview and expanded content screenshots show a local run with all selected
services ready. The Services, Chat, and Activity screenshots show an earlier run
with Slack and GitHub selected. Your people, counts, and ports can differ.
Credentials remain hidden in the images.

## Your first visit

Use these areas in this order:

1. **Overview**: See what the world contains and copy important connection values.
2. **Services**: See which services are ready or still loading.
3. **Chat**, **Local Mail**, or another product area: Read and change provider state.
4. **Activity**: See events from Workbench, CLI, connector, and scheduled actions that the runtime originated.

Do not call a service until it shows **Ready**.

## Find connection values

In **Overview**, find **Connect your app** and choose a service. Select **Copy .env** for that service's
connection values together, or **Copy** beside one value. Tokens are hidden;
**Show** reveals the selected token when you need it.

Select [**Download Postman collection**](http://127.0.0.1:4715/api/postman) to get
every registered route for all selected HTTP providers. It also has every
supported AWS action and every operation in the world's OpenAPI document. The
collection contains the actual URLs and synthetic credentials for the active
run. If WorldFixture prints a Workbench port other than `4715`, change the port
in this link. See [Test the APIs with Postman](./postman.md) for import and OAuth
instructions.

You can also run `npx worldfixture env`. Use these values instead of a fixed
port. See [Connect an application](../getting-started/connect-an-app.md).

For OAuth, the collection includes an **OAuth 2.0 — get a user token** request
for each selected provider that has an active local client. It uses the current
client ID, client secret, provider URL, and Postman callback URL.

Most local apps need no callback setup. The default world accepts common OAuth
callback paths on any port for `localhost`, `127.0.0.1`, and `[::1]`. If your
app uses a different path or host, connect the app first. Then open **Settings**
and add its exact callback URL. The callback must use the connected app's origin.
You do not need to rebuild the world.

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

## Open emails and issues

Select an email row in **Gmail** or **Local Mail** to read its full body in place.
Select **Reply** inside the open message to fill the reply form. Closing a row
returns to the compact message list.

![Local Mail with a streamed notification expanded to show its body.](/workbench/mail-expanded.png)

Select an issue in **Code** to read its description and comments. Content loads
from the provider when you open the row. If a read fails, select **Retry**.

![GitHub issue expanded with its description and comments.](/workbench/github-expanded.png)

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
