---
layout: home

hero:
  name: WorldFixture
  text: Stateful local provider services for development, demos, and CI
  tagline: Start Slack, GitHub, Google, Notion, Stripe, Local Mail, S3, and more with one shared synthetic dataset. Connect your app, inspect live state, and reset it. No production accounts.
  actions:
    - theme: brand
      text: Start in five minutes
      link: /getting-started/quick-start
    - theme: alt
      text: See exact API support
      link: /providers/

features:
  - title: Start here
    details: Use the five-minute path to start a world, send one Slack message, see it in the Workbench, and reset.
    link: /getting-started/quick-start
  - title: Connect your application
    details: Use the generated bindings with an SDK, an HTTP client, or a native protocol. Ports are assigned for each run.
    link: /getting-started/connect-an-app
  - title: Check an API operation
    details: See the exact reads, writes, tested SDKs, and missing operations before you write code.
    link: /providers/
---

## One world, one shared state

WorldFixture runs a synthetic company in one local Docker container. A **world**
contains people, messages, mail, repositories, documents, billing records, and
scheduled events. Your application and the Workbench use the same state.

WorldFixture is for local development, product demos, and automated tests. For
example, DropLive uses WorldFixture for product demos. WorldFixture does not
contact real people or real customer systems. All included domains end in
`.worldfixture.test`.

WorldFixture implements selected provider API operations. It does not implement
each complete provider API. Use the [API support index](/providers/) to check a
read or write before you use it.

## What to do first

1. [Start a world in five minutes](/getting-started/quick-start).
2. Use the Workbench to see service readiness and world state.
3. Copy the generated connection values into your application.
4. Check the exact API support for your provider.
