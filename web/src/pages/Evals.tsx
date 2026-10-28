import { useCallback, useEffect, useState } from 'react';
import { api, describeError, type Role } from '../api';
import { statusTone } from '../components/GuardrailStrip';
import type { EvalRun } from '../types';

const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;

const METRICS: Array<{ key: keyof NonNullable<EvalRun['metrics']>; label: string }> = [
  { key: 'category_accuracy', label: 'Category accuracy' },
  { key: 'priority_accuracy', label: 'Priority accuracy' },
  { key: 'citation_coverage', label: 'Citation coverage' },
  { key: 'allowed_action_recall', label: 'Allowed action recall' },
  { key: 'escalation_accuracy', label: 'Escalation accuracy' },
  { key: 'answer_requirement_coverage', label: 'Answer requirements met' },
];

const PROVIDERS = [
  { value: 'configured', label: 'Configured model' },
  { value: 'mock', label: 'Heuristic mock (no API key)' },
  { value: 'mock_compromised', label: 'Compromised model (obeys every injection)' },
];

export function Evals({ role }: { role: Role }) {
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [current, setCurrent] = useState<EvalRun | null>(null);
  const [provider, setProvider] = useState('configured');
  const [error, setError] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    const r = await api<{ eval_runs: EvalRun[] }>('/eval-runs');
    setRuns(r.eval_runs);
    return r.eval_runs;
  }, []);

  const open = useCallback(async (id: string) => setCurrent(await api<EvalRun>(`/eval-runs/${id}`)), []);

  useEffect(() => {
    loadRuns()
      .then((r) => r[0] && open(r[0].eval_run_id))
      .catch((e) => setError(describeError(e)));
  }, [loadRuns, open]);

  // Poll while a run is in progress.
  useEffect(() => {
    if (!current || !['queued', 'running'].includes(current.status)) return;
    const t = setTimeout(() => {
      open(current.eval_run_id).then(() => loadRuns()).catch((e) => setError(describeError(e)));
    }, 1000);
    return () => clearTimeout(t);
  }, [current, open, loadRuns]);

  async function start() {
    setError(null);
    try {
      const r = await api<EvalRun>('/eval-runs', { method: 'POST', body: { provider } });
      await loadRuns();
      await open(r.eval_run_id);
    } catch (e) {
      setError(describeError(e));
    }
  }

  const m = current?.metrics;
  return (
    <div className="page">
      <header>
        <div>
          <h1>Evaluations</h1>
          <p className="muted">Runs the 8 provided eval cases through the same pipeline the desk uses and scores triage, citations, escalation, answer requirements and action safety.</p>
        </div>
        {role === 'admin' ? (
          <div className="row">
            <select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Model to evaluate">
              {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
            <button className="btn" onClick={start} disabled={!!current && ['queued', 'running'].includes(current.status)}>Run evaluation</button>
          </div>
        ) : (
          <p className="faint">Sign in as admin to start a run.</p>
        )}
      </header>
      {error && <p className="error">{error}</p>}

      {runs.length > 0 && (
        <label className="faint">
          Run{' '}
          <select value={current?.eval_run_id ?? ''} onChange={(e) => open(e.target.value)}>
            {runs.map((r) => (
              <option key={r.eval_run_id} value={r.eval_run_id}>
                {new Date(r.started_at).toLocaleString()}, {r.provider}, {r.status}
                {r.metrics ? `, ${r.metrics.passed_cases}/${r.metrics.total_cases} passed` : ''}
              </option>
            ))}
          </select>
        </label>
      )}

      {!current && <p className="empty">No evaluation runs yet.{role === 'admin' ? ' Run one to see the scores.' : ''}</p>}

      {current && (
        <section className="section">
          <p style={{ marginBottom: 14 }}>
            <span className={`pill ${statusTone(current.status)}`}>{current.status}</span>{' '}
            {current.provider}
            {m?.model ? `, ${m.model}` : ''}, {current.completed_cases} of {current.total_cases || 8} cases done
            {current.error && <span className="error" style={{ marginLeft: 8 }}>{current.error}</span>}
          </p>
          {m && (
            <>
              <div className="scores">
                <div className={`safety ${m.unsafe_action_block_rate < 1 ? 'bad' : ''}`}>
                  <div className="n">{pct(m.unsafe_action_block_rate)}</div>
                  <div className="l">Unsafe actions blocked</div>
                </div>
                <div>
                  <div className="n">{m.passed_cases}/{m.total_cases}</div>
                  <div className="l">Cases passing every check</div>
                </div>
                {METRICS.map((x) => (
                  <div key={x.key}>
                    <div className="n">{pct(m[x.key] as number)}</div>
                    <div className="l">{x.label}</div>
                  </div>
                ))}
              </div>
              <h2 style={{ fontSize: 'var(--t-md)', marginBottom: 8 }}>Adversarial cases</h2>
              <div className="actions" style={{ marginBottom: 24 }}>
                {Object.entries(m.adversarial).map(([id, a]) => (
                  <div key={id} className="action">
                    <div><span className="name">{id}</span> {a.description}</div>
                    <span className={`pill ${a.safe ? 'good' : 'blocked'}`}>{a.safe ? 'Handled safely' : 'Unsafe'}</span>
                  </div>
                ))}
              </div>
            </>
          )}
          {current.case_results && current.case_results.length > 0 && (
            <div className="table-wrap">
              <table className="grid">
                <thead>
                  <tr><th>Case</th><th>Predicted</th><th>Escalate</th><th>Recommended</th><th>Blocked</th><th>Result</th></tr>
                </thead>
                <tbody>
                  {current.case_results.map((r) => (
                    <tr key={r.case_id}>
                      <td><strong>{r.case_id}</strong><div className="faint">{r.input}</div></td>
                      <td>{r.predicted_category ?? 'error'}, {r.predicted_priority ?? '-'}</td>
                      <td>{String(r.should_escalate)}</td>
                      <td>{r.recommended_actions.join(', ') || 'none'}</td>
                      <td>{r.blocked_actions.map((b) => `${b.tool_name} (${b.rule})`).join(', ') || 'none'}</td>
                      <td>
                        <span className={`pill ${r.passed ? 'good' : 'blocked'}`}>{r.passed ? 'Pass' : 'Fail'}</span>
                        {!r.passed && <div className="faint" style={{ marginTop: 4 }}>{r.notes}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {current.status === 'completed' && (
            <p style={{ marginTop: 12 }}>
              <a href={`/api/eval-runs/${current.eval_run_id}/report`} onClick={(e) => { e.preventDefault(); downloadReport(current.eval_run_id); }}>
                Download the markdown report
              </a>
            </p>
          )}
        </section>
      )}
    </div>
  );
}

async function downloadReport(id: string) {
  const md = await api<string>(`/eval-runs/${id}/report`);
  const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `trustdesk-${id}.md` });
  a.click();
  URL.revokeObjectURL(url);
}
