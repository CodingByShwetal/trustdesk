import { useState } from 'react';
import { api, describeError, type Role } from '../api';
import type { ToolAction } from '../types';
import { statusTone } from './GuardrailStrip';

const LABEL: Record<string, string> = {
  approval_required: 'Awaiting approval',
  requested: 'Ready to run',
  approved: 'Approved',
  rejected: 'Rejected',
  executed: 'Done',
  failed: 'Failed',
};

const isManager = (r: Role) => r === 'manager' || r === 'admin';

/** One tool action with the controls the signed-in role is allowed to use. */
export function ActionRow({ action, role, onChange, showTicket = false }: { action: ToolAction; role: Role; onChange: (a: ToolAction) => void; showTicket?: boolean }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const canDecide = action.status === 'approval_required' && isManager(role);
  const canExecute = action.requires_human_approval
    ? isManager(role) && (action.status === 'approved' || action.status === 'failed' || action.status === 'executed')
    : action.status === 'requested' || action.status === 'failed' || action.status === 'executed';

  async function call(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const updated = await api<ToolAction>(`/tool-actions/${action.action_id}/${path}`, { method: 'POST', body: body ?? {} });
      if (updated.idempotent_replay) setNote('Already done: returned the stored result, nothing ran twice.');
      onChange(updated);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const tone = statusTone(action.status);
  return (
    <div className="action">
      <div>
        <span className="name">{action.tool_name}</span>{' '}
        <span className={`pill ${tone}`}>{LABEL[action.status] ?? action.status}</span>{' '}
        {action.requires_human_approval && action.status === 'approval_required' && <span className="faint">needs manager approval</span>}
        {showTicket && <span className="faint"> on {action.ticket_id}</span>}
      </div>
      <div className="row">
        {canExecute && (
          <button className="btn small good" disabled={busy} onClick={() => call('execute')}>
            {action.status === 'executed' ? 'Run again' : action.status === 'failed' ? 'Retry' : 'Run action'}
          </button>
        )}
      </div>
      <div className="why">
        {String(action.payload.reason ?? '')}
        <div className="faint">Key {action.idempotency_key}</div>
        {action.result && (
          <div className="faint">
            Result:{' '}
            {Object.entries(action.result)
              .filter(([k]) => !k.startsWith('executed_'))
              .map(([k, v]) => `${k} ${String(v)}`)
              .join(', ')}
          </div>
        )}
        {action.error && <div className="faint" style={{ color: 'var(--blocked)' }}>Error: {action.error}</div>}
        {canDecide && (
          <div className="row" style={{ marginTop: 8 }}>
            <input
              type="text"
              placeholder="Reason for the audit log"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-label="Decision reason"
              style={{ flex: '1 1 220px' }}
            />
            <button className="btn small good" disabled={busy || reason.trim().length < 3} onClick={() => call('approve', { decision: 'approved', reason })}>
              Approve
            </button>
            <button className="btn small danger" disabled={busy || reason.trim().length < 3} onClick={() => call('approve', { decision: 'rejected', reason })}>
              Reject
            </button>
          </div>
        )}
        {action.status === 'approval_required' && !isManager(role) && <div className="faint">A manager must approve this before it can run.</div>}
        {note && <div className="faint" style={{ color: 'var(--good)' }}>{note}</div>}
        {error && <div className="error" style={{ marginTop: 6 }}>{error}</div>}
      </div>
    </div>
  );
}
