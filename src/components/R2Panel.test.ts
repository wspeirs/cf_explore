// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { h, defineComponent, type PropType } from 'vue';
import R2Panel from './R2Panel.vue';
import { r2ListBuckets, r2ListObjects, r2Download } from '../api';
import { save } from '@tauri-apps/plugin-dialog';
import { downloadDir, join } from '@tauri-apps/api/path';
import { status, settingsStatus, settingsVersion, errorDialog } from '../state';
import type { BucketInfo, ListPage, TreeNode } from '../types';
import type { ColumnRegular } from '@revolist/vue3-datagrid';
import type { ObjectRow } from '../r2grid';

vi.mock('../api', () => ({
  r2ListBuckets: vi.fn(),
  r2ListObjects: vi.fn(),
  r2Download: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(),
}));

vi.mock('@tauri-apps/api/path', () => ({
  downloadDir: vi.fn(),
  join: vi.fn(),
}));

vi.mock('@revolist/vue3-datagrid', () => ({
  default: {
    name: 'VGrid',
    props: ['source', 'columns'],
    render: () => null,
  },
}));

const TreeViewStub = defineComponent({
  name: 'TreeView',
  props: {
    rows: {
      type: Array as PropType<TreeNode[]>,
      required: true,
    },
    selectedId: {
      type: String as PropType<string | null>,
      default: null,
    },
  },
  emits: ['toggle', 'select', 'activate'],
  setup(props, { emit }) {
    return () =>
      h(
        'div',
        { class: 'tree-stub', 'data-selected-id': props.selectedId ?? '' },
        props.rows.map((row) => {
          const attrId = row.id.replace(/\0/g, '\uFFFD');
          return h(
            'div',
            {
              key: row.id,
              'data-id': attrId,
              class: ['tree-row-stub', row.id === props.selectedId ? 'selected' : ''],
              onClick: () => emit('select', row),
              onDblclick: () => emit('activate', row),
            },
            [
              h(
                'button',
                {
                  'data-toggle-id': attrId,
                  onClick: (e: MouseEvent) => {
                    e.stopPropagation();
                    emit('toggle', row);
                  },
                },
                row.expanded ? '-' : '+'
              ),
              h('span', row.label),
            ]
          );
        })
      );
  },
});

const PreviewWindowStub = defineComponent({
  name: 'PreviewWindow',
  props: {
    target: {
      type: Object as PropType<unknown>,
      default: null,
    },
  },
  emits: ['close'],
  setup(props, { emit }) {
    return () =>
      h(
        'div',
        {
          class: 'preview-window-stub',
          'data-target': JSON.stringify(props.target),
        },
        [
          h('span', String(props.target)),
          h('button', { class: 'close-btn', onClick: () => emit('close') }, 'Close'),
        ]
      );
  },
});

const wrappers: VueWrapper[] = [];
interface FakeNode {
  tag: string;
  data: Record<string, unknown> | null;
  children: unknown[];
}

const fakeH = (tag: string, data: Record<string, unknown> | null, ...children: unknown[]): FakeNode => ({
  tag,
  data,
  children: children.flat(),
});

function getActionsButtons(columns: ColumnRegular[], row: ObjectRow) {
  const actionsCol = columns.find((c) => c.prop === 'key');
  if (!actionsCol?.cellTemplate) {
    throw new Error('Actions column missing cellTemplate');
  }
  // cellTemplate expects revo-grid HyperFunc; fakeH satisfies the Stencil contract under test
  const template = actionsCol.cellTemplate as unknown as (
    h: unknown,
    p: { model: ObjectRow }
  ) => FakeNode;
  const node = template(fakeH, { model: row });
  const buttons = (node.children as FakeNode[]).filter((c) => c.tag === 'button');
  const previewBtn = buttons.find((b) => b.data?.title === 'Preview');
  const downloadBtn = buttons.find((b) => b.data?.title === 'Download');
  if (!previewBtn || !downloadBtn) {
    throw new Error('Preview or Download button not found in cellTemplate output');
  }
  return {
    clickPreview: () => {
      const fn = previewBtn.data?.onClick as (() => void) | undefined;
      fn?.();
    },
    clickDownload: () => {
      const fn = downloadBtn.data?.onClick as (() => void) | undefined;
      fn?.();
    },
  };
}


function mountPanel(props: { active: boolean } = { active: true }) {
  const wrapper = mount(R2Panel, {
    props,
    global: {
      stubs: {
        TreeView: TreeViewStub,
        PreviewWindow: PreviewWindowStub,
      },
    },
  });
  wrappers.push(wrapper);
  return wrapper;
}

describe('R2Panel', () => {
  beforeEach(() => {
    status.value = 'Ready';
    settingsStatus.value = {
      settings: null,
      configured: false,
      r2_configured: false,
    };
    settingsVersion.value = 0;
    errorDialog.value = null;
    vi.clearAllMocks();
  });
  afterEach(() => {
    while (wrappers.length > 0) {
      wrappers.pop()?.unmount();
    }
  });

  it('mounting with active: false makes 0 calls, becoming active makes ONE call, and toggling active while pending totals ONE', async () => {
    settingsStatus.value = { settings: null, configured: true, r2_configured: true };
    settingsVersion.value = 0;

    let resolveBuckets!: (val: BucketInfo[]) => void;
    vi.mocked(r2ListBuckets).mockReturnValue(
      new Promise<BucketInfo[]>((resolve) => {
        resolveBuckets = resolve;
      })
    );

    const wrapper = mountPanel({ active: false });
    await flushPromises();
    expect(r2ListBuckets).toHaveBeenCalledTimes(0);

    await wrapper.setProps({ active: true });
    await flushPromises();
    expect(r2ListBuckets).toHaveBeenCalledTimes(1);

    await wrapper.setProps({ active: false });
    await wrapper.setProps({ active: true });
    await flushPromises();
    expect(r2ListBuckets).toHaveBeenCalledTimes(1);

    resolveBuckets([{ name: 'bucket-one', created: null }]);
    await flushPromises();
    expect(r2ListBuckets).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-id="b:bucket-one"]').exists()).toBe(true);
  });

  it('makes exactly ONE r2ListBuckets call when saving settings while R2 tab is active', async () => {
    settingsStatus.value = { settings: null, configured: false, r2_configured: false };
    settingsVersion.value = 0;
    vi.mocked(r2ListBuckets).mockResolvedValue([{ name: 'bucket-saved', created: null }]);

    mountPanel({ active: true });
    await flushPromises();
    expect(r2ListBuckets).toHaveBeenCalledTimes(0);

    // Saving settings sets settingsStatus and bumps settingsVersion in the same tick
    settingsStatus.value = { settings: null, configured: true, r2_configured: true };
    settingsVersion.value++;
    await flushPromises();

    expect(r2ListBuckets).toHaveBeenCalledTimes(1);
  });

  it('shows unconfigured message and makes no calls when r2_configured is false', async () => {
    settingsStatus.value = { settings: null, configured: true, r2_configured: false };
    settingsVersion.value = 0;

    const wrapper = mountPanel({ active: true });
    await flushPromises();

    expect(r2ListBuckets).toHaveBeenCalledTimes(0);
    expect(wrapper.text()).toContain(
      'R2 credentials are not configured. Use File › Settings... to add them.'
    );
  });

  it('caches listings on select and retries rejected listings on second select', async () => {
    settingsStatus.value = { settings: null, configured: true, r2_configured: true };
    settingsVersion.value = 0;
    vi.mocked(r2ListBuckets).mockResolvedValue([
      { name: 'bucket-cached', created: null },
      { name: 'bucket-err', created: null },
    ]);

    vi.mocked(r2ListObjects).mockResolvedValueOnce({
      prefixes: ['photos/'],
      objects: [],
      next_token: null,
    });

    const wrapper = mountPanel({ active: true });
    await flushPromises();

    const bucketRow = wrapper.find('[data-id="b:bucket-cached"]');
    await bucketRow.trigger('click');
    await flushPromises();

    expect(r2ListObjects).toHaveBeenCalledTimes(1);
    expect(r2ListObjects).toHaveBeenCalledWith('bucket-cached', '', null);

    // Re-select does not trigger another call
    await bucketRow.trigger('click');
    await flushPromises();
    expect(r2ListObjects).toHaveBeenCalledTimes(1);

    // Rejected first listing on bucket-err
    vi.mocked(r2ListObjects).mockRejectedValueOnce(new Error('Network failure'));
    const errRow = wrapper.find('[data-id="b:bucket-err"]');
    await errRow.trigger('click');
    await flushPromises();

    expect(r2ListObjects).toHaveBeenCalledTimes(2);
    expect(r2ListObjects).toHaveBeenLastCalledWith('bucket-err', '', null);
    expect(errorDialog.value).toBe('Network failure');
    // Ensure node is not left expanded
    expect(wrapper.find('[data-toggle-id="b:bucket-err"]').text()).toBe('+');

    // Second select RETRIES (2 calls for this bucket, 3 total)
    vi.mocked(r2ListObjects).mockResolvedValueOnce({
      prefixes: ['recovered/'],
      objects: [],
      next_token: null,
    });
    await errRow.trigger('click');
    await flushPromises();

    expect(r2ListObjects).toHaveBeenCalledTimes(3);
    expect(r2ListObjects).toHaveBeenLastCalledWith('bucket-err', '', null);
  });

  it('ignores stale response when Refresh is clicked while listing is still pending and does not throw', async () => {
    settingsStatus.value = { settings: null, configured: true, r2_configured: true };
    settingsVersion.value = 0;
    vi.mocked(r2ListBuckets).mockResolvedValue([{ name: 'b1', created: null }]);

    let resolveFirstListing!: (page: ListPage) => void;
    vi.mocked(r2ListObjects).mockImplementationOnce(
      () =>
        new Promise<ListPage>((resolve) => {
          resolveFirstListing = resolve;
        })
    );

    const wrapper = mountPanel({ active: true });
    await flushPromises();

    // Select bucket b1 to start the first listing
    await wrapper.find('[data-id="b:b1"]').trigger('click');
    expect(r2ListObjects).toHaveBeenCalledTimes(1);

    // Setup second listing mock for the Refresh call
    vi.mocked(r2ListObjects).mockResolvedValueOnce({
      prefixes: ['fresh/'],
      objects: [{ key: 'fresh.txt', size: 100, last_modified: null, etag: null }],
      next_token: null,
    });

    // Click Refresh while first listing is still pending
    await wrapper.find('button[title="Refresh"]').trigger('click');
    await flushPromises();
    expect(r2ListObjects).toHaveBeenCalledTimes(2);

    // Now resolve the stale first listing
    resolveFirstListing({
      prefixes: ['stale/'],
      objects: [{ key: 'stale.txt', size: 50, last_modified: null, etag: null }],
      next_token: null,
    });
    await flushPromises();

    // Must not set errorDialog
    expect(errorDialog.value).toBeNull();
    // Status text matches the fresh listing
    expect(status.value).toBe('1 objects, 1 folders');

    // Expand b1 to verify only fresh/ is present
    await wrapper.find('[data-toggle-id="b:b1"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-id="p:b1\0fresh/"]').exists()).toBe(true);
    expect(wrapper.find('[data-id="p:b1\0stale/"]').exists()).toBe(false);
  });

  it('selects more row to load next page and appends objects and prefixes', async () => {
    settingsStatus.value = { settings: null, configured: true, r2_configured: true };
    settingsVersion.value = 0;
    vi.mocked(r2ListBuckets).mockResolvedValue([{ name: 'b1', created: null }]);

    // Page 1
    vi.mocked(r2ListObjects).mockResolvedValueOnce({
      prefixes: ['p1/'],
      objects: [{ key: 'o1', size: 10, last_modified: null, etag: null }],
      next_token: 'tok-123',
    });

    const wrapper = mountPanel({ active: true });
    await flushPromises();

    // Select bucket b1 to load page 1
    await wrapper.find('[data-id="b:b1"]').trigger('click');
    // Expand bucket b1 so its children appear
    await wrapper.find('[data-toggle-id="b:b1"]').trigger('click');
    await flushPromises();

    expect(r2ListObjects).toHaveBeenCalledTimes(1);
    expect(r2ListObjects).toHaveBeenLastCalledWith('b1', '', null);
    expect(status.value).toBe('1 objects, 1 folders (more available)');

    const moreRow = wrapper.find('[data-id="more:b1\0"]');
    expect(moreRow.exists()).toBe(true);

    // Page 2
    vi.mocked(r2ListObjects).mockResolvedValueOnce({
      prefixes: ['p2/'],
      objects: [{ key: 'o2', size: 20, last_modified: null, etag: null }],
      next_token: null,
    });

    // Select more: row
    await moreRow.trigger('click');
    await flushPromises();

    expect(r2ListObjects).toHaveBeenCalledTimes(2);
    expect(r2ListObjects).toHaveBeenLastCalledWith('b1', '', 'tok-123');
    expect(status.value).toBe('2 objects, 2 folders');
  });

  it('refreshes a selected node even when its parent is collapsed', async () => {
    settingsStatus.value = { settings: null, configured: true, r2_configured: true };
    settingsVersion.value = 0;
    vi.mocked(r2ListBuckets).mockResolvedValue([{ name: 'b1', created: null }]);

    // Root listing of bucket b1
    vi.mocked(r2ListObjects).mockResolvedValueOnce({
      prefixes: ['subfolder/'],
      objects: [],
      next_token: null,
    });

    const wrapper = mountPanel({ active: true });
    await flushPromises();

    // Expand bucket b1 so subfolder/ appears
    await wrapper.find('[data-toggle-id="b:b1"]').trigger('click');
    await flushPromises();

    // Setup listing mock for subfolder/
    vi.mocked(r2ListObjects).mockResolvedValueOnce({
      prefixes: [],
      objects: [{ key: 'subfolder/item1.txt', size: 50, last_modified: null, etag: null }],
      next_token: null,
    });

    // Select subfolder/ row
    const folderRow = wrapper.find('[data-id="p:b1\0subfolder/"]');
    await folderRow.trigger('click');
    await flushPromises();
    expect(r2ListObjects).toHaveBeenCalledTimes(2);
    expect(r2ListObjects).toHaveBeenLastCalledWith('b1', 'subfolder/', null);

    // Now collapse parent bucket b1
    await wrapper.find('[data-toggle-id="b:b1"]').trigger('click');
    await flushPromises();

    // The folder row is no longer rendered in the tree
    expect(wrapper.find('[data-id="p:b1\0subfolder/"]').exists()).toBe(false);

    // Setup mock for refreshing subfolder/
    vi.mocked(r2ListObjects).mockResolvedValueOnce({
      prefixes: [],
      objects: [{ key: 'subfolder/item2.txt', size: 80, last_modified: null, etag: null }],
      next_token: null,
    });

    // Click Refresh
    await wrapper.find('button[title="Refresh"]').trigger('click');
    await flushPromises();

    // r2ListObjects must have been called for subfolder/
    expect(r2ListObjects).toHaveBeenCalledTimes(3);
    expect(r2ListObjects).toHaveBeenLastCalledWith('b1', 'subfolder/', null);
  });

  it('refreshes root by resetting state and reloading buckets', async () => {
    settingsStatus.value = { settings: null, configured: true, r2_configured: true };
    settingsVersion.value = 0;
    vi.mocked(r2ListBuckets).mockResolvedValueOnce([{ name: 'bucket-old', created: null }]);

    const wrapper = mountPanel({ active: true });
    await flushPromises();
    expect(r2ListBuckets).toHaveBeenCalledTimes(1);

    vi.mocked(r2ListBuckets).mockResolvedValueOnce([{ name: 'bucket-new', created: null }]);
    await wrapper.find('button[title="Refresh"]').trigger('click');
    await flushPromises();

    expect(r2ListBuckets).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-id="b:bucket-new"]').exists()).toBe(true);
  });

  it('grid source reflects the current listing and path label shows bucket/folder paths', async () => {
    settingsStatus.value = { settings: null, configured: true, r2_configured: true };
    settingsVersion.value = 0;
    vi.mocked(r2ListBuckets).mockResolvedValueOnce([{ name: 'b1', created: null }]);

    const wrapper = mountPanel({ active: true });
    await flushPromises();

    expect(wrapper.find('.path-label').text()).toBe('Select a bucket or folder');
    const vgrid = wrapper.findComponent({ name: 'VGrid' });
    expect(vgrid.props('source')).toEqual([]);

    // Select bucket b1 root
    vi.mocked(r2ListObjects).mockResolvedValueOnce({
      prefixes: ['dir/'],
      objects: [{ key: 'root.txt', size: 1024, last_modified: '2025-01-01T00:00:00Z', etag: 'e0' }],
      next_token: null,
    });

    await wrapper.find('[data-id="b:b1"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('.path-label').text()).toBe('b1/');
    expect(vgrid.props('source')).toEqual([
      {
        name: 'root.txt',
        size: 1024,
        last_modified: '2025-01-01T00:00:00Z',
        key: 'root.txt',
        etag: 'e0',
      },
    ]);

    // Expand bucket b1 so folder row appears
    await wrapper.find('[data-toggle-id="b:b1"]').trigger('click');
    await flushPromises();

    // Select folder dir/
    vi.mocked(r2ListObjects).mockResolvedValueOnce({
      prefixes: [],
      objects: [{ key: 'dir/report.csv', size: 2048, last_modified: '2025-01-01T00:00:00Z', etag: 'e1' }],
      next_token: null,
    });

    const folderRow = wrapper.find('[data-id="p:b1\0dir/"]');
    await folderRow.trigger('click');
    await flushPromises();

    expect(wrapper.find('.path-label').text()).toBe('b1/dir/');
    expect(vgrid.props('source')).toEqual([
      {
        name: 'report.csv',
        size: 2048,
        last_modified: '2025-01-01T00:00:00Z',
        key: 'dir/report.csv',
        etag: 'e1',
      },
    ]);
  });

  it('preview action sets PreviewWindow target and close event removes it', async () => {
    settingsStatus.value = { settings: null, configured: true, r2_configured: true };
    settingsVersion.value = 0;
    vi.mocked(r2ListBuckets).mockResolvedValueOnce([{ name: 'b1', created: null }]);
    vi.mocked(r2ListObjects).mockResolvedValueOnce({
      prefixes: [],
      objects: [{ key: 'dir/report.csv', size: 2048, last_modified: '2025-01-01T00:00:00Z', etag: 'e1' }],
      next_token: null,
    });

    const wrapper = mountPanel({ active: true });
    await flushPromises();

    await wrapper.find('[data-id="b:b1"]').trigger('click');
    await flushPromises();

    expect(wrapper.findComponent({ name: 'PreviewWindow' }).exists()).toBe(false);

    const vgrid = wrapper.findComponent({ name: 'VGrid' });
    const columns = vgrid.props('columns') as ColumnRegular[];
    const rows = vgrid.props('source') as ObjectRow[];
    const { clickPreview } = getActionsButtons(columns, rows[0]);

    clickPreview();
    await flushPromises();

    const previewStub = wrapper.find('.preview-window-stub');
    expect(previewStub.exists()).toBe(true);
    const targetData = JSON.parse(previewStub.attributes('data-target') ?? '{}') as unknown;
    expect(targetData).toEqual({
      bucket: 'b1',
      key: 'dir/report.csv',
      size: 2048,
      etag: 'e1',
    });

    const previewWin = wrapper.findComponent({ name: 'PreviewWindow' });
    expect(previewWin.props('target')).toEqual({
      bucket: 'b1',
      key: 'dir/report.csv',
      size: 2048,
      etag: 'e1',
    });

    await wrapper.find('.preview-window-stub .close-btn').trigger('click');
    await flushPromises();

    expect(wrapper.findComponent({ name: 'PreviewWindow' }).exists()).toBe(false);
  });

  it('derives defaultPath for download, falling back on rejection or trailing slash', async () => {
    settingsStatus.value = { settings: null, configured: true, r2_configured: true };
    settingsVersion.value = 0;
    vi.mocked(r2ListBuckets).mockResolvedValueOnce([{ name: 'b1', created: null }]);
    vi.mocked(r2ListObjects).mockResolvedValueOnce({
      prefixes: [],
      objects: [
        { key: 'dir/report.csv', size: 2048, last_modified: '2025-01-01T00:00:00Z', etag: 'e1' },
        { key: 'dir/folder/', size: 0, last_modified: null, etag: null },
      ],
      next_token: null,
    });

    vi.mocked(join).mockImplementation(async (...args: string[]) => args.join('/'));

    const wrapper = mountPanel({ active: true });
    await flushPromises();

    await wrapper.find('[data-id="b:b1"]').trigger('click');
    await flushPromises();

    const vgrid = wrapper.findComponent({ name: 'VGrid' });
    const columns = vgrid.props('columns') as ColumnRegular[];
    const rows = vgrid.props('source') as ObjectRow[];

    // 1. downloadDir resolves '/home/u/Downloads' and join resolves '/home/u/Downloads/report.csv'
    vi.mocked(downloadDir).mockResolvedValueOnce('/home/u/Downloads');
    vi.mocked(save).mockResolvedValueOnce(null);

    const { clickDownload: downloadReport } = getActionsButtons(columns, rows[0]);
    downloadReport();
    await flushPromises();

    expect(save).toHaveBeenLastCalledWith({
      title: 'Download object',
      defaultPath: '/home/u/Downloads/report.csv',
    });

    // 2. downloadDir rejects -> defaultPath is just 'report.csv'
    vi.mocked(downloadDir).mockRejectedValueOnce(new Error('no download directory'));
    vi.mocked(save).mockResolvedValueOnce(null);

    downloadReport();
    await flushPromises();

    expect(save).toHaveBeenLastCalledWith({
      title: 'Download object',
      defaultPath: 'report.csv',
    });

    // 3. A key ending in '/' falls back to the name 'download'
    vi.mocked(downloadDir).mockResolvedValueOnce('/home/u/Downloads');
    vi.mocked(save).mockResolvedValueOnce(null);

    const { clickDownload: downloadTrailing } = getActionsButtons(columns, rows[1]);
    downloadTrailing();
    await flushPromises();

    expect(save).toHaveBeenLastCalledWith({
      title: 'Download object',
      defaultPath: '/home/u/Downloads/download',
    });
  });

  it('does not call r2Download and leaves status unchanged when save dialog is cancelled', async () => {
    settingsStatus.value = { settings: null, configured: true, r2_configured: true };
    settingsVersion.value = 0;
    vi.mocked(r2ListBuckets).mockResolvedValueOnce([{ name: 'b1', created: null }]);
    vi.mocked(r2ListObjects).mockResolvedValueOnce({
      prefixes: [],
      objects: [{ key: 'dir/report.csv', size: 2048, last_modified: '2025-01-01T00:00:00Z', etag: 'e1' }],
      next_token: null,
    });

    const wrapper = mountPanel({ active: true });
    await flushPromises();

    await wrapper.find('[data-id="b:b1"]').trigger('click');
    await flushPromises();

    const initialStatus = status.value;
    expect(initialStatus).toBe('1 objects, 0 folders');

    vi.mocked(save).mockResolvedValueOnce(null);

    const vgrid = wrapper.findComponent({ name: 'VGrid' });
    const columns = vgrid.props('columns') as ColumnRegular[];
    const rows = vgrid.props('source') as ObjectRow[];
    const { clickDownload } = getActionsButtons(columns, rows[0]);

    clickDownload();
    await flushPromises();

    expect(r2Download).not.toHaveBeenCalled();
    expect(status.value).toBe(initialStatus);
  });

  it('calls r2Download and updates status while pending and when completed', async () => {
    settingsStatus.value = { settings: null, configured: true, r2_configured: true };
    settingsVersion.value = 0;
    vi.mocked(r2ListBuckets).mockResolvedValueOnce([{ name: 'b1', created: null }]);
    vi.mocked(r2ListObjects).mockResolvedValueOnce({
      prefixes: [],
      objects: [{ key: 'dir/report.csv', size: 2048, last_modified: '2025-01-01T00:00:00Z', etag: 'e1' }],
      next_token: null,
    });

    const wrapper = mountPanel({ active: true });
    await flushPromises();

    await wrapper.find('[data-id="b:b1"]').trigger('click');
    await flushPromises();

    vi.mocked(save).mockResolvedValueOnce('/tmp/out.csv');

    let resolveDownload!: (bytes: number) => void;
    vi.mocked(r2Download).mockReturnValueOnce(
      new Promise<number>((resolve) => {
        resolveDownload = resolve;
      })
    );

    const vgrid = wrapper.findComponent({ name: 'VGrid' });
    const columns = vgrid.props('columns') as ColumnRegular[];
    const rows = vgrid.props('source') as ObjectRow[];
    const { clickDownload } = getActionsButtons(columns, rows[0]);

    clickDownload();
    await flushPromises();

    expect(r2Download).toHaveBeenCalledWith('b1', 'dir/report.csv', '/tmp/out.csv');
    expect(status.value).toBe('Downloading dir/report.csv…');

    resolveDownload(2048);
    await flushPromises();

    expect(status.value).toBe('Saved dir/report.csv to /tmp/out.csv (2.0 KB)');
  });

  it('sets errorDialog when r2Download rejects with a string', async () => {
    settingsStatus.value = { settings: null, configured: true, r2_configured: true };
    settingsVersion.value = 0;
    vi.mocked(r2ListBuckets).mockResolvedValueOnce([{ name: 'b1', created: null }]);
    vi.mocked(r2ListObjects).mockResolvedValueOnce({
      prefixes: [],
      objects: [{ key: 'dir/report.csv', size: 2048, last_modified: '2025-01-01T00:00:00Z', etag: 'e1' }],
      next_token: null,
    });

    const wrapper = mountPanel({ active: true });
    await flushPromises();

    await wrapper.find('[data-id="b:b1"]').trigger('click');
    await flushPromises();

    vi.mocked(save).mockResolvedValueOnce('/tmp/out.csv');
    vi.mocked(r2Download).mockRejectedValueOnce('disk full');

    const vgrid = wrapper.findComponent({ name: 'VGrid' });
    const columns = vgrid.props('columns') as ColumnRegular[];
    const rows = vgrid.props('source') as ObjectRow[];
    const { clickDownload } = getActionsButtons(columns, rows[0]);

    clickDownload();
    await flushPromises();

    expect(errorDialog.value).toBe('disk full');
  });

  it('shows Load more button only when current listing has next_token, calling r2ListObjects and appending rows', async () => {
    settingsStatus.value = { settings: null, configured: true, r2_configured: true };
    settingsVersion.value = 0;
    vi.mocked(r2ListBuckets).mockResolvedValueOnce([{ name: 'b1', created: null }]);

    const wrapper = mountPanel({ active: true });
    await flushPromises();

    expect(wrapper.find('.load-more-bar').exists()).toBe(false);

    vi.mocked(r2ListObjects).mockResolvedValueOnce({
      prefixes: [],
      objects: [{ key: 'first.txt', size: 100, last_modified: '2025-01-01T00:00:00Z', etag: 'e1' }],
      next_token: 'tok-abc',
    });

    await wrapper.find('[data-id="b:b1"]').trigger('click');
    await flushPromises();

    const loadMoreBtn = wrapper.find('.load-more-bar button');
    expect(loadMoreBtn.exists()).toBe(true);
    expect(loadMoreBtn.text()).toBe('Load more…');

    const vgrid = wrapper.findComponent({ name: 'VGrid' });
    expect((vgrid.props('source') as ObjectRow[]).map((r) => r.name)).toEqual(['first.txt']);

    vi.mocked(r2ListObjects).mockResolvedValueOnce({
      prefixes: [],
      objects: [{ key: 'second.txt', size: 200, last_modified: '2025-01-02T00:00:00Z', etag: 'e2' }],
      next_token: null,
    });

    await loadMoreBtn.trigger('click');
    await flushPromises();

    expect(r2ListObjects).toHaveBeenCalledTimes(2);
    expect(r2ListObjects).toHaveBeenLastCalledWith('b1', '', 'tok-abc');

    const updatedSource = vgrid.props('source') as ObjectRow[];
    expect(updatedSource.map((r) => r.name)).toEqual(['first.txt', 'second.txt']);

    expect(wrapper.find('.load-more-bar').exists()).toBe(false);
  });
});
