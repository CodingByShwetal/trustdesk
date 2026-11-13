import { inArray, sql } from 'drizzle-orm';
import type { DB } from '../../db/client.js';
import { kbChunks, kbDocuments } from '../../db/schema.js';

export type TicketCategory = 'shipping' | 'refund' | 'warranty' | 'billing' | 'account_security' | 'general';

/**
 * Policy routing table: the KB document that governs each triage category.
 * The anchor doc is always included in context for that category, so a strong
 * keyword match on another doc cannot crowd out the governing policy.
 */
export const CATEGORY_ANCHOR_DOCS: Record<TicketCategory, string[]> = {
  refund: ['KB-REFUND-001'],
  shipping: ['KB-SHIPPING-001'],
  warranty: ['KB-WARRANTY-001'],
  billing: ['KB-BILLING-001'],
  account_security: ['KB-ACCOUNT-001'],
  general: [],
};

/** Added whenever a guardrail fires: it defines how to handle injection and exfiltration. */
export const SECURITY_PLAYBOOK_DOC = 'KB-SECURITY-001';

export type SearchHit = {
  chunk_id: string;
  doc_id: string;
  title: string;
  heading: string;
  snippet: string;
  content: string;
  score: number;
  trust_status: 'trusted' | 'quarantined';
};

type Row = {
  chunk_id: string;
  doc_id: string;
  title: string;
  heading: string;
  content: string;
  snippet: string;
  trust_status: 'trusted' | 'quarantined';
  rank: number;
};

/**
 * Full-text search over KB chunks. Terms are OR-ed (any match counts) and
 * ranked by ts_rank with heading matches weighted above body matches.
 * Scores are normalised so the best hit is 1.0.
 */
export async function searchKb(
  db: DB,
  query: string,
  opts: { limit?: number; includeQuarantined?: boolean } = {},
): Promise<SearchHit[]> {
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 50);
  const cleaned = query.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').trim();
  if (!cleaned) return [];

  // plainto_tsquery stems and drops stop words; swapping & for | turns AND into OR.
  const result = await db.execute<Row>(sql`
    WITH q AS (
      SELECT NULLIF(replace(plainto_tsquery('english', ${cleaned})::text, '&', '|'), '')::tsquery AS query
    )
    SELECT c.chunk_id, c.doc_id, d.title, c.heading, c.content, d.trust_status,
           ts_rank(c.tsv, q.query) AS rank,
           ts_headline('english', c.content, q.query, 'MaxWords=30, MinWords=12, StartSel=**, StopSel=**') AS snippet
    FROM kb_chunks c
    JOIN kb_documents d ON d.doc_id = c.doc_id, q
    WHERE q.query IS NOT NULL
      AND c.tsv @@ q.query
      AND (${opts.includeQuarantined ?? false} OR d.trust_status = 'trusted')
    ORDER BY rank DESC, c.chunk_id
    LIMIT ${limit}
  `);

  const top = result.rows[0]?.rank || 1;
  return result.rows.map((r) => ({
    chunk_id: r.chunk_id,
    doc_id: r.doc_id,
    title: r.title,
    heading: r.heading,
    snippet: r.snippet,
    content: r.content,
    score: Math.round((r.rank / top) * 1000) / 1000,
    trust_status: r.trust_status,
  }));
}

export type RetrievedContext = {
  /** Trusted chunks to show the model, anchors first. */
  chunks: Array<SearchHit & { reason: 'anchor' | 'security_playbook' | 'search' }>;
  /** Distinct doc ids in `chunks`; the only ids a draft may cite. */
  retrievedDocIds: string[];
  /** Quarantined docs that matched the query and were dropped (recorded in the trace). */
  droppedQuarantined: Array<{ doc_id: string; chunk_id: string; score: number }>;
  query: string;
};

/**
 * Builds the policy context for one ticket:
 *   1. every chunk of the category's anchor doc,
 *   2. the security playbook when a guardrail fired,
 *   3. top search hits from the ticket text, trusted docs only.
 * Quarantined matches are dropped but reported, so the trace shows the defence working.
 */
export async function retrieveForTicket(
  db: DB,
  input: { subject: string; body: string; category?: TicketCategory | null; guardrailFlagged?: boolean; searchLimit?: number },
): Promise<RetrievedContext> {
  const query = `${input.subject} ${input.body}${input.category ? ` ${input.category.replace('_', ' ')}` : ''}`;

  const anchorIds = [
    ...(input.category ? CATEGORY_ANCHOR_DOCS[input.category] : []),
    ...(input.guardrailFlagged ? [SECURITY_PLAYBOOK_DOC] : []),
  ];

  const anchorRows = anchorIds.length
    ? await db
        .select({
          chunkId: kbChunks.chunkId,
          docId: kbChunks.docId,
          heading: kbChunks.heading,
          content: kbChunks.content,
          ordinal: kbChunks.ordinal,
          title: kbDocuments.title,
          trustStatus: kbDocuments.trustStatus,
        })
        .from(kbChunks)
        .innerJoin(kbDocuments, sql`${kbDocuments.docId} = ${kbChunks.docId}`)
        .where(inArray(kbChunks.docId, anchorIds))
        .orderBy(kbChunks.docId, kbChunks.ordinal)
    : [];

  const chunks: RetrievedContext['chunks'] = [];
  for (const docId of anchorIds) {
    for (const r of anchorRows.filter((x) => x.docId === docId && x.trustStatus === 'trusted')) {
      chunks.push({
        chunk_id: r.chunkId,
        doc_id: r.docId,
        title: r.title,
        heading: r.heading,
        snippet: r.content.slice(0, 200),
        content: r.content,
        score: 1,
        trust_status: 'trusted',
        reason: docId === SECURITY_PLAYBOOK_DOC ? 'security_playbook' : 'anchor',
      });
    }
  }

  const hits = await searchKb(db, query, { limit: input.searchLimit ?? 6, includeQuarantined: true });
  const droppedQuarantined: RetrievedContext['droppedQuarantined'] = [];
  for (const hit of hits) {
    if (hit.trust_status === 'quarantined') {
      droppedQuarantined.push({ doc_id: hit.doc_id, chunk_id: hit.chunk_id, score: hit.score });
      continue;
    }
    if (!chunks.some((c) => c.chunk_id === hit.chunk_id)) chunks.push({ ...hit, reason: 'search' });
  }

  return {
    chunks,
    retrievedDocIds: [...new Set(chunks.map((c) => c.doc_id))],
    droppedQuarantined,
    query,
  };
}
