import { eq } from 'drizzle-orm';
import type { DB } from '../../db/client.js';
import { kbChunks, kbDocuments } from '../../db/schema.js';
import { detectInjection, KB_RULES } from '../guardrails/injection.js';
import { parseKbMarkdown } from './parser.js';
import { AppError } from '../../lib/errors.js';

export type IngestInput = { content: string; sourcePath: string; docId?: string; title?: string };
export type IngestResult = { docId: string; trustStatus: 'trusted' | 'quarantined'; chunks: number; quarantineReason?: string };

/**
 * Upserts a KB document and rebuilds its chunks in one transaction.
 * Documents containing instructions aimed at the AI are quarantined: kept for
 * audit and search, but never passed to the model or accepted as citations.
 */
export async function ingestDocument(db: DB, input: IngestInput): Promise<IngestResult> {
  let parsed: ReturnType<typeof parseKbMarkdown>;
  try {
    parsed = parseKbMarkdown(input.content);
  } catch (err) {
    throw new AppError('VALIDATION_ERROR', `Cannot parse document from ${input.sourcePath}: ${(err as Error).message}`);
  }
  if (input.docId && input.docId !== parsed.docId) {
    throw new AppError('VALIDATION_ERROR', `doc_id mismatch: request says ${input.docId}, document header says ${parsed.docId}`);
  }

  // Quoted strings are ignored so documents that cite attack examples stay trusted.
  const hits = detectInjection(parsed.content, { ignoreQuoted: true, rules: KB_RULES });
  const trustStatus = hits.length > 0 ? 'quarantined' : 'trusted';
  const quarantineReason = hits.length
    ? `Instructions aimed at the AI agent detected: ${hits.map((h) => `${h.rule} ("${h.match}")`).join('; ')}`
    : null;

  await db.transaction(async (tx) => {
    const values = {
      docId: parsed.docId,
      title: input.title ?? parsed.title,
      audience: parsed.audience,
      version: parsed.version,
      sourcePath: input.sourcePath,
      content: parsed.content,
      checksum: parsed.checksum,
      trustStatus,
      quarantineReason,
      ingestedAt: new Date(),
    };
    await tx.insert(kbDocuments).values(values).onConflictDoUpdate({ target: kbDocuments.docId, set: values });
    await tx.delete(kbChunks).where(eq(kbChunks.docId, parsed.docId));
    if (parsed.chunks.length) {
      await tx.insert(kbChunks).values(
        parsed.chunks.map((c) => ({
          chunkId: `${parsed.docId}#${c.ordinal}`,
          docId: parsed.docId,
          ordinal: c.ordinal,
          heading: c.heading,
          content: c.content,
        })),
      );
    }
  });

  return { docId: parsed.docId, trustStatus, chunks: parsed.chunks.length, ...(quarantineReason ? { quarantineReason } : {}) };
}
