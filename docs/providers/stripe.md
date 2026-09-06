# Stripe

## What works

WorldFixture supports selected Customers, PaymentIntents, payment methods,
charges, products, prices, Checkout Sessions, and Customer Sessions. It adds
invoice items, invoices, and subscriptions for the Workbench. The added billing
flow is **Supported and contract-tested**. The larger Stripe surface is
**Supported but partial**.

The official `stripe` Node SDK 22.6.1 is tested for the billing calls that the
Workbench uses. The tested API version is `2026-08-26.dahlia`.

## What does not work

Taxes, discounts, disputes, credit notes, quotes, meters, usage
records, subscription schedules, revisions, Connect branches, broad payment
failure states, hosted invoice pages, and invoice PDFs do not work. Complete
production authorization, idempotency, paging, rate limits, and errors also do
not work. These operations are **Not supported**. Production behavior is
**Not verified against the production provider**.

## Connect

Use `STRIPE_BASE_URL` and `STRIPE_TOKEN` from `worldfixture env`. Send the
token as bearer authentication. Send normal Stripe form-encoded bodies. Set the
Node SDK host to `STRIPE_BASE_URL`.

The token is an account credential. The product rejects anonymous requests and
unknown tokens.

WorldFixture uses `@emulators/stripe` 0.10.0. Existing emulate.dev routes stay
unchanged. WorldFixture adds the billing and transaction routes below. All routes use one store.

## emulate.dev route reference

| Resource | Exact methods and paths | Input and output | Proof |
| --- | --- | --- | --- |
| Customers | `GET, POST /v1/customers`<br>`GET, POST, DELETE /v1/customers/:id` | Stripe form fields or list filters; customer data | Registered route source |
| PaymentIntents | `GET, POST /v1/payment_intents`<br>`GET, POST /v1/payment_intents/:id`<br>`POST /v1/payment_intents/:id/confirm`<br>`POST /v1/payment_intents/:id/cancel` | Local intent fields or filters; PaymentIntent data | Registered route source |
| Payment methods | `GET /v1/payment_methods` | List filters; payment-method list | Registered route source |
| Charges | `GET /v1/charges`<br>`GET /v1/charges/:id` | List filters or ID; charge data | Registered route source |
| Products | `GET, POST /v1/products`<br>`GET /v1/products/:id` | Product form or filters; product data | Registered route source |
| Prices | `GET, POST /v1/prices`<br>`GET /v1/prices/:id` | Price form or filters; price data | Registered route source |
| Checkout Sessions | `GET, POST /v1/checkout/sessions`<br>`GET /v1/checkout/sessions/:id`<br>`POST /v1/checkout/sessions/:id/expire` | Session form or filters; Checkout Session data | Registered route source |
| Customer Sessions | `POST /v1/customer_sessions` | Customer Session form; Customer Session data | Registered route source |

The local hosted checkout routes are `GET /checkout/:id` and
`POST /checkout/:id/complete`. These local pages are **Workbench-only**.

These emulate.dev routes have no WorldFixture comparison with the official
Stripe schema or a production recording. Use only the fields and state changes
that the pinned module defines.

## WorldFixture billing route reference

All request bodies use Stripe form encoding. List responses use
`object: "list"`, `data`, `has_more`, and `url`. Object responses include
the official fields listed in
`emulators/emulate/contracts/stripe/billing-2026-08-26.contract.json`.

| Method and path | Exact supported input or state | Output | Proof |
| --- | --- | --- | --- |
| `POST /v1/invoiceitems` | `amount` or `pricing[price]`; customer; optional draft invoice; integer and resource checks | Invoice Item | SDK and operation test |
| `GET /v1/invoiceitems` | `limit`, cursors, `customer`, `invoice`, and `pending` | Invoice Item list | Operation test |
| `GET /v1/invoiceitems/:id` | Existing item ID | Invoice Item | Contract and error test |
| `DELETE /v1/invoiceitems/:id` | Item on a draft invoice | Deleted Invoice Item | State-transition test |
| `POST /v1/invoices` | Customer and manual draft-invoice branch | Draft Invoice | SDK and operation test |
| `GET /v1/invoices` | `limit`, cursors, `customer`, and `status` | Invoice list | Operation test |
| `GET /v1/invoices/:id` | Existing invoice ID | Invoice | Official field-inventory test |
| `POST /v1/invoices/:id` | Draft `description`, `due_date`, `auto_advance`, and `metadata` | Updated Invoice | Operation test |
| `DELETE /v1/invoices/:id` | Draft invoice only | Deleted Invoice | State-transition test |
| `GET /v1/invoices/:id/lines` | Existing invoice ID | Invoice Line Item list | Official field-inventory test |
| `POST /v1/invoices/:id/finalize` | Draft invoice | Open Invoice | SDK, state, and webhook test |
| `POST /v1/invoices/:id/pay` | Open invoice; local success or out-of-band branch | Paid Invoice | State and event test |
| `POST /v1/invoices/:id/void` | Open invoice | Void Invoice | State and webhook test |
| `POST /v1/subscriptions` | Customer and one recurring price item | Subscription | SDK and official field-inventory test |
| `GET /v1/subscriptions` | `limit`, cursors, `customer`, and `status` | Subscription list | Operation test |
| `GET /v1/subscriptions/:id` | Existing subscription ID | Subscription | SDK object-read test |
| `POST /v1/subscriptions/:id` | Price, `metadata`, and end-of-period cancellation | Updated Subscription | Operation test |
| `DELETE /v1/subscriptions/:id` | Existing subscription ID | Canceled Subscription | SDK and webhook test |

Do not assume that another Stripe parameter or state branch works.

## Payments and refunds

Prepared finance records include the complete invoice history. Each successful
source payment has one PaymentIntent, one charge, and, when linked to an invoice,
one invoice-payment record. Payment dates come from the source schedule. An
invoice's due date and its payment date can differ. Invoice `amount_paid` remains
the gross settlement amount; charge and refund records show returned funds.

| Method and path | Local behavior |
| --- | --- |
| `GET /v1/invoice_payments` | Paginated links, with invoice, status, and payment filters |
| `GET /v1/invoice_payments/:id` | Invoice, PaymentIntent, amount, currency, and payment date |
| `GET /v1/refunds` | Paginated refunds, with charge or PaymentIntent filters |
| `GET /v1/refunds/:id` | Refund amount, date, currency, status, charge, and PaymentIntent |
| `POST /v1/refunds` | Successful partial or full refund of a successful charge; use `charge` or `payment_intent`, with optional `amount` |

A refund cannot exceed the charge's remaining refundable amount. Seeded refunds
preserve their authored date and source ID. Normal refund creation emits
`refund.created`; loading the starting records emits no payment or refund events.
Reset restores the starting payments and refunds and removes later API changes.

One-time customers use `billing_mode: "one_time"` and a declared
`revenue_account`. They do not create monthly subscriptions or recurring prices.
A payment linked to an order and its invoice is counted once. Existing source
order status alone does not create a payment or invent its date.

The local transaction contract supports at most one invoice per payment.
Invoice overpayment, cross-invoice allocations, failed refunds, asynchronous
refund states, and disputes are **Not supported**. Tests are in
`emulators/emulate/src/overrides/stripe-transactions.test.mjs` and
`tests/image/coupling-finance-probes.test.mjs`.

## State, events, reset, Workbench, and proof

### External Stripe webhooks

WorldFixture sends Stripe snapshot events to an external HTTP or HTTPS receiver.
The POST body is a Stripe `Event` object. It includes `id`, `object: "event"`,
`api_version`, Unix `created` time, `data.object`, `livemode: false`,
`pending_webhooks`, `request`, and `type`. API writes supply a `req_` request ID
and the supplied `Idempotency-Key`. The same request ID is in the API response.
Supported update events include `data.previous_attributes`. Nested objects contain
the changed fields. A changed array contains the complete previous array.

Each endpoint has a `whsec_` signing secret. The `Stripe-Signature` header uses
HMAC-SHA256 over the timestamp, a period, and the exact JSON body. The official
Stripe SDK verifies the received bytes. The body does not use Connector v1.

Use the Stripe SDK to create a receiver:

```js
const endpoint = await stripe.webhookEndpoints.create({
  url: "http://host.docker.internal:3000/webhooks/stripe",
  enabled_events: ["invoice.paid", "customer.subscription.updated"],
});
// Keep endpoint.secret. Verify the raw received body before JSON parsing.
const event = stripe.webhooks.constructEvent(rawBody, signature, endpoint.secret);
```

The receiver address must be reachable from the WorldFixture container. Local
HTTP is permitted for tests. Stripe production webhook receivers use HTTPS.

| Method and path | Supported behavior |
| --- | --- |
| `POST /v1/webhook_endpoints` | URL, event filter, description, metadata; returns the signing secret once |
| `GET /v1/webhook_endpoints` | Endpoint list with limit and cursors; omits secrets |
| `GET /v1/webhook_endpoints/:id` | Endpoint status and configuration; omits the secret |
| `POST /v1/webhook_endpoints/:id` | Change URL, event filter, description, metadata, or `disabled`; metadata merges, empty values remove keys, and empty metadata removes all keys |
| `DELETE /v1/webhook_endpoints/:id` | Delete the endpoint and stop later attempts |
| `GET /v1/events` | Event list with `type` (including `*`), `types`, `delivery_success`, `created[gt/gte/lt/lte]`, limit, and cursors |
| `GET /v1/events/:id` | Stored snapshot and current `pending_webhooks` count |

Seed configuration also accepts `stripe.webhooks` entries with `url`, `events`
(or `enabled_events`), and an optional `secret` and `id`. If the secret is absent,
WorldFixture generates it. Use endpoint creation to obtain a generated secret.
Only API version `2026-08-26.dahlia` is supported. An absent endpoint API version
uses this version. A request for another version is rejected.
The endpoint update API cannot change `api_version`. Event filters accept the
event names in the pinned official Stripe schema. A valid event name does not
mean that WorldFixture can generate that event.

Webhook delivery does not hold the API write response open. A `2xx` response
completes delivery. A timeout, network error, redirect, or other status causes
up to two more attempts. Each attempt signs the unchanged event body with the
current timestamp. Redirects are not followed. Local retry delays are 60 and
120 seconds. These delays are a test schedule; they do not reproduce Stripe's
production retry schedule. Delivery order is not guaranteed. Reset and stop
cancel attempts that are still in progress. Endpoint and event records use the
provider store.

Existing customer, PaymentIntent, product, price, Checkout Session, billing,
and refund mutations supply event snapshots. Invoice item creation and deletion,
draft invoice deletion, and charge refunds also send their matching events.
PaymentIntent and invoice snapshots include the local transaction fields. Charge
snapshots include the fields required by the pinned schema for the local captured
payment branch. An out-of-band invoice payment sends `invoice.paid`; it does not
send `invoice.payment_succeeded`.
This does not implement all Stripe event types. Connect, v2 thin events,
cross-version object conversion, production retry timing, and durable retry
recovery after a process restart are not supported. The resource fields remain
limited to the API coverage described on this page.

Product snapshots include empty image and marketing-feature lists and the stored
update time. Prices use the supported `per_unit` branch. Checkout snapshots use
the local card-only branch, with no tax, shipping options, or custom controls.
Their default `expires_at` is 24 hours after creation. Custom expiry settings and
automatic expiry events are not supported. These fields apply to event
snapshots; the underlying emulate.dev resource responses remain partial.

Known remaining differences: Related lifecycle events, including all invoice
changes and subscription-generated invoice/payment events, are incomplete.
The Events API does not enforce Stripe's 30-day retention period. Endpoint limits,
all parameter errors, selection-required event generation, secret rotation,
Stripe CLI resend, and production retry behavior are not reproduced.

The contract follows the official [Event object](https://docs.stripe.com/api/events/object),
[webhook endpoint API](https://docs.stripe.com/api/webhook_endpoints/create), and
[webhook signature guide](https://docs.stripe.com/webhooks/signature).
Event filters follow the official
[Events list API](https://docs.stripe.com/api/events/list). Supported event names are described in the official [event types](https://docs.stripe.com/api/events/types).

Provider writes change the store that API reads and the Workbench use. Invoice
payment also creates local PaymentIntent and charge records. Reset restores the
prepared starting state. Stop does not preserve later writes.

Billing mutations can send:

- `invoice.created`, `invoice.updated`, `invoice.finalized`
- `payment_intent.succeeded`, `charge.succeeded`
- `invoice.paid`, `invoice.payment_succeeded`, `invoice.voided`
- `customer.subscription.created`, `customer.subscription.updated`,
  `customer.subscription.deleted`

Tests prove event names, order, object state, and the shared mutation path. The
Workbench ledger observes provider events. It is not a separate provider store.

WorldFixture billing proof is
`emulators/emulate/src/overrides/stripe-billing.test.mjs`. The field inventory
is `emulators/emulate/contracts/stripe/billing-2026-08-26.contract.json`.
Official sources are the [Stripe OpenAPI document](https://github.com/stripe/openapi),
[Invoice API](https://docs.stripe.com/api/invoices),
[Invoice Item API](https://docs.stripe.com/api/invoiceitems), and
[Subscription API](https://docs.stripe.com/api/subscriptions).
