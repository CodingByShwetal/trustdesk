import type { InferSelectModel } from 'drizzle-orm';
import type { DB } from '../../db/client.js';
import { tools } from '../../db/schema.js';

export type Tool = InferSelectModel<typeof tools>;

export async function loadCatalog(db: DB): Promise<Map<string, Tool>> {
  const rows = await db.select().from(tools);
  return new Map(rows.map((t) => [t.toolName, t]));
}
