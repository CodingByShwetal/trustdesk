import { useCallback, useEffect, useState } from 'react';
import { api, describeError, type Role } from '../api';
import { ActionRow } from '../components/ActionRow';
import { GuardrailStrip, statusTone } from '../components/GuardrailStrip';
import type { DraftResult, PolicyFacts, Recommended, TicketDetail, TicketSummary, ToolAction, Trace, TriageResult } from '../types';

type DraftView = {
  body: string;
  citations: string[];
  runId: string;
  outcome?: DraftResult['guardrail_outcome'];
  shouldEscalate?: boolean;
  recommended: Recommended[];
  blocked: DraftResult['blocked_actions'];
};

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Rebuilds the draft panel from a stored draft and its trace (for tickets drafted earlier). */
function draftFromTrace(d: TicketDetail['drafts'][number], trace: Trace): DraftView {
  const calls = trace.tool_calls as Array<Record<string, unknown>>;
  return {
    body: d.body,
    citations: d.citations,
    runId: trace.run_id,
    outcome: trace.status === 'blocked' ? 'fallback' : trace.guardrail_results.some((g) => g.stage === 'output' && g.result === 'repaired') ? 'repaired' : 'passed',
    shouldEscalate: trace.status === 'escalated' || trace.status === 'blocked',
    recommended: calls.filter((c) => c.type === 'recommended') as unknown as Recommended[],
    blocked: calls.filter((c) => c.type === 'blocked') as unknown as DraftResult['blocked_actions'],
  };
}

export function Desk({ role }: { role: Role }) {
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [facts, setFacts] = useState<PolicyFacts | null>(null);
  const [triage, setTriage] = useState<TriageResult | null>(null);
  const [draft, setDraft] = useState<DraftView | null>(null);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadQueue = useCallback(async () => {
    const { tickets: t } = await api<{ tickets: TicketSummary[] }>('/tickets');
    setTickets(t);
    setSelected((cur) => cur ?? t[0]?.ticket_id ?? null);
  }, []);

  const loadTrace = useCallback(async (runId: string) => {
    setTrace(await api<Trace>(`/agent-runs/${runId}`));
  }, []);

  const loadTicket = useCallback(
    async (id: string) => {
      setError(null);
      const [d, f] = await Promise.all([api<TicketDetail>(`/tickets/${id}`), api<PolicyFacts>(`/tickets/${id}/policy-facts`)]);
      setDetail(d);
      setFacts(f);
      setTriage(d.triage ? { ...d.triage, ticket_id: id, guardrail_flags: [], policy_rules_applied: [] } : null);
      const latest = d.drafts[0];
      if (latest?.run_id) {
        const t = await api<Trace>(`/agent-runs/${latest.run_id}`);
        setDraft(draftFromTrace(latest, t));
        setTrace(t);
      } else {
        setDraft(null);
        setTrace(d.runs[0] ? await api<Trace>(`/agent-runs/${d.runs[0].run_id}`) : null);
      }
    },
    [],
  );

  useEffect(() => {
    loadQueue().catch((e) => setError(describeError(e)));
  }, [loadQueue]);

  useEffect(() => {
    if (selected) loadTicket(selected).catch((e) => setError(describeError(e)));
  }, [selected, loadTicket]);

  async function run<T>(label: string, fn: () => Promise<T>) {
    setBusy(label);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(describeError(e));
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  const doTriage = () =>
    run('triage', async () => {
      const r = await api<TriageResult>(`/tickets/${selected}/triage`, { method: 'POST' });
      setTriage(r);
      await loadTrace(r.run_id);
      await Promise.all([loadQueue(), refreshDetail()]);
    });

  const doDraft = () =>
    run('draft', async () => {
      const r = await api<DraftResult>(`/tickets/${selected}/draft-reply`, { method: 'POST' });
      setDraft({
        body: r.body,
        citations: r.citations,
        runId: r.run_id,
        outcome: r.guardrail_outcome,
        shouldEscalate: r.should_escalate,
        recommended: r.recommended_actions,
        blocked: r.blocked_actions,
      });
      await loadTrace(r.run_id);
      await Promise.all([loadQueue(), refreshDetail()]);
    });

  async function refreshDetail() {
    if (!selected) return;
    const d = await api<TicketDetail>(`/tickets/${selected}`);
    setDetail(d);
    if (d.triage) setTriage((t) => (t && t.run_id === d.triage!.run_id ? t : { ...d.triage!, ticket_id: d.ticket_id, guardrail_flags: [], policy_rules_applied: [] }));
  }

  const requestAction = (a: Recommended) =>
    run(`request-${a.tool_name}`, async () => {
      await api<ToolAction>('/tool-actions', { method: 'POST', body: { ticket_id: selected, tool_name: a.tool_name, payload: a.payload, run_id: draft?.runId } });
      await refreshDetail();
    });

  const tone = draft?.outcome === 'fallback' ? 'blocked' : draft?.shouldEscalate ? 'human' : '';
  const requestedKeys = new Set(detail?.tool_actions.map((a) => a.idempotency_key));

  return (
    <div className="desk">
      <aside className="queue" aria-label="Ticket queue">
        <h2>Open tickets ({tickets.length})</h2>
        {tickets.map((t) => (
          <button key={t.ticket_id} aria-current={t.ticket_id === selected} onClick={() => setSelected(t.ticket_id)}>
            <span className="subject">{t.subject}</span>
            <span className="meta">
              <span>{t.ticket_id}</span>
              <span>{t.customer_name}</span>
              <span className={`pill ${statusTone(t.status)}`}>{t.status.replace('_', ' ')}</span>
              {t.triage && <span className={`pill ${t.triage.priority === 'urgent' ? 'blocked' : ''}`}>{t.triage.priority}</span>}
            </span>
          </button>
        ))}
      </aside>

      <section className="case" aria-label="Ticket">
        {error && <p className="error">{error}</p>}
        {!detail ? (
          <p className="empty">Choose a ticket from the queue.</p>
        ) : (
          <>
            <div className="case-head">
              <h1>{detail.subject}</h1>
              <p className="faint">
                {detail.ticket_id} from {detail.customer.name} by {detail.channel}, received {fmtDate(detail.created_at)}
              </p>
            </div>

            <div className="section">
              <p className="letter">{detail.body}</p>
            </div>

            <div className="section context">
              <dl>
                <dt>Customer</dt>
                <dd>{detail.customer.name} ({detail.customer.tier})</dd>
                <dt>Identity</dt>
                <dd>{detail.customer.verified ? 'Verified' : <span className="pill human">Not verified</span>}</dd>
                <dt>Email</dt>
                <dd>{detail.customer.email}</dd>
              </dl>
              {detail.order ? (
                <dl>
                  <dt>Order</dt>
                  <dd>{detail.order.order_id} ({detail.order.status.replace('_', ' ')})</dd>
                  <dt>Items</dt>
                  <dd>{detail.order.items.map((i) => `${i.name}${i.final_sale ? ' (final sale)' : ''}`).join(', ')}</dd>
                  <dt>Delivered</dt>
                  <dd>{detail.order.delivered_at ?? 'Not yet'}</dd>
                  <dt>Total</dt>
                  <dd>{detail.order.currency} {detail.order.total.toLocaleString()}</dd>
                </dl>
              ) : (
                <p className="faint">No order linked.</p>
              )}
            </div>

            {facts && (
              <div className="section">
                <h2>Policy facts on {facts.reference_date}</h2>
                <p className="faint" style={{ marginBottom: 8 }}>Computed from the ticket date, not today. The AI receives these as trusted facts.</p>
                <ul className="facts">
                  {facts.summary.map((s) => (
                    <li key={s.text} className={s.text.startsWith('SAFETY') ? 'safety' : ''}>
                      <span>
                        {s.text} {s.doc_ids.map((d) => <span key={d} className="doc">{d}</span>)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="section row">
              <button className="btn secondary" onClick={doTriage} disabled={!!busy}>
                {busy === 'triage' ? 'Triaging' : triage ? 'Triage again' : 'Run triage'}
              </button>
              <button className="btn" onClick={doDraft} disabled={!!busy}>
                {busy === 'draft' ? 'Drafting' : draft ? 'Draft again' : 'Generate draft'}
              </button>
            </div>

            {triage && (
              <div className="section">
                <h2>Triage</h2>
                <div className="decision">
                  <span className="k">Category</span>
                  <span className="k">Priority</span>
                  <span className="k">Sentiment</span>
                  <span className="k">Human needed</span>
                  <span className="v">{triage.category.replace('_', ' ')}</span>
                  <span className="v">{triage.priority}</span>
                  <span className="v">{triage.sentiment}</span>
                  <span className="v" style={{ color: triage.should_escalate ? 'var(--human)' : undefined }}>{triage.should_escalate ? 'Yes, escalate' : 'No'}</span>
                </div>
                <p className="muted" style={{ marginTop: 8, maxWidth: '75ch' }}>{triage.reason_summary}</p>
                {triage.policy_rules_applied.length > 0 && (
                  <ul className="rules">
                    {triage.policy_rules_applied.map((r) => (
                      <li key={r.rule}>
                        Policy rule {r.rule}: {r.change} <span className="doc">{r.doc_id}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {draft && (
              <div className="section">
                <h2>Draft reply</h2>
                {trace?.run_id === draft.runId && <GuardrailStrip results={trace.guardrail_results} />}
                {draft.outcome === 'fallback' && (
                  <p className="faint" style={{ color: 'var(--blocked)', marginBottom: 8 }}>
                    The model's draft failed safety checks, so it was replaced with a safe escalation reply.
                  </p>
                )}
                <p className={`letter draft ${tone}`}>{draft.body}</p>
                <p className="row" style={{ marginTop: 8 }}>
                  <span className="faint">Cites</span>
                  {draft.citations.length ? draft.citations.map((c) => <span key={c} className="doc">{c}</span>) : <span className="faint">nothing</span>}
                </p>

                <div className="actions">
                  {draft.recommended.map((a) => {
                    const done = requestedKeys.has(String(a.payload.idempotency_key));
                    return (
                      <div key={a.tool_name} className="action">
                        <div>
                          <span className="name">{a.tool_name}</span>{' '}
                          <span className={`pill ${a.requires_human_approval ? 'human' : 'good'}`}>
                            {a.requires_human_approval ? 'Needs approval' : 'Low risk'}
                          </span>
                        </div>
                        <button className="btn small secondary" disabled={!!busy || done} onClick={() => requestAction(a)}>
                          {done ? 'Requested' : 'Request action'}
                        </button>
                        <div className="why">{a.reason}</div>
                      </div>
                    );
                  })}
                  {draft.blocked.map((b) => (
                    <div key={b.tool_name} className="action blocked">
                      <div>
                        <span className="name">{b.tool_name}</span> <span className="pill blocked">Blocked</span>
                      </div>
                      <span />
                      <div className="why">
                        {b.reason} {b.doc_id && <span className="doc">{b.doc_id}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </section>

      <aside className="rail" aria-label="Audit trail">
        <h2>Audit trail</h2>
        {detail && detail.runs.length > 0 && (
          <label className="faint" style={{ display: 'block', marginTop: 8 }}>
            AI run
            <select value={trace?.run_id ?? ''} onChange={(e) => loadTrace(e.target.value)} style={{ width: '100%', marginTop: 4 }}>
              {detail.runs.map((r) => (
                <option key={r.run_id} value={r.run_id}>
                  {r.run_type.replace('_', ' ')}, {r.status}, {new Date(r.created_at).toLocaleTimeString()}
                </option>
              ))}
            </select>
          </label>
        )}
        {!trace ? (
          <p className="faint" style={{ marginTop: 12 }}>No AI runs yet for this ticket.</p>
        ) : (
          <>
            <div className="card">
              <dl className="kv">
                <dt>Run</dt>
                <dd>{trace.run_id}</dd>
                <dt>Type</dt>
                <dd>{trace.run_type.replace('_', ' ')}</dd>
                <dt>Status</dt>
                <dd><span className={`pill ${statusTone(trace.status)}`}>{trace.status}</span></dd>
                <dt>Model</dt>
                <dd>{trace.model_name ?? 'n/a'}</dd>
                <dt>Prompt</dt>
                <dd>{trace.prompt_version}</dd>
                <dt>Time</dt>
                <dd>{trace.latency_ms} ms</dd>
                <dt>Tokens</dt>
                <dd>{trace.token_usage ? `${trace.token_usage.input} in, ${trace.token_usage.output} out` : 'n/a'}</dd>
              </dl>
            </div>
            <h3>Retrieved policies</h3>
            <p className="row">{trace.retrieved_doc_ids.length ? trace.retrieved_doc_ids.map((d) => <span key={d} className="doc">{d}</span>) : <span className="faint">none</span>}</p>
            <h3>Guardrails</h3>
            <ul className="steps">
              {trace.guardrail_results.map((g, i) => (
                <li key={i} className={g.result === 'blocked' ? 'is-error' : ''}>
                  <strong>{g.stage}</strong> {g.result}
                  {g.rules.length > 0 && <div className="faint">{g.rules.join(', ')}</div>}
                </li>
              ))}
            </ul>
            <h3>Steps</h3>
            <ul className="steps">
              {trace.steps.map((s, i) => (
                <li key={i} className={s.status === 'error' ? 'is-error' : ''}>
                  {s.name.replace(/_/g, ' ')} <span className="faint">{s.ms ? `${s.ms} ms` : ''}</span>
                </li>
              ))}
            </ul>
            {trace.error && <p className="error">{trace.error}</p>}
          </>
        )}

        <h3>Actions on this ticket</h3>
        {detail?.tool_actions.length ? (
          <div className="actions" style={{ marginTop: 0 }}>
            {detail.tool_actions.map((a) => (
              <ActionRow key={a.action_id} action={a} role={role} onChange={() => refreshDetail()} />
            ))}
          </div>
        ) : (
          <p className="faint">None requested yet. Request one from the draft.</p>
        )}
      </aside>
    </div>
  );
}
