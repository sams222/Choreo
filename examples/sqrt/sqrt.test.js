import { test } from 'node:test';
import assert from 'node:assert/strict';
import { integerSqrt } from './sqrt.js';

test('integerSqrt(9) === 3', () => {
  assert.equal(integerSqrt(9), 3);
});
