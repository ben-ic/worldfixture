import { getMicrosoftStore } from "@emulators/microsoft";

const UPSTREAM_DEFAULT_EMAIL = "testuser@outlook.com";

// The Microsoft package inserts a demo user before it applies the verified
// world projection. A world with a declared identity must not show that extra
// account in the OAuth chooser.
export function removeInjectedMicrosoftDefault(store, config) {
  if (!Array.isArray(config?.users) || config.users.length === 0) return;

  const users = getMicrosoftStore(store).users;
  const defaultUser = users.findOneBy("email", UPSTREAM_DEFAULT_EMAIL);
  if (defaultUser) users.delete(defaultUser.id);
}
