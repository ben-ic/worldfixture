// Keep test-reader work distinct from failed source/API assertions. A repeated
// per-record failure is evidence for a finding, not a new defect each time.
const failed = (checks = []) => checks.filter((check) => check.status === "failed");
const cell = (value) => String(value ?? "").replaceAll("|", "\\|").replace(/[\r\n]+/g, " ");

export function summarizeReport(report) {
  const cases = (report.cases ?? []).map((entry) => {
    const failures = failed(entry.checks);
    return { label: entry.label, identity: entry.identity, boot: entry.checks?.find((check) => check.check === "world.boot")?.status ?? "not attempted",
      checked: entry.checks?.length ?? 0, failed: failures.length, responses: entry.responses?.length ?? 0,
      reader_gaps: failures.filter((check) => check.failure_kind === "reader_gap")
        .map(({ check, detail }) => ({ check, detail })) };
  });
  const findings = new Map();
  for (const entry of report.cases ?? []) {
    for (const check of failed(entry.checks)) {
      if (!Number.isInteger(check.finding)) continue;
      if (!findings.has(check.finding)) findings.set(check.finding, { finding: check.finding, failed_checks: 0, worlds: new Set() });
      const finding = findings.get(check.finding);
      finding.failed_checks += 1;
      finding.worlds.add(entry.label);
    }
  }
  return { finished: Boolean(report.finished_at), status: report.status ?? "running", cases,
    failed_checks: cases.reduce((total, entry) => total + entry.failed, 0) + failed(report.checks).length,
    reader_gap_checks: cases.reduce((total, entry) => total + entry.reader_gaps.length, 0),
    findings: [...findings.values()].sort((a, b) => a.finding - b.finding).map((entry) => ({ ...entry, worlds: [...entry.worlds].sort() })),
    infrastructure: failed(report.checks).map(({ check, detail }) => ({ check, detail })) };
}

export function reportMarkdown(report) {
  const summary = summarizeReport(report);
  const lines = ["# Coupling matrix evidence", "", `Status: **${summary.status}**.`, "",
    "Failed checks include repeated record comparisons. They are not a count of separate defects. An incomplete reader is listed separately when the reader declares that gap.", "",
    `Image: \`${cell(report.image)}\`.`, `Image digest: \`${cell(report.image_id ?? "not available")}\`.`, "",
    "| Case | Boot | Checks | Failed | Reader gaps | API responses |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
    ...summary.cases.map((entry) => `| ${cell(entry.label)} | ${entry.boot} | ${entry.checked} | ${entry.failed} | ${entry.reader_gaps.length} | ${entry.responses} |`), "",
    `Regression seed: \`${cell(report.regression_seed)}\`. Fresh seed: \`${cell(report.fresh_seed)}\`.`, "",
    "## Incomplete readers", ""];
  const gaps = new Map();
  for (const entry of summary.cases) for (const gap of entry.reader_gaps) {
    const key = JSON.stringify([gap.check, gap.detail]);
    if (!gaps.has(key)) gaps.set(key, { ...gap, worlds: [] });
    gaps.get(key).worlds.push(entry.label);
  }
  if (gaps.size) {
    lines.push("| Check | Worlds | Remaining work |", "| --- | --- | --- |",
      ...[...gaps.values()].map((gap) => `| ${cell(gap.check)} | ${cell(gap.worlds.join(", "))} | ${cell(typeof gap.detail === "string" ? gap.detail : JSON.stringify(gap.detail))} |`));
  } else lines.push("No reader explicitly reported an unimplemented code path in the completed probes. This does not prove full coverage: failed boots, unavailable capabilities, and collection coverage failures remain in the full report.");
  lines.push("", "## Finding references", "", "These references group evidence. They do not close an audit finding.", "",
    "| Finding | Failed checks | Worlds |", "| --- | ---: | --- |",
    ...summary.findings.map((entry) => `| ${entry.finding} | ${entry.failed_checks} | ${cell(entry.worlds.join(", "))} |`));
  if (summary.infrastructure.length) lines.push("", "## Infrastructure failures", "",
    ...summary.infrastructure.map((entry) => `- ${cell(entry.check)}: ${cell(entry.detail)}`));
  lines.push("", "See [complete evidence](report.json) for source expectations, actual results, capability selection, and the API response inventory. Generated sources and sanitized logs remain beside this report.", "");
  return lines.join("\n");
}
