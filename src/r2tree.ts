import type { BucketInfo, ListPage, ObjectInfo, TreeNode } from './types';

export interface Listing {
  prefixes: string[];
  objects: ObjectInfo[];
  nextToken: string | null;
  loading: boolean;
}

export function buildR2TreeRows(
  buckets: BucketInfo[] | null,
  listings: Map<string, Listing>,
  expanded: Set<string>
): TreeNode[] {
  const rows: TreeNode[] = [];
  const rootExpanded = expanded.has('root');

  rows.push({
    id: 'root',
    label: 'R2 Buckets',
    icon: 'bucket',
    depth: 0,
    expandable: true,
    expanded: rootExpanded,
    loading: false,
    data: null,
  });

  if (!rootExpanded || !buckets) {
    return rows;
  }

  function appendPrefixRows(bucket: string, parentPrefix: string, depth: number) {
    const listingKey = `${bucket}\0${parentPrefix}`;
    const listing = listings.get(listingKey);
    if (!listing) return;

    for (const prefix of listing.prefixes) {
      const prefixId = `p:${bucket}\0${prefix}`;
      const isExpanded = expanded.has(prefixId);
      const childListingKey = `${bucket}\0${prefix}`;
      const childListing = listings.get(childListingKey);
      const isLoading = childListing?.loading ?? false;
      const label = prefix.slice(parentPrefix.length);

      rows.push({
        id: prefixId,
        label,
        icon: 'folder',
        depth: depth + 1,
        expandable: true,
        expanded: isExpanded,
        loading: isLoading,
        data: { bucket, prefix },
      });

      if (isExpanded && childListing) {
        appendPrefixRows(bucket, prefix, depth + 1);
      }
    }

    if (listing.nextToken) {
      rows.push({
        id: `more:${bucket}\0${parentPrefix}`,
        label: '(more…)',
        icon: 'more',
        depth: depth + 1,
        expandable: false,
        expanded: false,
        loading: listing.loading,
        data: { bucket, prefix: parentPrefix, more: true },
      });
    }
  }

  for (const b of buckets) {
    const bucketId = `b:${b.name}`;
    const isBucketExpanded = expanded.has(bucketId);
    const rootListingKey = `${b.name}\0`;
    const rootListing = listings.get(rootListingKey);
    const isLoading = rootListing?.loading ?? false;

    rows.push({
      id: bucketId,
      label: b.name,
      icon: 'bucket',
      depth: 1,
      expandable: true,
      expanded: isBucketExpanded,
      loading: isLoading,
      data: { bucket: b.name, prefix: '' },
    });

    if (isBucketExpanded && rootListing) {
      appendPrefixRows(b.name, '', 1);
    }
  }

  return rows;
}

export function pruneForRefresh(
  listingKeys: string[],
  expandedIds: string[],
  bucket: string,
  prefix: string,
  selfId: string
): { deleteKeys: string[]; deleteExpanded: string[] } {
  const listingPrefix = `${bucket}\0${prefix}`;
  const expandedPrefix = `p:${bucket}\0${prefix}`;

  const deleteKeys = listingKeys.filter((k) => k.startsWith(listingPrefix));
  const deleteExpanded = expandedIds.filter(
    (id) => id.startsWith(expandedPrefix) && id !== selfId
  );

  return { deleteKeys, deleteExpanded };
}

export function applyPage(entry: Listing, page: ListPage, more: boolean): void {
  if (more) {
    const existingPrefixes = new Set(entry.prefixes);
    for (const p of page.prefixes) {
      if (!existingPrefixes.has(p)) {
        entry.prefixes.push(p);
        existingPrefixes.add(p);
      }
    }
    entry.objects = [...entry.objects, ...page.objects];
  } else {
    entry.prefixes = [...page.prefixes];
    entry.objects = [...page.objects];
  }
  entry.nextToken = page.next_token;
}

export function listingStatus(entry: Listing): string {
  const base = `${entry.objects.length} objects, ${entry.prefixes.length} folders`;
  return entry.nextToken ? `${base} (more available)` : base;
}
