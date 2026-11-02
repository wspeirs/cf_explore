import { describe, it, expect, vi } from 'vitest';
import { buildObjectColumns, type ObjectRow } from './r2grid';

// Minimal stand-in with the Stencil `h(tag, data, ...children)` contract revo-grid passes to cellTemplate.
interface FakeNode {
  tag: string;
  data: Record<string, unknown> | null;
  children: unknown[];
}
const h = (tag: string, data: Record<string, unknown> | null, ...children: unknown[]): FakeNode => ({
  tag,
  data,
  children: children.flat(),
});

type FakeTemplate = (h: unknown, p: { model: ObjectRow }) => FakeNode;

const row: ObjectRow = {
  name: 'a.txt',
  size: 2048,
  last_modified: '2025-01-01T00:00:00Z',
  key: 'dir/a.txt',
  etag: 'e1',
};

function template(prop: string, handlers: { openPreview: (r: ObjectRow) => void; download: (r: ObjectRow) => void }) {
  const col = buildObjectColumns(handlers).find((c) => c.prop === prop);
  if (!col?.cellTemplate) throw new Error(`no cellTemplate on column ${prop}`);
  // revo-grid's own template type wants its full HyperFunc/props; the contract under test is the (tag, data, ...children) call shape.
  return col.cellTemplate as unknown as FakeTemplate;
}

describe('buildObjectColumns', () => {
  it('has Name, Size, Last Modified and Actions in that order with the planned widths and sortability', () => {
    const cols = buildObjectColumns({ openPreview: vi.fn(), download: vi.fn() });
    expect(cols.map((c) => [c.prop, c.name, c.size, c.sortable])).toEqual([
      ['name', 'Name', 320, true],
      ['size', 'Size', 100, true],
      ['last_modified', 'Last Modified', 190, true],
      ['key', 'Actions', 64, false],
    ]);
  });

  it('renders the size as a CHILD of the span (a text passed as the data argument is dropped by Stencil)', () => {
    const node = template('size', { openPreview: vi.fn(), download: vi.fn() })(h, { model: row });
    expect(node.tag).toBe('span');
    expect(node.children).toEqual(['2.0 KB']);
    expect(typeof node.data).not.toBe('string');
  });

  it('actions: Preview and Download buttons call their handler with the row model', () => {
    const handlers = { openPreview: vi.fn(), download: vi.fn() };
    const node = template('key', handlers)(h, { model: row });
    expect(node.data).toEqual({ class: 'obj-actions' });
    const [preview, download] = node.children as FakeNode[];
    expect(preview.data?.title).toBe('Preview');
    expect(download.data?.title).toBe('Download');
    expect(String(preview.data?.innerHTML)).toContain('<svg');
    expect(String(download.data?.innerHTML)).toContain('<svg');

    (preview.data?.onClick as () => void)();
    expect(handlers.openPreview).toHaveBeenCalledWith(row);
    expect(handlers.download).not.toHaveBeenCalled();
    (download.data?.onClick as () => void)();
    expect(handlers.download).toHaveBeenCalledWith(row);
  });
});
