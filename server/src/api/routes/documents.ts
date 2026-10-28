import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/client.js';
import { kbDocuments } from '../../db/schema.js';
import { parseOrThrow } from '../../lib/validate.js';
import { ingestDocument } from '../../modules/knowledge/ingest.js';
import { searchKb } from '../../modules/knowledge/search.js';
import type { RequireRole } from '../auth.js';

const SearchQuery = z.object({
  q: z.string().trim().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(50).default(5),
  include_quarantined: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

const IngestBody = z.object({
  documents: z
    .array(
      z.object({
        doc_id: z.string().regex(/^[A-Z0-9-]+$/, 'doc_id must look like KB-REFUND-001').optional(),
        title: z.string().trim().min(1).max(200).optional(),
        content: z.string().min(1).max(200_000),
        source_path: z.string().min(1).max(500),
      }),
    )
    .min(1)
    .max(50),
});

export function documentRoutes(app: FastifyInstance, deps: { db: DB; requireRole: RequireRole }) {
  const { db, requireRole } = deps;

  app.get('/documents', { preHandler: requireRole('agent') }, async () => {
    const rows = await db.select().from(kbDocuments).orderBy(kbDocuments.docId);
    return {
      documents: rows.map((d) => ({
        doc_id: d.docId,
        title: d.title,
        audience: d.audience,
        version: d.version,
        source_path: d.sourcePath,
        trust_status: d.trustStatus,
        quarantine_reason: d.quarantineReason,
        checksum: d.checksum,
        ingested_at: d.ingestedAt.toISOString(),
      })),
    };
  });

  app.get('/documents/search', { preHandler: requireRole('agent') }, async (req) => {
    const { q, limit, include_quarantined } = parseOrThrow(SearchQuery, req.query);
    const hits = await searchKb(db, q, { limit, includeQuarantined: include_quarantined });
    return {
      query: q,
      results: hits.map(({ content: _content, ...hit }) => hit),
    };
  });

  app.post('/documents/ingest', { preHandler: requireRole('admin') }, async (req) => {
    const { documents } = parseOrThrow(IngestBody, req.body);
    const results = [];
    for (const doc of documents) {
      results.push(await ingestDocument(db, { content: doc.content, sourcePath: doc.source_path, docId: doc.doc_id, title: doc.title }));
    }
    return {
      ingested: results.length,
      document_ids: results.map((r) => r.docId),
      results: results.map((r) => ({
        doc_id: r.docId,
        trust_status: r.trustStatus,
        chunks: r.chunks,
        quarantine_reason: r.quarantineReason ?? null,
      })),
    };
  });
}
