import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT } from '../../protocol/index.ts';
import { createAdapters } from './adapters.ts';
import { createGitRuntime } from './git.ts';
import { createHttpApp, dashboardDefaults } from './http.ts';
import { createLedger, defaultLedgerPath } from './ledger.ts';
import { createStore } from './state.ts';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const fixtureDir = path.join(repoRoot, 'fixture');

const store = createStore(dashboardDefaults(repoRoot));
const git = createGitRuntime(fixtureDir);
const adapters = createAdapters();
const ledger = createLedger(defaultLedgerPath());
const app = createHttpApp({ store, git, adapters, ledger, repoRoot });

app.listen(PORT, '0.0.0.0', () => {
  console.log(`LoopSync listening on 0.0.0.0:${PORT}`);
  console.log(`Ledger ${ledger.path}`);
});
