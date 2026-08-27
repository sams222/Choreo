/**
 * Integer square root: the largest integer r such that r * r <= n.
 * Intentionally wrong so Choreo has something to judge.
 */
export function integerSqrt(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError('n must be a non-negative integer');
  }
  return 0;
}
