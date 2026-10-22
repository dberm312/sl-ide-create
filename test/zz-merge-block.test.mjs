import { test } from 'node:test';
import assert from 'node:assert/strict';

test('SL-38: deliberately failing check (throwaway PR, never merge)', () => assert.fail('expected failure'));
