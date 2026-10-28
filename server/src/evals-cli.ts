/**
 * Runs data/eval_cases.jsonl through the real pipeline and writes a report.
 *   npm run eval                                  # provider from LLM_PROVIDER
 *   npm run eval -- --provider mock_compromised   # prove guardrails with a jailbroken model
 *   npm run eval -- --cases eval_005,eval_006 --delay-ms 4000
 */
import { parseArgs } from 'node:util';
import { config } from './config.js';
import { db, closeDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { seedDatabase } from './db/seed.js';
import { createProvider } from './modules/ai/index.js';
import { createEvalRun, executeEvalRun } from './modules/evals/service.js';

const { values } = parseArgs({
  options: {
    provider: { type: 'string' },
    cases: { type: 'string' },
    'delay-ms': { type: 'string' },
    out: { type: 'string' },
  },
});

const pct = (n: number) => `${(n * 100).toFixed(1)}%`.padStart(7);

async function main() {
  const provider = (values.provider ?? config.LLM_PROVIDER) as typeof config.LLM_PROVIDER;
  if (!['gemini', 'mock', 'mock_compromised'].includes(provider)) throw new Error(`Unknown provider '${provider}'`);
  const llm = createProvider({ ...config, LLM_PROVIDER: provider });

  await runMigrations();
  await seedDatabase(db);
  const run = await createEvalRun(db, llm.name);
  console.log(`Eval run ${run.evalRunId} with provider ${llm.name}\n`);

  const out = await executeEvalRun(db, llm, run.evalRunId, {
    caseIds: values.cases?.split(',').map((s) => s.trim()).filter(Boolean),
    delayMs: values['delay-ms'] ? Number(values['delay-ms']) : config.EVAL_DELAY_MS,
    reportsDir: values.out ?? config.REPORTS_DIR,
  });

  for (const r of out.results) {
    console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.case_id}  ${r.ticket_id}  ${r.predicted_category ?? '-'}/${r.predicted_priority ?? '-'}  escalate=${r.should_escalate}  ${r.passed ? '' : r.notes}`);
  }
  const m = out.metrics;
  console.log(`\nCategory accuracy        ${pct(m.category_accuracy)}`);
  console.log(`Priority accuracy        ${pct(m.priority_accuracy)}`);
  console.log(`Citation coverage        ${pct(m.citation_coverage)}`);
  console.log(`Unsafe action block rate ${pct(m.unsafe_action_block_rate)}`);
  console.log(`Allowed action recall    ${pct(m.allowed_action_recall)}`);
  console.log(`Escalation accuracy      ${pct(m.escalation_accuracy)}`);
  console.log(`Answer requirements      ${pct(m.answer_requirement_coverage)}`);
  console.log(`\nAdversarial: ${Object.entries(m.adversarial).map(([id, a]) => `${id} ${a.safe ? 'safe' : 'UNSAFE'}`).join(', ')}`);
  console.log(`${m.passed_cases}/${m.total_cases} cases passed. Report: ${out.reportPath}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closeDb);
