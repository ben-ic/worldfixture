import assert from "node:assert/strict";
import test from "node:test";
import { reportMarkdown, summarizeReport } from "./coupling-report.mjs";

test("report groups repeated finding checks without claiming separate defects", () => {
  const summary = summarizeReport({ cases: [{ label: "world-a", checks: [
    { check: "record.one", finding: 7, status: "failed" },
    { check: "record.two", finding: 7, status: "failed" },
    { check: "coverage.future-api", status: "failed", failure_kind: "reader_gap" },
  ] }], checks: [] });
  assert.equal(summary.failed_checks, 3);
  assert.equal(summary.reader_gap_checks, 1);
  assert.deepEqual(summary.findings, [{ finding: 7, failed_checks: 2, worlds: ["world-a"] }]);
  assert.equal(summary.status, "running");
});

test("missing reader and missing capability are different report results", () => {
  const report = { status: "failed", finished_at: "complete", cases: [{ label: "a", checks: [
    { check: "world.boot", status: "failed", finding: 25 },
    { check: "declared-aws.listener", status: "failed", finding: 12 },
  ] }] };
  assert.equal(summarizeReport(report).reader_gap_checks, 0);
  const markdown = reportMarkdown(report);
  assert.match(markdown, /does not prove full coverage/);
  assert.match(markdown, /failed boots/);
  assert.doesNotMatch(markdown, /Phase 0 complete/);
});

test("summary preserves infrastructure errors and escapes table values", () => {
  const markdown = reportMarkdown({ cases: [{ label: "world|one", checks: [{ check: "reader", status: "failed", failure_kind: "reader_gap", detail: "Need A|B\nreader" }] }],
    checks: [{ check: "matrix.infrastructure", status: "failed", detail: "Docker unavailable" }] });
  assert.match(markdown, /world\\\|one/);
  assert.match(markdown, /Need A\\\|B reader/);
  assert.match(markdown, /Docker unavailable/);
});
