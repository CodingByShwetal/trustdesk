import { useEffect, useState } from 'react';
import { loadSession, setApiSession, type Session } from './api';
import { Login } from './pages/Login';
import { Desk } from './pages/Desk';
import { Approvals } from './pages/Approvals';
import { Knowledge } from './pages/Knowledge';
import { Evals } from './pages/Evals';

const PAGES = [
  { id: 'desk', label: 'Desk' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'evals', label: 'Evals' },
] as const;
type PageId = (typeof PAGES)[number]['id'];

function currentPage(): PageId {
  const h = window.location.hash.replace('#', '');
  return (PAGES.find((p) => p.id === h)?.id ?? 'desk') as PageId;
}

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession());
  const [page, setPage] = useState<PageId>(currentPage());

  useEffect(() => {
    const onHash = () => setPage(currentPage());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const signIn = (s: Session) => {
    setApiSession(s);
    setSession(s);
  };
  const signOut = () => {
    setApiSession(null);
    setSession(null);
  };

  if (!session) return <Login onSignIn={signIn} />;

  return (
    <>
      <header className="topbar">
        <div className="brand">
          TrustDesk<span>support operations</span>
        </div>
        <nav className="nav" aria-label="Main">
          {PAGES.map((p) => (
            <a key={p.id} href={`#${p.id}`} aria-current={page === p.id ? 'page' : undefined}>
              {p.label}
            </a>
          ))}
        </nav>
        <div className="who">
          <span>
            Signed in as {session.user_id} ({session.role})
          </span>
          <button type="button" onClick={signOut}>
            Switch role
          </button>
        </div>
      </header>
      <main className="main">
        {page === 'desk' && <Desk role={session.role} />}
        {page === 'approvals' && <Approvals role={session.role} />}
        {page === 'knowledge' && <Knowledge />}
        {page === 'evals' && <Evals role={session.role} />}
      </main>
    </>
  );
}
