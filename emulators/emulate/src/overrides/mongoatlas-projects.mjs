import { getMongoAtlasStore } from "@emulators/mongoatlas";

const UPSTREAM_DEFAULT_PROJECT = "Project0";

// The upstream MongoDB Atlas plugin always seeds a `Project0`. Same defect as
// Google's, Microsoft's and Clerk's injected accounts: an application listing
// projects is handed one the world never declared, beside the one it did.
//
// Only the project is removed. A cluster or database belonging to it is
// upstream's too, but nothing in this world references them and deleting rows a
// world does not describe by guessing at their parentage is how content gets
// lost. If that changes, remove them by their own `group_id`.
export function removeInjectedAtlasDefault(store, config) {
  if (!Array.isArray(config?.projects) || config.projects.length === 0) return { removed: 0 };

  const atlas = getMongoAtlasStore(store);
  const injected = atlas.projects.all().filter((project) => project.name === UPSTREAM_DEFAULT_PROJECT);

  for (const project of injected) atlas.projects.delete(project.id);

  return { removed: injected.length };
}
