import type {
  CLIAdapter,
  GitRuntime,
  ProviderType,
} from '../../protocol/index.ts';

function gitNotWired(): never {
  throw new Error('GitRuntime not wired');
}

function adapterNotWired(): never {
  throw new Error('CLIAdapter not wired');
}

export function createStubGit(): GitRuntime {
  return {
    createWorkspace: gitNotWired,
    runTests: gitNotWired,
    getDiff: gitNotWired,
    commitIfDirty: gitNotWired,
    resetAll: gitNotWired,
  };
}

function makeStubAdapter(provider: ProviderType): CLIAdapter {
  return {
    provider,
    run: async () => adapterNotWired(),
  };
}

export function createStubAdapters(): Record<ProviderType, CLIAdapter> {
  return {
    claude: makeStubAdapter('claude'),
    codex: makeStubAdapter('codex'),
  };
}
