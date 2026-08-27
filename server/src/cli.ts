import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT } from '../../protocol/index.ts';
import { startChoreo } from './boot.ts';

export interface CliOptions {
  projectDir: string;
  empty: boolean;
  open: boolean;
  port: number;
  host: string;
  help: boolean;
  version: boolean;
  error?: string;
}

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

export function readPackageVersion(root = PACKAGE_ROOT): string {
  try {
    const raw = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function parseCliArgs(
  argv: readonly string[],
  cwd = process.cwd(),
): CliOptions {
  const opts: CliOptions = {
    projectDir: path.resolve(cwd),
    empty: false,
    open: true,
    port: PORT,
    host: '0.0.0.0',
    help: false,
    version: false,
  };

  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
      continue;
    }
    if (arg === '-v' || arg === '--version') {
      opts.version = true;
      continue;
    }
    if (arg === '--empty') {
      opts.empty = true;
      continue;
    }
    if (arg === '--no-open') {
      opts.open = false;
      continue;
    }
    if (arg === '--port' || arg === '-p') {
      const value = argv[i + 1];
      const port = Number.parseInt(value ?? '', 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        opts.error = `${arg} needs a port number between 1 and 65535`;
        return opts;
      }
      opts.port = port;
      i += 1;
      continue;
    }
    if (arg === '--host') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) {
        opts.error = '--host needs a bind address';
        return opts;
      }
      opts.host = value;
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) {
      opts.error = `unknown flag: ${arg}`;
      return opts;
    }
    rest.push(arg);
  }

  if (rest.length > 1) {
    opts.error = 'pass at most one folder';
    return opts;
  }
  if (rest[0]) {
    opts.projectDir = path.resolve(cwd, rest[0]);
  }
  return opts;
}

export function helpText(version = readPackageVersion()): string {
  return `Choreo ${version} — local orchestration for coding CLIs

Usage:
  choreo [folder] [options]

Starts the dashboard and orchestrates Claude/Codex against the given folder
(default: the directory you launched the command in).

Options:
  --empty          Start with no folder (blank project)
  --no-open        Do not open the browser
  -p, --port       Port (default ${PORT})
  --host           Bind address (default 0.0.0.0)
  -h, --help       Show this help
  -v, --version    Show version
`;
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const opts = parseCliArgs(argv);
  if (opts.error) {
    console.error(`choreo: ${opts.error}`);
    process.exitCode = 1;
    return;
  }
  if (opts.help) {
    process.stdout.write(helpText());
    return;
  }
  if (opts.version) {
    console.log(readPackageVersion());
    return;
  }
  if (!opts.empty && !fs.existsSync(opts.projectDir)) {
    console.error(`choreo: folder does not exist: ${opts.projectDir}`);
    process.exitCode = 1;
    return;
  }
  if (
    !opts.empty &&
    fs.existsSync(opts.projectDir) &&
    !fs.statSync(opts.projectDir).isDirectory()
  ) {
    console.error(`choreo: not a directory: ${opts.projectDir}`);
    process.exitCode = 1;
    return;
  }

  try {
    await startChoreo({
      packageRoot: PACKAGE_ROOT,
      projectDir: opts.projectDir,
      empty: opts.empty,
      open: opts.open,
      port: opts.port,
      host: opts.host,
    });
  } catch (err) {
    console.error(`choreo: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  void runCli();
}
