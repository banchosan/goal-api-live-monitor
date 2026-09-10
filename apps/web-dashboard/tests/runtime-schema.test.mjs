import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureRuntimeSchema } from '../db/schema.ts';

test('adopted schema skips an empty D1 batch', async () => {
  let batchCalls = 0;
  await ensureRuntimeSchema({
    batch() { batchCalls += 1; throw new Error('empty batch must not run'); },
    prepare() { throw new Error('prepare must not run'); },
  });
  assert.equal(batchCalls, 0);
});
