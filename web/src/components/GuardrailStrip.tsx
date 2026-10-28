import type { GuardrailResult } from '../types';

const STAGES: Array<{ stage: string; label: string }> = [
  { stage: 'input', label: 'Customer message' },
  { stage: 'retrieval', label: 'Policy retrieval' },
  { stage: 'output', label: 'Draft check' },
  { stage: 'tools', label: 'Action gate' },
];

const WORDS: Record<string, string> = {
  passed: 'Clear',
  flagged: 'Flagged',
  repaired: 'Repaired',
  blocked: 'Blocked',
};

/** One cell per guardrail stage, coloured by outcome: the at-a-glance answer to "what did the safety layers do?" */
export function GuardrailStrip({ results }: { results: GuardrailResult[] }) {
  return (
    <div className="strip" role="list" aria-label="Guardrail results by stage">
      {STAGES.map(({ stage, label }) => {
        // Later entries for a stage (e.g. output after a repair) reflect the final state.
        const r = [...results].reverse().find((g) => g.stage === stage);
        const result = r?.result ?? 'passed';
        return (
          <div key={stage} className={result} role="listitem">
            <div className="stage">{label}</div>
            <div className="result">{r ? WORDS[result] ?? result : 'Not run'}</div>
            <div className="why">{r?.rules.length ? r.rules.join(', ') : ' '}</div>
          </div>
        );
      })}
    </div>
  );
}

export function statusTone(status: string): 'good' | 'human' | 'blocked' | '' {
  if (['executed', 'completed', 'draft_ready', 'trusted', 'approved', 'triaged'].includes(status)) return 'good';
  if (['escalated', 'approval_required', 'requested', 'running', 'queued'].includes(status)) return 'human';
  if (['blocked', 'rejected', 'failed', 'quarantined'].includes(status)) return 'blocked';
  return '';
}
