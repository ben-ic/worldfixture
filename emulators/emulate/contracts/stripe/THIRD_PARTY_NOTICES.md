# Third-party notices

The file in this directory is an interface description, not Stripe code. Nothing
here is a copy of Stripe's implementation, and the emulator does not link against
or embed any Stripe software. It is a derived subset of Stripe's published
OpenAPI description, vendored so that the billing contract tests assert against a
fixed, digest-pinned description of the real API rather than against whatever the
network returned that day.

| File | Source | API version | Retrieved | SHA-256 |
| --- | --- | --- | --- | --- |
| `billing-2026-08-26.contract.json` | Derived from Stripe's official OpenAPI description at https://github.com/stripe/openapi/blob/master/openapi/spec3.json | `2026-08-26.dahlia` | 2026-09-04 | `9a2d24d870f3ad66fcf403358a2ce824caf79f1b2f6fbe2e79cae04bb28efa0d` |

The upstream `stripe/openapi` repository is published by Stripe under the MIT
licence. This directory holds a reduced schema subset for contract testing, not
the specification in full.

Stripe is a trademark of Stripe, Inc. This project is not affiliated with,
endorsed by, or sponsored by Stripe.
