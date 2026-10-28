import { useCallback, useEffect, useState } from 'react';
import { api, describeError, type Role } from '../api';
import { ActionRow } from '../components/ActionRow';
import type { ToolAction } from '../types';

const GROUPS: Array<{ status: string; title: string; empty: string }> = [
  { status: 'approval_required', title: 'Waiting for a decision', empty: 'Nothing is waiting for approval.' },
  { status: 'approved', title: 'Approved, not yet run', empty: 'No approved actions are waiting to run.' },
  { status: 'requested', title: 'Low-risk, ready to run', empty: 'No low-risk actions are waiting.' },
  { status: 'failed', title: 'Failed, can be retried', empty: 'No failed actions.' },
];

export function Approvals({ role }: { role: Role }) {
  const [actions, setActions] = useState<ToolAction[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setActions((await api<{ tool_actions: ToolAction[] }>('/tool-actions')).tool_actions);
    } catch (e) {
      setError(describeError(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const done = actions.filter((a) => a.status === 'executed' || a.status === 'rejected').slice(0, 10);

  return (
    <div className="page">
      <header>
        <div>
          <h1>Approvals</h1>
          <p className="muted">
            The AI can only recommend actions. Refunds, replacements, coupons and account locks run after a manager approves them, and each one runs once however many times it is clicked.
          </p>
        </div>
        <button className="btn secondary" onClick={load}>Refresh</button>
      </header>
      {error && <p className="error">{error}</p>}
      {role === 'agent' && <p className="faint" style={{ marginBottom: 16 }}>You are signed in as an agent: you can see the queue, and a manager decides.</p>}
      {GROUPS.map((g) => {
        const items = actions.filter((a) => a.status === g.status);
        // Only the decision queue is shown when empty; other empty groups would just be noise.
        if (!items.length && g.status !== 'approval_required') return null;
        return (
          <section key={g.status} className="section">
            <h2>{g.title} ({items.length})</h2>
            {items.length ? (
              <div className="actions">
                {items.map((a) => <ActionRow key={a.action_id} action={a} role={role} onChange={load} showTicket />)}
              </div>
            ) : (
              <p className="faint">{g.empty}</p>
            )}
          </section>
        );
      })}
      <section className="section">
        <h2>Recently finished</h2>
        {done.length ? (
          <div className="actions">{done.map((a) => <ActionRow key={a.action_id} action={a} role={role} onChange={load} showTicket />)}</div>
        ) : (
          <p className="faint">Finished and rejected actions appear here.</p>
        )}
      </section>
    </div>
  );
}
