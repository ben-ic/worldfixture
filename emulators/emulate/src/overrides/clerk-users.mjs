import { getClerkStore } from "@emulators/clerk";

const UPSTREAM_DEFAULT_EMAIL = "test@example.com";

// The upstream Clerk plugin always adds a convenience account. A declared user
// list is the world's people, so an extra "Test User" is a record the world
// never declared, handed to any application that enumerates users.
//
// This is the same defect `removeInjectedGoogleDefault` and
// `removeInjectedMicrosoftDefault` fix, found on a third vendor. Keep the default
// only for a fixture that declares no Clerk users at all.
//
// THIS COMMENT USED TO CLAIM the third vendor was found "by probing every vendor
// rather than the two anybody had looked at". It was not. Six more vendors were
// still serving one -- apple, github, linear, okta, slack and vercel, every one of
// them visible in a listing on a running fixture. `injected-accounts.mjs` is the
// sweep that claim described.
export function removeInjectedClerkDefault(store, config) {
  if (!Array.isArray(config?.users) || config.users.length === 0) return { removed: 0 };

  const clerk = getClerkStore(store);
  const addresses = clerk.emailAddresses.all().filter((row) => row.email_address === UPSTREAM_DEFAULT_EMAIL);

  // An address row's `user_id` is the Clerk id (`user_…`), and the collection
  // deletes by its own numeric `id`. Deleting by the wrong one silently removes
  // nothing, which is how the address would go and the nameless user would stay.
  const owners = clerk.users.all().filter((user) => addresses.some((row) => row.user_id === user.clerk_id));

  for (const address of addresses) clerk.emailAddresses.delete(address.id);
  for (const user of owners) clerk.users.delete(user.id);

  return { removed: owners.length };
}
