// Assemble the public site: the homepage at the root, the documentation under
// /docs, as one static tree with no server behind it.
//
// WHY THE DOCS ARE PUBLISHED TWICE, deliberately. The image already carries the
// built site and the Workbench serves it at `/docs`, which is the copy you read
// while a world is running and offline. This is the copy you read BEFORE you
// install anything -- to decide whether the product is worth installing at all.
// Requiring a Docker pull to answer "what does this do" loses the reader.
//
// The homepage is a Claude Design canvas document: one HTML file, a `support.js`
// runtime beside it, and an `uploads/` directory of images. It is rendered in
// the browser, so all three have to travel together and the entry file has to be
// named `index.html` rather than the name it is authored under.
//
// CLEAN URLS ARE THE HOST'S JOB. VitePress is configured with `cleanUrls`, so a
// link reads `/docs/providers/slack` while the file on disk is `slack.html`.
// Cloudflare Pages resolves that automatically. A plain static file server does
// not, and will 404 on every internal documentation link -- that is the host
// being wrong for this build, not the build being broken.

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = join(root, "site");
const homepage = join(root, "Homepage");
const docs = join(root, "docs/.vitepress/dist");

for (const [what, path] of [["the homepage", homepage], ["the built documentation", docs]]) {
  if (!existsSync(path)) {
    console.error(`missing ${what}: ${path}`);
    if (path === docs) console.error("run `npm --prefix docs ci && npm run docs:build` first");
    process.exit(1);
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

cpSync(join(homepage, "WorldFixture Homepage.dc.html"), join(out, "index.html"));
cpSync(join(homepage, "support.js"), join(out, "support.js"));
cpSync(join(homepage, "uploads"), join(out, "uploads"), { recursive: true });
cpSync(join(homepage, "og.png"), join(out, "og.png"));
// The tab icon, the home screen icon and the logo, which the homepage head
// references from the site root. The documentation carries its own copies
// under /docs/, because VitePress rewrites asset paths against its own base.
for (const file of ["favicon.svg", "favicon.ico", "favicon-192.png", "icon-512.png",
                    "apple-touch-icon.png", "logo.svg", "site.webmanifest"]) {
  cpSync(join(homepage, file), join(out, file));
}
cpSync(docs, join(out, "docs"), { recursive: true });

console.log(`site/ assembled: homepage at /, documentation at /docs/`);
console.log("preview:  npx wrangler pages dev site");
console.log("deploy:   npx wrangler pages deploy site");
