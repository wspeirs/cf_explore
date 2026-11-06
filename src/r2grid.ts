import type { CellTemplate, ColumnRegular } from '@revolist/vue3-datagrid';
import { formatBytes } from './format';
import { ICONS } from './icons';

/** One row of the object grid: a listing entry plus its name relative to the folder. */
export interface ObjectRow {
  name: string;
  size: number;
  last_modified: string;
  key: string;
  etag: string | null;
  /** True for a folder (common prefix); `key` is then the folder prefix. */
  dir: boolean;
}

// revo-grid types a cell's `model` as a loose record; this grid's source rows are `ObjectRow`s
// (see `objectRows` in R2Panel.vue).
const rowOf = (model: unknown): ObjectRow => model as ObjectRow;

/**
 * Column definitions of the R2 object grid. revo-grid hands `cellTemplate` a Stencil-style
 * `h(tag, data, ...children)`: the text of a cell is a CHILD (third argument). `h('span', text)`
 * type-checks but renders an empty cell, because Stencil reads that second argument as attributes.
 */
export function buildObjectColumns(handlers: {
  openPreview: (row: ObjectRow) => void;
  download: (row: ObjectRow) => void;
}): ColumnRegular[] {
  const nameCell: CellTemplate = (h, p) => {
    const row = rowOf(p.model);
    return row.dir
      ? h('span', { class: 'dir-name' }, [
          h('span', { innerHTML: ICONS.folder }),
          h('span', null, row.name),
        ])
      : h('span', null, row.name);
  };

  const sizeCell: CellTemplate = (h, p) => {
    const row = rowOf(p.model);
    return h('span', null, row.dir ? '' : formatBytes(row.size));
  };

  const actionsCell: CellTemplate = (h, p) =>
    rowOf(p.model).dir
      ? h('span', null, '')
      : h('span', { class: 'obj-actions' }, [
          h('button', {
            class: 'icon-btn',
            title: 'Preview',
            innerHTML: ICONS.magnify,
            onClick: () => handlers.openPreview(rowOf(p.model)),
          }),
          h('button', {
            class: 'icon-btn',
            title: 'Download',
            innerHTML: ICONS.download,
            onClick: () => handlers.download(rowOf(p.model)),
          }),
        ]);

  return [
    { prop: 'name', name: 'Name', size: 320, sortable: true, cellTemplate: nameCell },
    { prop: 'size', name: 'Size', size: 100, sortable: true, cellTemplate: sizeCell },
    { prop: 'last_modified', name: 'Last Modified', size: 190, sortable: true },
    { prop: 'key', name: 'Actions', size: 64, sortable: false, cellTemplate: actionsCell },
  ];
}
