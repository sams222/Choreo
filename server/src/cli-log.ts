const NOISE = [
  /reading additional input from stdin/i,
  /^openai codex\b/i,
  /^-+$/,
  /^workdir:/i,
  /^model:/i,
  /^provider:/i,
  /^approval:/i,
  /^sandbox:/i,
  /^reasoning /i,
  /^session id:/i,
  /^tokens used/i,
  /^\d{4,}$/,
  /^(user|codex|claude|exec)$/i,
  /^\/usr\/bin\/bash/,
  /succeeded in \d+ms:?$/i,
  /^you are the orchestration agent/i,
  /^you are an adversarial reviewer/i,
  /^title:/i,
  /^user task:/i,
  /^write a short plan/i,
  /^end with a line that is exactly/i,
  /^do not edit files/i,
  /^do not (run git|run tests|ask questions|change any files|run git commit)/i,
  /^read parse\.js/i,
  /^the tests already passed/i,
  /^if production code correctly/i,
  /^if the production code correctly/i,
  /^otherwise emit/i,
  /^diff:$/i,
  /^diff --git /i,
  /^index [0-9a-f]+\.\./i,
  /^--- [abciw\/]/i,
  /^\+\+\+ [abciw\/]/i,
  /^@@ /,
  /^ORCHESTRATOR PLAN:/i,
  /^Follow the plan/i,
  /^TEST OUTPUT:/i,
  /^REVIEW OUTPUT:/i,
  /^# Fixture homework/,
  /^Buggy on purpose/,
  /^Person [0-9]/,
  /^```/,
  /^cd fixture/,
  /^node --test/,
  /^import \{ test \} from 'node:test'/,
  /^import assert from/,
  /^test\('length'/,
  /^\{\s*$/,
  /^\s*"type": "module"/,
];

export function isCliNoise(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '') {
    return true;
  }
  return NOISE.some((pattern) => pattern.test(trimmed));
}

export function extractUsefulCliText(output: string, limit = 1200): string {
  const lines = output
    .split('\n')
    .map((line) => line.replace(/^\[[^\]]+\]\s?/, ''))
    .filter((line) => !isCliNoise(line));
  const unique: string[] = [];
  for (const line of lines) {
    if (unique[unique.length - 1] === line) {
      continue;
    }
    if (
      (line === 'PLAN_DONE' || line === 'REVIEW_OK' || line === 'REVIEW_REJECT') &&
      unique.includes(line)
    ) {
      continue;
    }
    unique.push(line);
  }
  const text = unique.join('\n').trim();
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit).trimEnd()}\n…`;
}
