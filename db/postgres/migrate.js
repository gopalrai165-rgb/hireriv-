// Applies pending PostgreSQL migrations (db/postgres/migrations/*.sql) and exits.
// The server does this itself on start; run it to migrate ahead of a deploy:
//   npm run pg:migrate        (reads DATABASE_URL from .env)
// To undo the newest migration with its file in db/postgres/rollback/:
//   npm run pg:migrate -- --rollback
const { Pool } = require('pg');
const { migrate, rollback } = require('../../pg');

if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL (e.g. in .env) to the Postgres database to migrate.');
  process.exit(1);
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const run = process.argv.includes('--rollback')
  ? rollback(pool, { log: console.log }).then((v) => console.log(v ? `Done: ${v} rolled back.` : 'Nothing to roll back.'))
  : migrate(pool, { log: console.log }).then((applied) => console.log(applied.length ? `Done: ${applied.length} migration(s) applied.` : 'Already up to date.'));
run
  .catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(() => pool.end());
