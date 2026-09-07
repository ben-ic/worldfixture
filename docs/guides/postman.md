# Test the APIs with Postman

WorldFixture creates a Postman collection for the world that is running. The
collection contains the current local URLs and synthetic credentials. It
includes:

- Every registered HTTP route for each selected provider.
- Every supported AWS action.
- Every operation in the world's OpenAPI document.
- Common S3 bucket and object requests.
- OAuth 2.0 requests for providers that have an active local OAuth client.

SMTP, IMAP, PostgreSQL, and MySQL are not HTTP APIs. They are not in the
collection.

## Download the collection

Start a world, then run:

```sh
npx worldfixture open
```

In **Overview**, select **Download Postman collection**. This is the safest
method because the Workbench uses the port for the active run.

You can also download the file directly from:

[http://127.0.0.1:4715/api/postman](http://127.0.0.1:4715/api/postman)

The Workbench normally uses port `4715`. If WorldFixture prints a different
Workbench port, replace `4715` in the link. Download the collection again after
you start a new run or switch worlds. Ports and credentials can change.

## Import and use it

Import the downloaded JSON file into Postman. Requests are grouped by provider.
The collection variables already contain the values for the active run.

Some write requests need fields that are specific to the operation. Add the
required body fields before you send these requests. See the matching
[provider page](../providers/index.md) for supported operations and limits.

## Test OAuth

Open a provider folder and select **OAuth 2.0 — get a user token**. In the
**Authorization** tab, select **Get New Access Token**. The generated request
uses the provider URL, client ID, client secret, scopes, and Postman callback
URL for the active run.

The default world registers Postman's browser callback. You do not need to add
it in Workbench. If you use a different OAuth callback for your application,
see [Declare OAuth clients](./worlds.md#declare-oauth-clients).
