import { db } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDatabase, truncateAll } from '../src/db/seed.js';
import { buildApp } from '../src/app.js';

/** Fresh, fully seeded test database. */
export async function resetDb() {
  await runMigrations();
  await truncateAll(db);
  return seedDatabase(db);
}

export const tokens = {
  agent: 'agent-demo-token',
  manager: 'manager-demo-token',
  admin: 'admin-demo-token',
};

export const auth = (role: keyof typeof tokens) => ({ authorization: `Bearer ${tokens[role]}` });

export async function makeApp() {
  return buildApp({ db });
}

export { db };
