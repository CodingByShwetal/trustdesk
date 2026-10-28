import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, closeDb } from './client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Works from src/ (tsx) and dist/ (compiled): migrations live in server/drizzle.
export const migrationsFolder = path.resolve(here, '../../drizzle');

export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runMigrations()
    .then(() => console.log('Migrations applied'))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(closeDb);
}
