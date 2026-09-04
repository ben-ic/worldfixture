# Stripe provider

WorldFixture composes `@emulators/stripe` 0.10.0 and adds only the billing
operations that the Workbench needs. Existing emulate.dev routes stay
unchanged. All routes use the same Stripe store, authentication middleware,
webhook dispatcher, accepted reset snapshot, and compiled world projection.

Contract date: 2026-09-04. Stripe API version: `2026-08-26.dahlia`. Official
sources are the [Stripe OpenAPI document](https://github.com/stripe/openapi),
the [Invoice API](https://docs.stripe.com/api/invoices), the
[Invoice Item API](https://docs.stripe.com/api/invoiceitems), and the
[Subscription API](https://docs.stripe.com/api/subscriptions). The pinned
client test uses `stripe` 22.6.1. The extracted response-field inventory is in
`emulators/emulate/contracts/stripe/billing-2026-08-26.contract.json`.

## Use

Use `STRIPE_BASE_URL` and `STRIPE_API_KEY` from `worldfixture env`. The key is a
test key. Applications must send it as Stripe bearer authentication and must
send normal Stripe form-encoded requests. The official Node SDK works when its
host points at `STRIPE_BASE_URL`.

The compiled world owns customers, products, prices, subscriptions, and
invoices. Provider writes change the same state that applications and the
Workbench read. Reset restores the accepted first state. A selected world does
not receive records from another world or from a Workbench-only store.

## Support map

The routes from emulate.dev 0.10.0 remain owned by the upstream package. These
include customers, payment methods, customer sessions, PaymentIntents,
charges, products, prices, Checkout Sessions, hosted checkout, and webhooks.
See the [emulate.dev Stripe support page](https://emulate.dev/docs/stripe).

| Operation | Status | Evidence |
| --- | --- | --- |
| `POST /v1/invoiceitems` | Partial | Official SDK call; amount or `pricing[price]`; customer, draft invoice, price, and integer checks |
| `GET /v1/invoiceitems` | Partial | List envelope, limit, cursor, customer, invoice, and pending filters |
| `GET /v1/invoiceitems/:id` | Supported | Operation and error tests |
| `DELETE /v1/invoiceitems/:id` | Supported | Draft-state transition test |
| `POST /v1/invoices` | Partial | Official SDK call; manual draft invoice branch |
| `GET /v1/invoices` | Partial | List envelope, limit, cursor, customer, and status filters |
| `GET /v1/invoices/:id` | Supported | Official response-field inventory test |
| `POST /v1/invoices/:id` | Partial | Draft description, due date, auto-advance, and metadata updates |
| `DELETE /v1/invoices/:id` | Supported | Draft-only delete behavior |
| `GET /v1/invoices/:id/lines` | Supported | Official line-item field inventory test |
| `POST /v1/invoices/:id/finalize` | Supported | Official SDK call, state transition, and webhook test |
| `POST /v1/invoices/:id/pay` | Partial | Test-mode successful payment and out-of-band branch |
| `POST /v1/invoices/:id/void` | Supported | Open-to-void state transition and webhook |
| `POST /v1/subscriptions` | Partial | One recurring price item and official response-field inventory |
| `GET /v1/subscriptions` | Partial | List envelope, limit, cursor, customer, and status filters |
| `GET /v1/subscriptions/:id` | Supported | Official SDK object read |
| `POST /v1/subscriptions/:id` | Partial | Price, metadata, and end-of-period cancellation fields |
| `DELETE /v1/subscriptions/:id` | Supported | Official SDK cancellation and webhook test |

`Supported` means that the implemented route branch has executable contract
evidence. `Partial` means that Stripe documents more request branches than this
profile implements. An unsupported parameter must not be used as proof that
the complete Stripe operation is compatible.

## State and events

Invoice creation, update, finalization, payment, and voiding use the shared
Stripe billing collections. Invoice payment also creates records in the
upstream PaymentIntent and charge collections. Subscription creation, update,
and cancellation use the shared subscription collection.

The supported mutations dispatch these Stripe events through the existing
Stripe webhook dispatcher:

- `invoice.created`
- `invoice.updated`
- `invoice.finalized`
- `payment_intent.succeeded`
- `charge.succeeded`
- `invoice.paid`
- `invoice.payment_succeeded`
- `invoice.voided`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

The dispatcher applies the upstream Stripe signature function. Tests prove the
event names, order, object state, and shared mutation path. The Workbench event
ledger is an observation after provider acceptance. It is not provider state.

## Known limits

This extension does not claim the complete Stripe Billing API. It does not
implement taxes, discounts, credit notes, quotes, meters, usage records,
subscription schedules, revisions, Connect branches, or all payment failure
states. The payment branch is deterministic and test-mode only. Hosted invoice
URLs and invoice PDFs are `null`.

Keep a route `Partial` until operation tests, the official schema, and the
official client prove each added branch. Do not replace an upstream emulate.dev
route unless the world contract requires a measured correction.
