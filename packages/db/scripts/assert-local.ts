import { assertLocalDatabase } from '../src/env-guard.js';

assertLocalDatabase(process.env.DATABASE_URL);
