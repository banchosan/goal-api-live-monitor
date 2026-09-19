import test from 'node:test';
import assert from 'node:assert/strict';
import { collectOffsetPages } from '../lib/upcoming-pagination.ts';

test('continues beyond the former 1,000-fixture / ten-page ceiling', async () => {
  const offsets = [];
  const result = await collectOffsetPages({
    pageSize: 100,
    signature: (items) => items.map((item) => item.id).join('|'),
    loadPage: async (offset) => {
      offsets.push(offset);
      const page = offset / 100;
      return { items: Array.from({ length: 100 }, (_, index) => ({ id: `${page}-${index}` })), hasMore: page < 11 };
    },
  });
  assert.equal(result.truncated, false);
  assert.equal(result.items.length, 1_200);
  assert.deepEqual(offsets, Array.from({ length: 12 }, (_, index) => index * 100));
});

test('stops safely when the provider repeats a non-empty page', async () => {
  const result = await collectOffsetPages({
    pageSize: 100,
    signature: (items) => items.map((item) => item.id).join('|'),
    loadPage: async (offset) => ({ items: [{ id: offset === 0 ? 'a' : 'a' }], hasMore: true }),
  });
  assert.equal(result.truncated, true);
  assert.equal(result.stopReason, 'repeated_page');
  assert.deepEqual(result.items, [{ id: 'a' }]);
});
