import { describe, it, expect } from 'vitest';
import {
  buildR2TreeRows,
  pruneForRefresh,
  applyPage,
  listingStatus,
  type Listing,
} from './r2tree';
import type { BucketInfo, ListPage } from './types';

describe('r2tree helpers', () => {
  describe('buildR2TreeRows', () => {
    it('returns only root when buckets is null', () => {
      const rows = buildR2TreeRows(null, new Map(), new Set(['root']));
      expect(rows).toEqual([
        {
          id: 'root',
          label: 'R2 Buckets',
          icon: 'bucket',
          depth: 0,
          expandable: true,
          expanded: true,
          loading: false,
          data: null,
        },
      ]);
    });

    it('returns only root and b:b when b:b is collapsed', () => {
      const buckets: BucketInfo[] = [{ name: 'b', created: null }];
      const listings = new Map<string, Listing>();
      const expanded = new Set(['root']);

      const rows = buildR2TreeRows(buckets, listings, expanded);
      expect(rows.map((r) => r.id)).toEqual(['root', 'b:b']);
      expect(rows[1]).toMatchObject({
        id: 'b:b',
        label: 'b',
        icon: 'bucket',
        depth: 1,
        expandable: true,
        expanded: false,
        data: { bucket: 'b', prefix: '' },
      });
    });

    it('builds rows with prefixes and more item when expanded', () => {
      const buckets: BucketInfo[] = [{ name: 'b', created: null }];
      const listings = new Map<string, Listing>([
        [
          'b\u0000',
          {
            prefixes: ['x/'],
            objects: [],
            nextToken: 't',
            loading: false,
          },
        ],
      ]);
      const expanded = new Set(['root', 'b:b']);

      const rows = buildR2TreeRows(buckets, listings, expanded);
      expect(rows.map((r) => r.id)).toEqual([
        'root',
        'b:b',
        'p:b\u0000x/',
        'more:b\u0000',
      ]);

      const folderRow = rows.find((r) => r.id === 'p:b\u0000x/')!;
      expect(folderRow.label).toBe('x/');
      expect(folderRow.depth).toBe(2);

      const moreRow = rows.find((r) => r.id === 'more:b\u0000')!;
      expect(moreRow.data).toEqual({ bucket: 'b', prefix: '', more: true });
    });

    it('renders recursive folder children at depth 3', () => {
      const buckets: BucketInfo[] = [{ name: 'b', created: null }];
      const listings = new Map<string, Listing>([
        [
          'b\u0000',
          {
            prefixes: ['x/'],
            objects: [],
            nextToken: 't',
            loading: false,
          },
        ],
        [
          'b\u0000x/',
          {
            prefixes: ['x/y/'],
            objects: [],
            nextToken: null,
            loading: false,
          },
        ],
      ]);
      const expanded = new Set(['root', 'b:b', 'p:b\u0000x/']);

      const rows = buildR2TreeRows(buckets, listings, expanded);
      const childRow = rows.find((r) => r.id === 'p:b\u0000x/y/')!;
      expect(childRow).toBeDefined();
      expect(childRow.label).toBe('y/');
      expect(childRow.depth).toBe(3);
    });
  });

  describe('pruneForRefresh', () => {
    const keys = [
      'foo\u0000',
      'foo\u0000a/',
      'foo\u0000a/b/',
      'foo\u0000ab/',
      'foobar\u0000',
    ];

    it('prunes listing keys for a subprefix', () => {
      const { deleteKeys } = pruneForRefresh(keys, [], 'foo', 'a/', 'p:foo\u0000a/');
      expect(deleteKeys).toEqual(['foo\u0000a/', 'foo\u0000a/b/']);
    });

    it('prunes listing keys for root bucket prefix without touching sibling bucket', () => {
      const { deleteKeys } = pruneForRefresh(keys, [], 'foo', '', 'b:foo');
      expect(deleteKeys).toEqual([
        'foo\u0000',
        'foo\u0000a/',
        'foo\u0000a/b/',
        'foo\u0000ab/',
      ]);
      expect(deleteKeys).not.toContain('foobar\u0000');
    });

    const expanded = [
      'p:foo\u0000a/',
      'p:foo\u0000a/b/',
      'p:foo\u0000ab/',
      'b:foo',
    ];

    it('prunes expanded ids for subprefix except selfId', () => {
      const { deleteExpanded } = pruneForRefresh(
        [],
        expanded,
        'foo',
        'a/',
        'p:foo\u0000a/'
      );
      expect(deleteExpanded).toEqual(['p:foo\u0000a/b/']);
    });

    it('prunes expanded ids for bucket without selfId b:foo', () => {
      const { deleteExpanded } = pruneForRefresh(
        [],
        expanded,
        'foo',
        '',
        'b:foo'
      );
      expect(deleteExpanded).toEqual([
        'p:foo\u0000a/',
        'p:foo\u0000a/b/',
        'p:foo\u0000ab/',
      ]);
      expect(deleteExpanded).not.toContain('b:foo');
    });
  });

  describe('applyPage', () => {
    it('fully replaces prefixes, objects, and nextToken when more is false', () => {
      const entry: Listing = {
        prefixes: ['old/'],
        objects: [{ key: 'old.txt', size: 1, last_modified: null, etag: null }],
        nextToken: 'old-token',
        loading: true,
      };
      const page: ListPage = {
        prefixes: ['new/'],
        objects: [{ key: 'new.txt', size: 2, last_modified: null, etag: null }],
        next_token: 'new-token',
      };

      applyPage(entry, page, false);
      expect(entry.prefixes).toEqual(['new/']);
      expect(entry.objects).toEqual([
        { key: 'new.txt', size: 2, last_modified: null, etag: null },
      ]);
      expect(entry.nextToken).toBe('new-token');
    });

    it('appends objects, de-duplicates prefixes, and replaces nextToken when more is true', () => {
      const entry: Listing = {
        prefixes: ['p1/', 'p2/'],
        objects: [{ key: 'obj1', size: 10, last_modified: null, etag: null }],
        nextToken: 'tok1',
        loading: true,
      };
      const page: ListPage = {
        prefixes: ['p2/', 'p3/'],
        objects: [{ key: 'obj2', size: 20, last_modified: null, etag: null }],
        next_token: 'tok2',
      };

      applyPage(entry, page, true);
      expect(entry.prefixes).toEqual(['p1/', 'p2/', 'p3/']);
      expect(entry.objects).toEqual([
        { key: 'obj1', size: 10, last_modified: null, etag: null },
        { key: 'obj2', size: 20, last_modified: null, etag: null },
      ]);
      expect(entry.nextToken).toBe('tok2');
    });
  });

  describe('listingStatus', () => {
    it('formats status with (more available) suffix when nextToken is present', () => {
      const entry: Listing = {
        prefixes: ['folder1/'],
        objects: [
          { key: 'file1', size: 1, last_modified: null, etag: null },
          { key: 'file2', size: 2, last_modified: null, etag: null },
        ],
        nextToken: 'has-more',
        loading: false,
      };
      expect(listingStatus(entry)).toBe('2 objects, 1 folders (more available)');
    });

    it('formats status without suffix when nextToken is null', () => {
      const entry: Listing = {
        prefixes: ['folder1/'],
        objects: [
          { key: 'file1', size: 1, last_modified: null, etag: null },
          { key: 'file2', size: 2, last_modified: null, etag: null },
        ],
        nextToken: null,
        loading: false,
      };
      expect(listingStatus(entry)).toBe('2 objects, 1 folders');
    });
  });
});
