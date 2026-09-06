// History and live progress do not need every saved provider response.
// Full evidence remains available through GET /api/runs/:id and exports.
export function runSummary(run) {
  return { ...run, summaryOnly: true, results: (run.results || []).map(({ evidence, ...result }) => result) };
}
