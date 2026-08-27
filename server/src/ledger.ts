import fs from 'node:fs';
import path from 'node:path';

export interface LedgerEvent {
  ts: string;
  taskId: string;
  event: string;
  attempt?: number;
  step?: string;
  detail?: string;
}

export function createLedger(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return {
    path: filePath,
    append(event: Omit<LedgerEvent, 'ts'> & { ts?: string }): void {
      const row: LedgerEvent = {
        ...event,
        ts: event.ts ?? new Date().toISOString(),
      };
      fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`);
    },
  };
}

export type Ledger = ReturnType<typeof createLedger>;

export function defaultLedgerPath(root = process.cwd()): string {
  return path.resolve(root, '.choreo/ledger.jsonl');
}
