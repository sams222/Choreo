import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT } from '../../protocol/index.ts';
import { createAdapters } from './adapters.ts';
import { createGitRuntime } from './git.ts';
import { createHttpApp } from './http.ts';
import { createStore } from './state.ts';

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../fixture',
);

const store = createStore();
const git = createGitRuntime(fixtureDir);
const adapters = createAdapters();
const app = createHttpApp({ store, git, adapters });

app.listen(PORT, '0.0.0.0', () => {
  console.log(`LoopSync listening on 0.0.0.0:${PORT}`);
});
