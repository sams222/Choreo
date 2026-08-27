import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { PORT } from '../../protocol/index.ts';
import { createAdapters } from './adapters.ts';
import { createGitRuntime } from './git.ts';
import { createHttpApp, dashboardDefaults } from './http.ts';
import { createLedger, defaultLedgerPath } from './ledger.ts';
import { createStore } from './state.ts';

const DEFAULT_PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

export interface StartChoreoOptions {
  packageRoot?: string;
  projectDir?: string;
  empty?: boolean;
  open?: boolean;
  port?: number;
  host?: string;
}

export function openBrowser(url: string): void {
  const platform = process.platform;
  const command =
    platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function listen(
  app: http.RequestListener,
  host: string,
  port: number,
): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    const onError = (err: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      server.close();
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export async function startChoreo(
  opts: StartChoreoOptions = {},
): Promise<http.Server> {
  const packageRoot = opts.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const projectDir = path.resolve(opts.projectDir ?? process.cwd());
  const empty = Boolean(opts.empty);
  const host = opts.host ?? '0.0.0.0';
  const port = opts.port ?? PORT;
  const fixtureDir = path.join(packageRoot, 'fixture');
  const sourceDir = empty ? '' : projectDir;

  const store = createStore(
    dashboardDefaults({
      sourceDir,
      title: empty ? '' : path.basename(projectDir),
    }),
  );
  const git = createGitRuntime(fixtureDir);
  const adapters = createAdapters();
  const ledger = createLedger(defaultLedgerPath(projectDir));
  const app = createHttpApp({
    store,
    git,
    adapters,
    ledger,
    repoRoot: packageRoot,
    projectDir,
  });

  try {
    const server = await listen(app, host, port);
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}`;
    console.log(`Choreo listening on ${url}`);
    console.log(empty ? 'Project (empty)' : `Project ${projectDir}`);
    console.log(`Ledger ${ledger.path}`);
    if (opts.open) {
      openBrowser(url);
    }
    return server;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      throw new Error(
        `port ${port} is already in use — stop the other process or pass --port`,
      );
    }
    throw err;
  }
}
