export type OffsetPage<T> = { items: T[]; hasMore: boolean };

/**
 * Follow the provider's pagination contract instead of silently imposing a
 * fixture-count ceiling. A repeated non-empty page is the fail-closed guard
 * against a broken upstream cursor/offset implementation.
 */
export async function collectOffsetPages<T>(input: {
  pageSize: number;
  loadPage: (offset: number) => Promise<OffsetPage<T>>;
  signature: (items: readonly T[]) => string;
}) {
  const items: T[] = [];
  const seenPages = new Set<string>();
  let offset = 0;
  let pages = 0;

  while (true) {
    const page = await input.loadPage(offset);
    pages += 1;
    const signature = input.signature(page.items);
    if (signature && seenPages.has(signature)) return { items, pages, truncated: true, stopReason: 'repeated_page' as const };
    if (signature) seenPages.add(signature);
    items.push(...page.items);
    if (!page.items.length || !page.hasMore) return { items, pages, truncated: false, stopReason: 'complete' as const };
    offset += page.items.length;
  }
}
