# Contract testing policy

The real provider API is the authority. WorldFixture does not treat a provider
name, a route registration, or a seed projection as proof of parity.

## Add support evidence

For each operation:

1. Pin the provider API version and verification date.
2. Save an official schema or a safe production recording when its license and
   data policy permit this.
3. Test required headers, authentication, request encoding, required fields,
   response fields, errors, state changes, reset, and emitted events.
4. Run the applicable official SDK against the local base URL and pin its exact
   tested version.
5. Add the test file to `docs/providers/support-matrix.json`.
6. Use one required support label. State production verification separately.

Production recordings are the strongest evidence. Remove credentials, personal
data, and tenant identifiers before a recording enters the repository. Store
its source, capture date, plan, client version, API version, and digest.

## Release checks

`npm run docs:check` checks internal Markdown links, provider page references,
allowed support labels, cited test files, and provider coverage against the
service manifest. `npm run docs:build` makes VitePress check website routes.

The provider test suite must pass before a support label becomes stronger.
Readiness tests stay narrow. They prove that a service can answer one diagnostic
request. They do not prove the other registered routes.
