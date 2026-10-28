import { config } from './config.js';
import { buildApp } from './app.js';
import { db, closeDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { seedDatabase } from './db/seed.js';
import { failOrphanedRuns } from './modules/evals/service.js';

async function main() {
  await runMigrations();
  await failOrphanedRuns(db);
  if (config.SEED_ON_START) {
    const s = await seedDatabase(db);
    const quarantined = s.documents.filter((d) => d.trustStatus === 'quarantined').map((d) => d.docId);
    console.log(
      `Seed complete: ${s.tickets} tickets, ${s.documents.length} KB docs (quarantined: ${quarantined.join(', ') || 'none'})`,
    );
  }

  const app = await buildApp({ db, logger: config.NODE_ENV !== 'test' });
  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.PORT, host: config.HOST });
}

main().catch(async (err) => {
  console.error('Fatal startup error:', err);
  await closeDb().catch(() => {});
  process.exit(1);
});
