// Boot entry point for the StudyTrace AWARE server. Creates the schema, then
// starts the Express app from the factory. See appFactory.js for the routes.

import { initSchema } from './db.js';
import { createApp } from './appFactory.js';

const app = createApp();
const PORT = process.env.PORT || 3000;

initSchema()
  .then((databaseReady) => {
    app.listen(PORT, () => {
      const mode = databaseReady ? 'database ready' : 'setup mode: DATABASE_URL missing';
      console.log(`StudyTrace AWARE server listening on :${PORT} (${mode})`);
    });
  })
  .catch((err) => {
    console.error('FATAL: failed to initialize schema', err);
    process.exit(1);
  });
