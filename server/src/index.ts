import { PORT } from '../../protocol/index.ts';
import { createHttpApp } from './http.ts';
import { createStore } from './state.ts';
import { createStubAdapters, createStubGit } from './stubs.ts';

const store = createStore();
const git = createStubGit();
const adapters = createStubAdapters();
const app = createHttpApp({ store, git, adapters });

app.listen(PORT, '0.0.0.0', () => {
  console.log(`LoopSync listening on 0.0.0.0:${PORT}`);
});
