# Troubleshooting

## A world does not start

Run:

```sh
npx worldfixture doctor
npx worldfixture status --verbose
```

`doctor` checks Node.js, Docker, the recorded instance, container state, ports,
the world artifact, and service readiness. It does not change state. Use the
repair command that it prints.

## A port is different from the documentation

This is expected. WorldFixture uses a preferred local port when it is free and
another free port when it is not. Run `npx worldfixture env` and use the current
binding.

## The Workbench is ready but a service is still loading

The Workbench starts before all selected services finish their seed work. The
top status and **Services** page show the current state. A yellow service is not
ready for an application request. Local Mail usually takes the most time.

## An official SDK calls the production provider

Set the SDK base URL or host option from the matching `*_BASE_URL` binding.
Setting only a token is not sufficient. See the provider page for the exact SDK
constructor option.

## An API call returns `401`

Use the token from the same run and person as the base URL. A token from another
run is not accepted. Run `npx worldfixture env` again after a new start.

## The Workbench does not show an API change

Refresh the provider page. If it still does not show the change, check that the
provider page states that it uses live provider data. Report the endpoint and
the Workbench page as a product defect. The Workbench must not have a separate
provider state.

## Reset did not remove database records

This is the specified behavior. Normal reset preserves PostgreSQL and MySQL
application data. See [Reset and persistence](../guides/reset-and-persistence.md).
