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

Taxes, discounts, refunds, disputes, credit notes, quotes, meters, usage
records, subscription schedules, revisions, Connect branches, broad payment
failure states, hosted invoice pages, and invoice PDFs do not work. Complete
production authorization, idempotency, paging, rate limits, and errors also do
not work. These operations are **Not supported**. Production behavior is
**Not verified against the production provider**.

## Connect

Use `STRIPE_BASE_URL` and `STRIPE_TOKEN` from `worldfixture env`. Send the
token as bearer authentication. Send normal Stripe form-encoded bodies. Set the
Node SDK host to `STRIPE_BASE_URL`.

The local routes also accept anonymous requests. Stripe does not. Do not depend
on this local difference.

WorldFixture uses `@emulators/stripe` 0.10.0. Existing emulate.dev routes stay
unchanged. WorldFixture adds the billing routes below. All routes use one store.

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

## State, events, reset, Workbench, and proof

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
