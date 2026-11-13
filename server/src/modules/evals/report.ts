import type { CaseResult, EvalMetrics } from './runner.js';

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const mark = (b: boolean | null) => (b === null ? 'n/a' : b ? 'pass' : 'FAIL');

/** Markdown evaluation report: summary, adversarial call-outs, per-case table and details. */
export function renderReport(input: {
  evalRunId: string;
  provider: string;
  model: string | null;
  startedAt: Date;
  completedAt: Date;
  metrics: EvalMetrics;
  results: CaseResult[];
}): string {
  const { metrics: m, results } = input;
  const lines: string[] = [];
  lines.push(`# TrustDesk evaluation report`);
  lines.push('');
  lines.push(`Run \`${input.evalRunId}\` with provider \`${input.provider}\`${input.model ? ` (model \`${input.model}\`)` : ''}, ${input.startedAt.toISOString()} to ${input.completedAt.toISOString()}.`);
  lines.push('');
  lines.push(`**${m.passed_cases} of ${m.total_cases} cases passed every check.**${m.errors ? ` ${m.errors} case(s) errored.` : ''}`);
  lines.push('');
  lines.push('## Metrics');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Category accuracy | ${pct(m.category_accuracy)} |`);
  lines.push(`| Priority accuracy | ${pct(m.priority_accuracy)} |`);
  lines.push(`| Triage accuracy (category and priority) | ${pct(m.triage_accuracy)} |`);
  lines.push(`| Citation coverage | ${pct(m.citation_coverage)} |`);
  lines.push(`| Unsafe action block rate | ${pct(m.unsafe_action_block_rate)} |`);
  lines.push(`| Allowed action recall | ${pct(m.allowed_action_recall)} |`);
  lines.push(`| Escalation accuracy | ${pct(m.escalation_accuracy)} |`);
  lines.push(`| Answer requirement coverage | ${pct(m.answer_requirement_coverage)} |`);
  lines.push('');
  lines.push('## Adversarial cases');
  lines.push('');
  lines.push('| Case | Attack | Handled safely | All checks |');
  lines.push('| --- | --- | --- | --- |');
  for (const [id, a] of Object.entries(m.adversarial)) {
    lines.push(`| ${id} | ${a.description} | ${a.safe ? 'yes' : 'NO'} | ${mark(a.passed)} |`);
  }
  lines.push('');
  lines.push('## Per-case results');
  lines.push('');
  lines.push('| Case | Ticket | Category | Priority | Escalate | Citations | Unsafe blocked | Allowed recalled | Requirements | Result |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of results) {
    lines.push(
      `| ${r.case_id} | ${r.ticket_id} | ${r.predicted_category ?? 'error'} (${mark(r.checks.category)}) | ${r.predicted_priority ?? 'error'} (${mark(r.checks.priority)}) | ${r.should_escalate ?? 'error'} (${mark(r.checks.escalation)}) | ${mark(r.checks.citations)} | ${mark(r.checks.unsafe_actions_blocked)} | ${r.checks.allowed_actions_recalled}/${r.checks.allowed_actions_total} | ${r.checks.requirements_met}/${r.checks.requirements_total} | **${r.passed ? 'pass' : 'FAIL'}** |`,
    );
  }
  lines.push('');
  lines.push('## Case details');
  for (const r of results) {
    lines.push('');
    lines.push(`### ${r.case_id}: ${r.input}`);
    lines.push('');
    lines.push(`- Recommended: ${r.recommended_actions.join(', ') || 'none'}`);
    lines.push(`- Blocked: ${r.blocked_actions.map((b) => `${b.tool_name} (${b.rule})`).join(', ') || 'none'}`);
    lines.push(`- Citations: ${r.citations.join(', ') || 'none'}`);
    lines.push(`- Trace: triage \`${r.triage_run_id ?? 'n/a'}\`, draft \`${r.draft_run_id ?? 'n/a'}\``);
    for (const q of r.requirements) lines.push(`- Requirement "${q.requirement}": ${mark(q.met)}, ${q.note}`);
    lines.push(`- Notes: ${r.notes}`);
  }
  const failures = results.filter((r) => !r.passed);
  lines.push('');
  lines.push('## Failure modes in this run');
  lines.push('');
  if (!failures.length) lines.push('None: every case passed every check.');
  for (const r of failures) lines.push(`- ${r.case_id}: ${r.notes}`);
  lines.push('');
  return lines.join('\n');
}
