import { getGitHubStore } from '@emulators/github';

// The pinned plugin has POST /orgs/:org/repos but omits its list route. Reuse
// each native detail read for its authorization and complete repository shape.
export function extendGitHubWorldApi(upstream) {
  return { ...upstream, register(app, store, ...args) {
    upstream.register(app, store, ...args);
    app.get('/orgs/:org/repos', async c => {
      const gh = getGitHubStore(store), org = gh.orgs.findOneBy('login', c.req.param('org'));
      if (!org) return c.json({ message: 'Not Found' }, 404);
      const page = Number(c.req.query('page') ?? 1), perPage = Number(c.req.query('per_page') ?? 30), type = c.req.query('type') ?? 'all';
      if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(perPage) || perPage < 1 || perPage > 100 || !['all', 'public', 'private', 'forks', 'sources'].includes(type)) return c.json({ message: 'Invalid pagination or repository type' }, 400);
      const candidates = gh.repos.all().filter(row => row.owner_type === 'Organization' && row.owner_id === org.id)
        .filter(row => type === 'public' ? !row.private : type === 'private' ? row.private : type === 'forks' ? row.fork : type === 'sources' ? !row.fork : true)
        .sort((a, b) => a.full_name.localeCompare(b.full_name));
      const visible = [];
      for (const row of candidates) {
        const response = await app.request(`/repos/${encodeURIComponent(org.login)}/${encodeURIComponent(row.name)}`, { headers: { authorization: c.req.header('authorization') ?? '' } });
        if ([401, 403, 404].includes(response.status)) continue;
        if (!response.ok) return c.json({ message: 'Repository read failed' }, response.status);
        visible.push(await response.json());
      }
      const offset = (page - 1) * perPage, links = [];
      const link = number => { const url = new URL(c.req.url); url.searchParams.set('page', String(number)); url.searchParams.set('per_page', String(perPage)); return url; };
      if (offset + perPage < visible.length) links.push(`<${link(page + 1)}>; rel="next"`);
      if (page > 1) links.push(`<${link(page - 1)}>; rel="prev"`);
      if (links.length) c.header('Link', links.join(', '));
      return c.json(visible.slice(offset, offset + perPage));
    });
  } };
}
