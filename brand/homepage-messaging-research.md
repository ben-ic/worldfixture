# WorldFixture: user questions and homepage message

Research date: 8 September 2026. This is a messaging note, not a customer survey.

**Recommended message: Give your working app a company to demo and test against.**

The best initial audience is a technical founder or developer whose product connects to business services. The immediate need is to show or test a complete workflow with related data already present. A founder-led demo is a clear way to explain that need. Repeatable development and testing are further uses of the same environment.

This is a recommendation from the sources and the product's current scope. It is not evidence that demos have greater market demand than testing. Keep the existing headline, “A fake company your software can interact with,” and the single main CTA, `npx worldfixture up`.

## What people ask on Reddit

Questions below are quoted only where marked. Other wording is a short paraphrase. Sources describe people's stated needs, not verified WorldFixture users or independently measured results.

| Source | Question or problem | What the person needs | Message implication |
| --- | --- | --- | --- |
| [R1: Sandbox data — r/salesengineers](https://www.reddit.com/r/salesengineers/comments/1h868nw) | A sales engineer's demo data resets monthly. They ask how to keep it current and meaningful. | Prepare and maintain a convincing demo scenario. | Explain the included company and repeatable provider state. Do not promise automatic upkeep of every app's database. |
| [R2: Realistic SaaS demo data — r/dataengineering](https://www.reddit.com/r/dataengineering/comments/1q9r69d/how_do_you_handle_realistic_demo_data_for_saas/) | Their demo data has smooth growth and lacks failed payments, churn, and useful lifecycle changes. | Data that can exercise meaningful behavior. | Show a specific customer task. Do not equate lots of rows with useful data, or claim statistical realism. |
| [R3: Sandboxes for many services — r/softwarearchitecture](https://www.reddit.com/r/softwarearchitecture/comments/1trrhqf/sandbox_environments_for_apps_with_many_different/) | “How do you guys design sandbox environments for applications with 5+ 3rd party services?” Accounts, quotas, and changed test state cause problems. | One manageable environment for a workflow across several providers. | Explain how related records are present across services and how the app connects. |
| [R4: E2E tests with third-party APIs — r/SaaS](https://www.reddit.com/r/SaaS/comments/1tzsgev/testing_endtoend_with_3rd_party_apis/) | A webhook starts a workflow, but a later API read must find the right object. Static responses are hard to maintain. | State that survives across requests, plus controlled events. | Explain supported reads, writes, and event delivery. The cited Zoom workflow is a need example, not a claim of Zoom support. |
| [R5: Testing third-party services — r/ExperiencedDevs](https://www.reddit.com/r/ExperiencedDevs/comments/1aoh9v4/testing_3rd_party_services/) | Mocks become stale; live API checks fail for reasons unrelated to the code change. | Separate checks of app behavior from checks of the real provider. | State the testing boundary. Local emulation cannot prove production compatibility. |
| [R6: Local development against third-party APIs — r/webdev](https://www.reddit.com/r/webdev/comments/1w31dmx/how_do_you_handle_local_dev_against_thirdparty/) | The author asks how teams detect API drift and test pagination with more than a few records. | A useful local dataset and independent checks that the real API still matches. | Be explicit about support and limits. Do not claim the local world detects upstream API changes. |
| [R7: Adding a demo account — r/SaaS](https://www.reddit.com/r/SaaS/comments/1mhkij1) | This is an experience report, not a question. The author describes a populated demo account with periodic resets. | Let visitors understand a working product before doing their own setup. | A populated demo is an understandable benefit. WorldFixture does not itself provide public demo hosting or account isolation. |
| [R8: Mocks or API sandboxes for agents — r/aiagents](https://www.reddit.com/r/aiagents/comments/1v7pmxl/whats_the_difference_between_mocking_an_api_and/) | “When would you use one over the other?” The author reports production bugs that mocks did not catch. | A clear decision rule and stronger checks of resulting state. | Explain when a workflow environment adds value, and when a small mock is enough. |

R3 and R4 have the same author. R4 also appears as a near-identical post in r/vibecoding. Treat these as one person's related needs, not three independent demand signals. R1, R2, R7, and R8 were available through indexed Reddit post text; direct fetches of R1 and R7 failed. R3–R6 were also checked on fetched thread pages. Retrieval dates are not posting dates. Votes and claimed conversion changes are not used as market measurements.

Vendor promotion and generic launch posts were excluded from the core question set. The findings do not establish demand size, willingness to pay, or current adoption.

## What these questions mean for WorldFixture

The problem has three parts: getting useful records, making the records agree across services, and keeping a workflow repeatable. WorldFixture is most distinct when all three matter. A page that only says “fake data” hides the service behavior. A page that only lists APIs hides the value of the shared company.

The first story should show the visitor's own product doing useful work. The support app is an example of such a product. WorldFixture does not itself decide which customer needs attention, summarize a case, or send an app's chosen follow-up. The connected app implements that logic.

“Who is using it?” needs two separate answers. The intended users are technical founders, integration developers, and engineers preparing product demos. For actual use, the repository README names droplive.io as a product-demo example. This research did not independently verify that deployment or find a broader customer count. Do not present the Reddit authors as customers.

Local product sources: [README](../README.md), [Account Desk demo](../examples/demo_app/README.md), [connect an app](../docs/getting-started/connect-an-app.md), [API support policy](../docs/providers/support-policy.md), [reset rules](../docs/guides/reset-and-persistence.md), and [timeline controls](../docs/guides/timeline.md).

## Short homepage FAQ

The six questions cover who, what, when, when not, alternatives, and a concrete use case. Keep each answer collapsed by default.

**Who is WorldFixture for?**

Founders and developers building apps that connect to business services such as Slack, Gmail, GitHub, and Stripe.

**What can I use it for?**

Give your working app a populated demo, develop an integration, or test a workflow across services. Your app runs; WorldFixture supplies the local services and company data.

**When is it useful?**

Before a customer demo, while building an integration, or when tests need the same starting data. It helps when people and records must match across several services.

**When are normal tests a better fit?**

Use unit tests and mocks for isolated logic, and a real test database for database behavior. Keep provider sandbox checks: WorldFixture implements selected API operations, not complete copies of each provider.

**How does it compare to other tools?**

Faker generates data. WireMock lets you define API behavior. WorldFixture provides a company across local services, with shared history and events. It builds on emulate.dev for many of its APIs.

**What would a product demo look like?**

A founder shows a support app reading a customer email and invoice, sending a reply, and posting a Slack update. The app works through local APIs; the company and its records are synthetic.

The answers combine the stated Reddit needs with local product documentation. They are product copy, not quotations or testimonials. R1, R2, and R7 inform the demo answers; R3 and R4 inform the workflow answers; R5, R6, and R8 inform the testing boundary. Official tool sources below support the comparison.

## How it compares

This table belongs in the research note, not on the homepage. The choice guidance is our assessment of each tool's stated scope.

| Approach | Use it when | Where WorldFixture differs |
| --- | --- | --- |
| Unit tests and narrow mocks | You need to check one function, branch, error response, or outgoing request. | A whole company is extra setup when a small controlled input answers the question. |
| [Faker and seed scripts](https://fakerjs.dev/guide/usage) | You need generated values and can define the relationships and insertion logic yourself. | WorldFixture includes company scenarios and runs local provider services. Faker can be used to create related records; do not claim it inherently breaks relationships. |
| [WireMock](https://wiremock.org/docs/stateful-behaviour/) | You want to define a specific API response or sequence. WireMock supports stateful scenarios. | WorldFixture supplies an authored company across supported services. The distinction is the included scenario and services, not “mocks cannot have state.” |
| [VCR](https://github.com/vcr/vcr) | You can record representative HTTP exchanges and replay them in tests. | WorldFixture supplies changing local service state. Neither approach automatically proves that the real provider still behaves the same way. |
| [Testcontainers](https://testcontainers.com/getting-started/) | You need actual databases, queues, or other containerized dependencies in a test. | It manages test dependencies; WorldFixture adds company data and provider emulation. They can be used together. |
| [LocalStack](https://docs.localstack.cloud/aws/getting-started/) | Your main task is local AWS application or infrastructure testing. | WorldFixture focuses on a shared company across business services and protocols. Do not claim equivalent AWS coverage. |
| [emulate.dev](https://emulate.dev/) | You need its supported local API emulators and want to supply or seed the records yourself. It also provides seeding and reset facilities. | WorldFixture builds on these emulators and adds authored worlds, shared history, scheduled activity, Workbench, and other services. It is not an unrelated replacement for emulate.dev. |
| [Official provider sandboxes](https://docs.stripe.com/testing-use-cases?locale=en-GB) | You need to check the provider's supported test behavior, integration setup, or a flow WorldFixture does not implement. | WorldFixture gives a local company scenario. Keep official sandbox and appropriate real-provider checks; local success is not a production-parity certificate. |

WorldFixture also does not replace the test runner. Browser tests or API tests still perform actions and make assertions. A successful HTTP response is weaker evidence than reading the resulting record back. Do not use local emulator timing to claim production performance or complete failure coverage.

## A complete story: Jens demos his support product

This is a fictional scenario grounded in the Account Desk example. Jens is not a customer testimonial. Investor interest, revenue, or conversion is not an asserted outcome.

**The product and the problem.** Jens is a technical founder building a support application for small software companies. His product brings a customer's email, billing information, and related work into one screen. It lets a support employee prepare a reply and update the team. Jens has an investor meeting on Thursday. The application runs, but his development accounts contain a few unrelated test messages and an empty billing view. He cannot show a normal day at a customer company.

**The preparation.** Jens checks that WorldFixture supports the Gmail, Stripe, Slack, and GitHub operations his app uses. He starts the included Northstar Relay company with `npx worldfixture up`. The company has people, customers, email, conversations, invoices, and work records. He reads `npx worldfixture env` and configures his application's provider clients to use those local URLs and synthetic credentials. WorldFixture does not automatically connect arbitrary software: Jens sets up the integrations and any application-owned data his app needs.

**The rehearsal.** Jens opens his own support app. Its ordinary API calls now read Northstar's local services. The app shows a customer's message beside the matching invoice. Its application code makes that connection using the customer identifiers. Jens confirms that his chosen demo case has the required records, pauses the world clock for a stable presentation, and runs the flow once before the meeting.

**The live demo.** Jens tells the investors, “This is a fictional company using my product.” He takes the role of a support employee. He opens the customer's email, checks the invoice, and reviews the related work. The investors see why the support employee needs the product: the information needed to answer the customer is available in one place.

**The action.** Jens prepares a reply in his app. He selects a Slack channel for a team update, reviews both messages, and approves them. His app sends the reply through the local Gmail API and posts through the local Slack API. He opens the Workbench to show the reply in Sent messages and the update in the channel. These are saved records in the emulated services. They are not sent to real customer accounts.

**The full path.** A populated customer case → the app reads email and billing data → the support employee reviews the case → the app writes a reply and a team update → fresh provider reads confirm both results. The product does the useful work. WorldFixture supplies the company and services that make the work possible to demonstrate.

**The repeat.** Before another demo, Jens resets WorldFixture's provider state with `npx worldfixture reset`. He separately restores his app's demo database, caches, and action receipts as needed. WorldFixture reset does not clear those for him. He restores the same clock position and checks the case again. If a presentation needs a new event, he rehearses a supported scheduled arrival and his app's refresh or event handling first; he does not assume all services emit native webhooks.

**The next day.** Jens turns the same flow into an automated test: read the selected case, prepare the reply, submit it, and assert that the local Gmail and Slack records exist. He keeps fast unit tests for his matching and validation code. Before real customer use, he also tests the supported production integration path with the actual providers. This separates three useful outcomes: showing his product, checking his workflow, and checking the real provider.

The Account Desk documentation supports the read → prepare → review → approve → write → fresh readback path. It also states that reset preserves the app's stored receipts and drafts. No live runtime test was performed as part of this messaging research.

## What goes on the homepage

Keep the existing headline and main command. Keep the service example and the connection panel. Replace the generic sentence before the example with:

> Demo a support app with a customer's email, the related GitHub issue, and the team's Slack conversation already in place.

That sentence tells the reader what kind of product can use the environment. It does not suggest that WorldFixture is a churn prediction tool. The FAQ explains the wider uses and boundaries. The full Jens story and comparison table remain here.

Do not add persona cards, a feature matrix, another main button, or the research sources to the landing page. Do not restore technical requirements above the main action. Each visible section should answer one question.

A useful next validation is to show this page to developers without explanation. Ask them what software they would connect, what they would demonstrate, and what still needs a real-provider test. Their answers can test whether the message is understood; the Reddit sample alone cannot.
