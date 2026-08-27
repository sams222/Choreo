import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIndex } from './parse.js';

test('length', () => {
  assert.equal(parseIndex('abcde'), 5);
});
