// Applies pending PostgreSQL migrations (db/postgres/migrations/*.sql) and exits.
// The server does this itself on start; run it to migrate ahead of a deploy:
//   npm run pg:migrate        (reads DATABASE_URL from .env)
const { Pool } = require('pg');
const { migrate } = require('../../pg');

if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL (e.g. in .env) to the Postgres database to migrate.');
  process.exit(1);
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
migrate(pool, { log: console.log })
  .then((applied) => console.log(applied.length ? `Done: ${applied.length} migration(s) applied.` : 'Already up to date.'))
  .catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(() => pool.end());
