// The analytics tags for worldfixture.com, in one place because two different
// builds put them in two different kinds of file: the homepage is copied HTML
// and the documentation is rendered by VitePress.
//
// THEY GO ON THE PUBLIC SITE AND NOWHERE ELSE. Three things would otherwise
// pick them up and must not:
//
//   - `docs:dev`, which is somebody editing a page on their own machine.
//   - The homepage source opened straight off disk while it is being designed.
//   - The documentation built INTO THE CONTAINER IMAGE. This is the one that
//     matters. `Dockerfile` builds `docs/` and the Workbench serves the result
//     at /docs while a world is running, offline, on a developer's own machine.
//     A tag baked in there would report every local page view from a machine
//     that only ever asked to read documentation about a local tool.
//
// So nothing is added by default. `site:build` opts in by setting
// WORLDFIXTURE_ANALYTICS=1, and it is the only thing that does.
export const WEBSITE_ID = "feea065b-26a2-4f2f-8b75-01b610274171";
const ORIGIN = "https://analytics.interactivecats.com";

const SCRIPTS = ["script.js"];

export function analyticsEnabled(env = process.env) {
  return env.WORLDFIXTURE_ANALYTICS === "1";
}

// For VitePress, whose `head` takes [tag, attributes] pairs.
export function analyticsHead(env = process.env) {
  if (!analyticsEnabled(env)) return [];
  return SCRIPTS.map((file) => [
    "script",
    { defer: "", src: `${ORIGIN}/${file}`, "data-website-id": WEBSITE_ID },
  ]);
}

// For the homepage, which is copied as HTML rather than rendered.
export function analyticsHtml(env = process.env) {
  if (!analyticsEnabled(env)) return "";
  return SCRIPTS
    .map((file) => `<script defer src="${ORIGIN}/${file}" data-website-id="${WEBSITE_ID}"></script>`)
    .join("\n");
}
