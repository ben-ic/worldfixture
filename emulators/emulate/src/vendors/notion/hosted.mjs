import { createNotionDomain, normalizeId } from "./domain.mjs";

function escape(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function pageBody(markdown) {
  return String(markdown ?? "").split("\n").map((line) => {
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) return `<h${heading[1].length}>${escape(heading[2])}</h${heading[1].length}>`;
    if (line === "---") return "<hr>";
    if (line.startsWith("> ")) return `<blockquote>${escape(line.slice(2))}</blockquote>`;
    if (/^- \[[ xX]\] /.test(line)) return `<p class="todo">${line[3].toLowerCase() === "x" ? "☑" : "☐"} ${escape(line.slice(6))}</p>`;
    if (/^[-*] /.test(line)) return `<p class="list">• ${escape(line.slice(2))}</p>`;
    if (/^\d+\. /.test(line)) return `<p class="list">${escape(line)}</p>`;
    return line ? `<p>${escape(line)}</p>` : "<div class=\"space\"></div>";
  }).join("");
}

function document({ title, markdown, workspace }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · ${escape(workspace)}</title><style>
  :root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#fff;color:#37352f;font:16px/1.55 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}header{height:46px;display:flex;align-items:center;gap:10px;padding:0 16px;border-bottom:1px solid #eee;color:#787774;font-size:14px;position:sticky;top:0;background:#fffc;backdrop-filter:blur(10px)}header b{color:#37352f}.page{max-width:760px;margin:0 auto;padding:72px 48px 120px}.mark{width:24px;height:24px;border-radius:5px;background:#f1f1ef;display:grid;place-items:center;font-weight:700}h1{font-size:40px;line-height:1.2;margin:0 0 28px}h2{font-size:30px;margin:34px 0 12px}h3{font-size:24px;margin:28px 0 8px}h4{font-size:20px;margin:22px 0 6px}p{margin:4px 0;min-height:1.5em}.list,.todo{padding-left:1.5em}blockquote{border-left:3px solid #37352f;margin:12px 0;padding:2px 14px}hr{border:0;border-top:1px solid #e9e9e7;margin:24px 0}.space{height:12px}@media(max-width:640px){.page{padding:48px 24px 90px}h1{font-size:32px}}
  </style></head><body><header><span class="mark">N</span><b>${escape(workspace)}</b><span>/</span><span>${escape(title)}</span></header><main class="page">${pageBody(markdown)}</main></body></html>`;
}

export function registerHostedRoutes(app, store, baseUrl) {
  const domain = createNotionDomain(store, baseUrl);
  app.get("/notion/:id", (c) => {
    const actor = store.collection("notion_users").all()[0];
    const page = actor ? domain.markdownForPage(normalizeId(c.req.param("id")), actor) : null;
    if (!page?.page) return c.html("<!doctype html><title>Page not found</title><h1>Page not found</h1>", 404);
    return c.html(document({ title: page.title ?? "Untitled", markdown: page.markdown, workspace: domain.workspace().name ?? "Notion" }));
  });
}
