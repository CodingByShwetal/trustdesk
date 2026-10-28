import { useEffect, useState, type FormEvent } from 'react';
import { api, describeError } from '../api';
import { statusTone } from '../components/GuardrailStrip';
import type { KbDocument } from '../types';

type Hit = { chunk_id: string; doc_id: string; title: string; heading: string; snippet: string; score: number; trust_status: string };

/** Renders ts_headline output, where matches are wrapped in **double asterisks**. */
function Snippet({ text }: { text: string }) {
  return <>{text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>))}</>;
}

export function Knowledge() {
  const [docs, setDocs] = useState<KbDocument[]>([]);
  const [q, setQ] = useState('damaged item replacement');
  const [audit, setAudit] = useState(false);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ documents: KbDocument[] }>('/documents').then((r) => setDocs(r.documents)).catch((e) => setError(describeError(e)));
  }, []);

  async function search(e?: FormEvent) {
    e?.preventDefault();
    setError(null);
    try {
      const r = await api<{ results: Hit[] }>(`/documents/search?q=${encodeURIComponent(q)}&limit=8&include_quarantined=${audit}`);
      setHits(r.results);
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <div className="page">
      <header>
        <div>
          <h1>Knowledge base</h1>
          <p className="muted">
            Policies the AI may cite. Documents that try to instruct the AI are quarantined at import: kept for audit, never shown to the model, never citable.
          </p>
        </div>
      </header>
      {error && <p className="error">{error}</p>}
      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr><th>Document</th><th>Title</th><th>Audience</th><th>Status</th></tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.doc_id}>
                <td><span className="doc">{d.doc_id}</span></td>
                <td>{d.title}</td>
                <td>{d.audience}</td>
                <td>
                  <span className={`pill ${statusTone(d.trust_status)}`}>{d.trust_status}</span>
                  {d.quarantine_reason && <div className="faint" style={{ marginTop: 4, maxWidth: '60ch' }}>{d.quarantine_reason}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="section">
        <h2>Search</h2>
        <form className="row" onSubmit={search}>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search policies" style={{ flex: '1 1 320px' }} />
          <label className="row faint"><input type="checkbox" checked={audit} onChange={(e) => setAudit(e.target.checked)} /> Include quarantined (audit)</label>
          <button className="btn" type="submit">Search</button>
        </form>
        {hits && (
          <div className="actions">
            {hits.length === 0 && <p className="faint">No policy matches those words. Try fewer or different terms.</p>}
            {hits.map((h) => (
              <div key={h.chunk_id} className={`action ${h.trust_status === 'quarantined' ? 'blocked' : ''}`}>
                <div>
                  <span className="doc">{h.doc_id}</span> <span className="name">{h.heading}</span>
                  {h.trust_status === 'quarantined' && <> <span className="pill blocked">quarantined</span></>}
                </div>
                <span className="faint">score {h.score.toFixed(2)}</span>
                <div className="why"><Snippet text={h.snippet} /></div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
