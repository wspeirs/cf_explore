// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import type { D1Database, TableInfo, TreeNode, QueryOutcome } from '../types';
import { status, settingsStatus, settingsVersion, errorDialog } from '../state';
import { d1ListDatabases, d1LoadSchema, d1Query } from '../api';
import D1Panel from './D1Panel.vue';

vi.mock('../api', () => ({
  d1ListDatabases: vi.fn(),
  d1LoadSchema: vi.fn(),
  d1Query: vi.fn(),
}));

vi.mock('@revolist/vue3-datagrid', () => ({
  default: { name: 'VGrid', render: () => null },
}));

const TreeViewStub = defineComponent({
  name: 'TreeView',
  props: {
    rows: {
      type: Array as () => TreeNode[],
      default: () => [],
    },
    selectedId: {
      type: String as () => string | null,
      default: null,
    },
  },
  emits: ['toggle', 'select', 'activate'],
  setup(props, { emit }) {
    return () =>
      h(
        'div',
        { class: 'tree-view-stub' },
        props.rows.map((row) =>
          h(
            'div',
            {
              key: row.id,
              'data-id': row.id,
              onClick: () => emit('select', row),
              onDblclick: () => emit('activate', row),
            },
            [
              h(
                'button',
                {
                  class: 'stub-twisty',
                  onClick: (e: Event) => {
                    e.stopPropagation();
                    emit('toggle', row);
                  },
                },
                row.expanded ? '-' : '+'
              ),
              h('span', row.label),
            ]
          )
        )
      );
  },
});

const ResultGridStub = defineComponent({
  name: 'ResultGrid',
  props: {
    columns: {
      type: Array as () => string[],
      default: () => [],
    },
    rows: {
      type: Array as () => unknown[][],
      default: () => [],
    },
  },
  setup(props) {
    return () =>
      h('div', {
        class: 'result-grid-stub',
        'data-columns': JSON.stringify(props.columns),
        'data-rows': JSON.stringify(props.rows),
      });
  },
});

const twoDatabases: D1Database[] = [
  { uuid: 'u1', name: 'db1', created_at: null, jurisdiction: null },
  { uuid: 'u2', name: 'db2', created_at: null, jurisdiction: null },
];

const schemaWithColumns: TableInfo[] = [
  {
    name: 't',
    kind: 'table',
    columns: [{ name: 'id', col_type: 'INTEGER', pk: true, not_null: true }],
  },
];

const wrappers: VueWrapper[] = [];

function mountD1Panel(options?: Parameters<typeof mount>[1]) {
  const wrapper = mount(D1Panel, {
    attachTo: document.body,
    ...options,
    global: {
      ...options?.global,
      stubs: {
        TreeView: TreeViewStub,
        ResultGrid: ResultGridStub,
        ...options?.global?.stubs,
      },
    },
  });
  wrappers.push(wrapper as unknown as VueWrapper);
  return wrapper;
}

const defaultDatabases: D1Database[] = [
  { uuid: 'u1', name: 'db1', created_at: null, jurisdiction: null },
];

const defaultSchema: TableInfo[] = [
  {
    name: 't',
    kind: 'table',
    columns: [{ name: 'id', col_type: 'INTEGER', pk: true, not_null: true }],
  },
];

const defaultQueryOutcome: QueryOutcome = {
  columns: ['col1'],
  rows: [['val1']],
  result_statement: null,
  statement_count: 1,
  rows_read: 1,
  rows_written: 0,
  changes: 0,
  duration_ms: 1.0,
  limit_applied: false,
};

describe('D1Panel', () => {
  beforeEach(() => {
    status.value = 'Ready';
    settingsStatus.value = {
      settings: null,
      configured: true,
      r2_configured: false,
    };
    settingsVersion.value = 0;
    errorDialog.value = null;
    vi.clearAllMocks();

    vi.mocked(d1ListDatabases).mockResolvedValue(defaultDatabases);
    vi.mocked(d1LoadSchema).mockResolvedValue(defaultSchema);
    vi.mocked(d1Query).mockResolvedValue(defaultQueryOutcome);
  });

  afterEach(() => {
    while (wrappers.length > 0) {
      const w = wrappers.pop();
      try {
        w?.unmount();
      } catch {
        // ignore if already unmounted
      }
    }
    document.body.innerHTML = '';
  });

  it('emitting activate for a table node while the textarea holds a non-empty SELECTION of different text calls d1Query("u1", "SELECT * FROM \\"t\\" LIMIT 100;")', async () => {
    const wrapper = mount(D1Panel, {
      attachTo: document.body,
      global: {
        stubs: {
          TreeView: TreeViewStub,
          ResultGrid: { name: 'ResultGrid', render: () => null },
        },
      },
    });
    await flushPromises();

    const textarea = wrapper.find<HTMLTextAreaElement>('textarea').element;
    textarea.value = 'SELECT OLD_QUERY;';
    textarea.setSelectionRange(0, 6);

    const tableNode: TreeNode = {
      id: 'tbl:u1:t',
      label: 't',
      icon: 'table',
      depth: 2,
      expandable: true,
      expanded: false,
      loading: false,
      data: { dbId: 'u1', table: 't' },
    };

    const tree = wrapper.findComponent(TreeViewStub);
    tree.vm.$emit('activate', tableNode);
    await flushPromises();

    expect(d1Query).toHaveBeenCalledWith('u1', 'SELECT * FROM "t" LIMIT 100;');
    wrapper.unmount();
  });

  it('emitting toggle for the same unloaded db node three times quickly produces exactly ONE d1LoadSchema call', async () => {
    let resolveSchema: (val: TableInfo[]) => void = () => {};
    vi.mocked(d1LoadSchema).mockImplementation(
      () =>
        new Promise<TableInfo[]>((resolve) => {
          resolveSchema = resolve;
        })
    );

    const wrapper = mount(D1Panel, {
      global: {
        stubs: {
          TreeView: TreeViewStub,
          ResultGrid: { name: 'ResultGrid', render: () => null },
        },
      },
    });
    await flushPromises();

    const dbNode: TreeNode = {
      id: 'db:u1',
      label: 'db1',
      icon: 'database',
      depth: 1,
      expandable: true,
      expanded: false,
      loading: false,
      data: { dbId: 'u1' },
    };

    const tree = wrapper.findComponent(TreeViewStub);
    tree.vm.$emit('toggle', dbNode);
    tree.vm.$emit('toggle', dbNode);
    tree.vm.$emit('toggle', dbNode);

    expect(d1LoadSchema).toHaveBeenCalledTimes(1);
    expect(d1LoadSchema).toHaveBeenCalledWith('u1');

    resolveSchema(defaultSchema);
    await flushPromises();
    wrapper.unmount();
  });

  it('after load the status is 1 databases', async () => {
    const wrapper = mount(D1Panel, {
      global: {
        stubs: {
          TreeView: TreeViewStub,
          ResultGrid: { name: 'ResultGrid', render: () => null },
        },
      },
    });
    await flushPromises();

    expect(status.value).toBe('1 databases');
    wrapper.unmount();
  });

  it('run with no active database sets errorDialog to Select a database in the tree (or the Database list) first.', async () => {
    const wrapper = mount(D1Panel, {
      global: {
        stubs: {
          TreeView: TreeViewStub,
          ResultGrid: { name: 'ResultGrid', render: () => null },
        },
      },
    });
    await flushPromises();

    const runBtn = wrapper.find('button.default');
    await runBtn.trigger('click');
    await flushPromises();

    expect(errorDialog.value).toBe(
      'Select a database in the tree (or the Database list) first.'
    );
    expect(d1Query).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('a settings change (settingsVersion.value++) while the first d1ListDatabases is pending ignores the stale first response', async () => {
    let resolveFirst: (dbs: D1Database[]) => void = () => {};
    let resolveSecond: (dbs: D1Database[]) => void = () => {};
    let count = 0;

    vi.mocked(d1ListDatabases).mockImplementation(() => {
      count++;
      if (count === 1) {
        return new Promise<D1Database[]>((resolve) => {
          resolveFirst = resolve;
        });
      } else {
        return new Promise<D1Database[]>((resolve) => {
          resolveSecond = resolve;
        });
      }
    });

    const wrapper = mount(D1Panel, {
      global: {
        stubs: {
          TreeView: TreeViewStub,
          ResultGrid: { name: 'ResultGrid', render: () => null },
        },
      },
    });

    expect(count).toBe(1);

    settingsVersion.value++;
    await flushPromises();

    expect(count).toBe(2);

    resolveSecond([
      { uuid: 'u2', name: 'db2', created_at: null, jurisdiction: null },
    ]);
    await flushPromises();

    expect(status.value).toBe('1 databases');
    const optionsAfterSecond = wrapper.findAll('select option');
    expect(optionsAfterSecond.map((o) => o.text())).toContain('db2');

    resolveFirst([
      { uuid: 'u1_stale', name: 'db1_stale', created_at: null, jurisdiction: null },
      { uuid: 'u1_extra', name: 'db1_extra', created_at: null, jurisdiction: null },
    ]);
    await flushPromises();

    expect(status.value).toBe('1 databases');
    const optionsAfterStale = wrapper.findAll('select option');
    expect(optionsAfterStale.map((o) => o.text())).toContain('db2');
    expect(optionsAfterStale.map((o) => o.text())).not.toContain('db1_stale');

    wrapper.unmount();
  });

  it('run returns immediately when running is already true', async () => {
    let resolveQuery: (val: QueryOutcome) => void = () => {};
    vi.mocked(d1Query).mockImplementation(
      () =>
        new Promise<QueryOutcome>((resolve) => {
          resolveQuery = resolve;
        })
    );

    const wrapper = mount(D1Panel, {
      global: {
        stubs: {
          TreeView: TreeViewStub,
          ResultGrid: { name: 'ResultGrid', render: () => null },
        },
      },
    });
    await flushPromises();

    const select = wrapper.find('select');
    await select.setValue('u1');

    const runBtn = wrapper.find('button.default');
    await runBtn.trigger('click');

    expect(d1Query).toHaveBeenCalledTimes(1);

    await runBtn.trigger('click');
    expect(d1Query).toHaveBeenCalledTimes(1);

    resolveQuery(defaultQueryOutcome);
    await flushPromises();
    wrapper.unmount();
  });

  it('settings change resets selectedId to root', async () => {
    const wrapper = mount(D1Panel, {
      global: {
        stubs: {
          TreeView: TreeViewStub,
          ResultGrid: { name: 'ResultGrid', render: () => null },
        },
      },
    });
    await flushPromises();

    const tree = wrapper.findComponent(TreeViewStub);
    tree.vm.$emit('select', {
      id: 'db:u1',
      label: 'db1',
      icon: 'database',
      depth: 1,
      expandable: true,
      expanded: false,
      loading: false,
      data: { dbId: 'u1' },
    });
    await flushPromises();

    settingsVersion.value++;
    await flushPromises();

    expect(tree.props('selectedId')).toBe('root');
    wrapper.unmount();
  });

  it('refresh with root selected calls d1ListDatabases once more, discards cached schema, collapses everything but root, and expanding u1 again re-calls d1LoadSchema', async () => {
    vi.mocked(d1ListDatabases).mockResolvedValue(twoDatabases);
    vi.mocked(d1LoadSchema).mockResolvedValue(schemaWithColumns);

    const wrapper = mountD1Panel();
    await flushPromises();

    expect(d1ListDatabases).toHaveBeenCalledTimes(1);

    const tree = wrapper.findComponent(TreeViewStub);
    const db1Node = tree.props('rows').find((r) => r.id === 'db:u1');
    expect(db1Node).toBeDefined();

    // Expand db u1 first so a schema is cached
    tree.vm.$emit('toggle', db1Node!);
    await flushPromises();

    expect(d1LoadSchema).toHaveBeenCalledTimes(1);
    expect(d1LoadSchema).toHaveBeenCalledWith('u1');
    expect(tree.props('rows').some((r) => r.id === 'tbl:u1:t')).toBe(true);

    // Select root
    const rootNode = tree.props('rows').find((r) => r.id === 'root');
    expect(rootNode).toBeDefined();
    tree.vm.$emit('select', rootNode!);
    await flushPromises();
    expect(tree.props('selectedId')).toBe('root');

    // Refresh with root selected
    const refreshBtn = wrapper.find('button[title="Refresh"]');
    await refreshBtn.trigger('click');
    await flushPromises();

    // Calls d1ListDatabases once more
    expect(d1ListDatabases).toHaveBeenCalledTimes(2);

    // Discards every cached schema and collapses everything but root
    const rowsAfterRefresh = tree.props('rows');
    const rootAfter = rowsAfterRefresh.find((r) => r.id === 'root');
    expect(rootAfter?.expanded).toBe(true);

    const db1After = rowsAfterRefresh.find((r) => r.id === 'db:u1');
    expect(db1After?.expanded).toBe(false);
    expect(rowsAfterRefresh.some((r) => r.id === 'tbl:u1:t')).toBe(false);

    // Expanding u1 again calls d1LoadSchema AGAIN
    tree.vm.$emit('toggle', db1After!);
    await flushPromises();

    expect(d1LoadSchema).toHaveBeenCalledTimes(2);
    expect(d1LoadSchema).toHaveBeenLastCalledWith('u1');
    expect(tree.props('rows').some((r) => r.id === 'tbl:u1:t')).toBe(true);
  });

  it('refresh with a database (or one of its table/column rows) selected calls d1LoadSchema once for THAT database only, does not call d1ListDatabases, and keeps the expansion', async () => {
    vi.mocked(d1ListDatabases).mockResolvedValue(twoDatabases);
    vi.mocked(d1LoadSchema).mockResolvedValue(schemaWithColumns);

    const wrapper = mountD1Panel();
    await flushPromises();

    expect(d1ListDatabases).toHaveBeenCalledTimes(1);

    const tree = wrapper.findComponent(TreeViewStub);
    const db1Node = tree.props('rows').find((r) => r.id === 'db:u1');
    tree.vm.$emit('toggle', db1Node!);
    await flushPromises();

    expect(d1LoadSchema).toHaveBeenCalledTimes(1);
    expect(d1LoadSchema).toHaveBeenCalledWith('u1');

    // 1. Refresh with database selected
    tree.vm.$emit('select', db1Node!);
    await flushPromises();
    expect(tree.props('selectedId')).toBe('db:u1');

    const refreshBtn = wrapper.find('button[title="Refresh"]');
    await refreshBtn.trigger('click');
    await flushPromises();

    expect(d1LoadSchema).toHaveBeenCalledTimes(2);
    expect(d1LoadSchema).toHaveBeenLastCalledWith('u1');
    expect(d1ListDatabases).toHaveBeenCalledTimes(1);

    let rows = tree.props('rows');
    expect(rows.find((r) => r.id === 'db:u1')?.expanded).toBe(true);
    expect(rows.some((r) => r.id === 'tbl:u1:t')).toBe(true);

    // 2. Refresh with table row selected
    const tblNode = rows.find((r) => r.id === 'tbl:u1:t');
    expect(tblNode).toBeDefined();
    tree.vm.$emit('select', tblNode!);
    await flushPromises();
    expect(tree.props('selectedId')).toBe('tbl:u1:t');

    await refreshBtn.trigger('click');
    await flushPromises();

    expect(d1LoadSchema).toHaveBeenCalledTimes(3);
    expect(d1LoadSchema).toHaveBeenLastCalledWith('u1');
    expect(d1ListDatabases).toHaveBeenCalledTimes(1);

    rows = tree.props('rows');
    expect(rows.find((r) => r.id === 'db:u1')?.expanded).toBe(true);
    expect(rows.some((r) => r.id === 'tbl:u1:t')).toBe(true);

    // 3. Refresh with column row selected
    tree.vm.$emit('toggle', tblNode!);
    await flushPromises();
    rows = tree.props('rows');
    const colNode = rows.find((r) => r.id === 'col:u1:t:id');
    expect(colNode).toBeDefined();
    tree.vm.$emit('select', colNode!);
    await flushPromises();
    expect(tree.props('selectedId')).toBe('col:u1:t:id');

    await refreshBtn.trigger('click');
    await flushPromises();

    expect(d1LoadSchema).toHaveBeenCalledTimes(4);
    expect(d1LoadSchema).toHaveBeenLastCalledWith('u1');
    expect(d1ListDatabases).toHaveBeenCalledTimes(1);

    rows = tree.props('rows');
    expect(rows.find((r) => r.id === 'db:u1')?.expanded).toBe(true);
    expect(rows.some((r) => r.id === 'tbl:u1:t')).toBe(true);
  });

  it('selecting a db row sets active database used by Run, changing select to u2 uses u2, and select starts on (select a database)', async () => {
    vi.mocked(d1ListDatabases).mockResolvedValue(twoDatabases);

    const wrapper = mountD1Panel();
    await flushPromises();

    const select = wrapper.find('select');
    const selectEl = select.element as HTMLSelectElement;

    // Starts on the empty '(select a database)' option
    expect(select.findAll('option')[0].text()).toBe('(select a database)');
    expect(selectEl.selectedIndex).toBe(0);
    expect(select.findAll('option')[0].element.selected).toBe(true);
    // Selecting a db row sets the active database used by Run
    const tree = wrapper.findComponent(TreeViewStub);
    const db1Node = tree.props('rows').find((r) => r.id === 'db:u1');
    expect(db1Node).toBeDefined();

    tree.vm.$emit('select', db1Node!);
    await flushPromises();

    expect(selectEl.value).toBe('u1');

    const runBtn = wrapper.find('button.default');
    await runBtn.trigger('click');
    await flushPromises();

    expect(d1Query).toHaveBeenCalledTimes(1);
    expect(d1Query).toHaveBeenCalledWith('u1', '');

    // Changing the 'Database:' <select> to u2 makes the next Run use u2
    await select.setValue('u2');
    await flushPromises();
    expect(selectEl.value).toBe('u2');

    await runBtn.trigger('click');
    await flushPromises();

    expect(d1Query).toHaveBeenCalledTimes(2);
    expect(d1Query).toHaveBeenLastCalledWith('u2', '');
  });

  it('run with selection sends only selected text, run without selection sends whole text, and Ctrl+Enter / Meta+Enter send whole text with default prevented', async () => {
    vi.mocked(d1ListDatabases).mockResolvedValue(twoDatabases);

    const wrapper = mountD1Panel();
    await flushPromises();

    await wrapper.find('select').setValue('u1');
    await flushPromises();

    const textareaWrapper = wrapper.find<HTMLTextAreaElement>('textarea');
    const textarea = textareaWrapper.element;
    const runBtn = wrapper.find('button.default');

    // Run with selection in textarea sends only selected text
    textarea.value = 'SELECT 1; SELECT 2;';
    await textareaWrapper.trigger('input');
    textarea.setSelectionRange(0, 8);

    await runBtn.trigger('click');
    await flushPromises();

    expect(d1Query).toHaveBeenCalledTimes(1);
    expect(d1Query).toHaveBeenLastCalledWith('u1', 'SELECT 1');

    // Run without selection sends whole text
    textarea.setSelectionRange(0, 0);

    await runBtn.trigger('click');
    await flushPromises();

    expect(d1Query).toHaveBeenCalledTimes(2);
    expect(d1Query).toHaveBeenLastCalledWith('u1', 'SELECT 1; SELECT 2;');

    // Whole-text variant is what Ctrl+Enter sends
    const ctrlEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    });
    textarea.dispatchEvent(ctrlEvent);
    await flushPromises();

    expect(ctrlEvent.defaultPrevented).toBe(true);
    expect(d1Query).toHaveBeenCalledTimes(3);
    expect(d1Query).toHaveBeenLastCalledWith('u1', 'SELECT 1; SELECT 2;');

    // Whole-text variant is what Meta+Enter sends
    const metaEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      metaKey: true,
      cancelable: true,
      bubbles: true,
    });
    textarea.dispatchEvent(metaEvent);
    await flushPromises();

    expect(metaEvent.defaultPrevented).toBe(true);
    expect(d1Query).toHaveBeenCalledTimes(4);
    expect(d1Query).toHaveBeenLastCalledWith('u1', 'SELECT 1; SELECT 2;');
  });

  it('while query is pending Run button is disabled and Ctrl+Enter does not send second query, re-enabled afterwards and after rejection', async () => {
    vi.mocked(d1ListDatabases).mockResolvedValue(twoDatabases);

    let resolveQuery!: (val: QueryOutcome) => void;
    let rejectQuery!: (err: unknown) => void;
    vi.mocked(d1Query).mockImplementation(
      () =>
        new Promise<QueryOutcome>((resolve, reject) => {
          resolveQuery = resolve;
          rejectQuery = reject;
        })
    );

    const wrapper = mountD1Panel();
    await flushPromises();

    await wrapper.find('select').setValue('u1');
    await flushPromises();

    const runBtn = wrapper.find('button.default');
    const runBtnEl = runBtn.element as HTMLButtonElement;
    expect(runBtnEl.disabled).toBe(false);

    // Start query
    await runBtn.trigger('click');
    expect(d1Query).toHaveBeenCalledTimes(1);

    // Disabled while query is pending
    expect(runBtnEl.disabled).toBe(true);

    // Ctrl+Enter does not send a second query
    const ctrlEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    });
    wrapper.find('textarea').element.dispatchEvent(ctrlEvent);
    await flushPromises();
    expect(d1Query).toHaveBeenCalledTimes(1);

    // Enabled again afterwards
    resolveQuery(defaultQueryOutcome);
    await flushPromises();
    expect(runBtnEl.disabled).toBe(false);

    // Also after a rejected query (errorDialog set)
    await runBtn.trigger('click');
    expect(d1Query).toHaveBeenCalledTimes(2);
    expect(runBtnEl.disabled).toBe(true);

    rejectQuery(new Error('D1 execution failed'));
    await flushPromises();

    expect(errorDialog.value).toBe('D1 execution failed');
    expect(runBtnEl.disabled).toBe(false);
  });

  it('query outcome with columns hands columns/rows to ResultGrid stub; outcome with no columns leaves grid empty and sets Executed ... status', async () => {
    vi.mocked(d1ListDatabases).mockResolvedValue(twoDatabases);

    const wrapper = mountD1Panel();
    await flushPromises();

    await wrapper.find('select').setValue('u1');
    await flushPromises();

    const outcomeWithCols: QueryOutcome = {
      columns: ['colA', 'colB'],
      rows: [
        ['valA1', 'valB1'],
        ['valA2', 'valB2'],
      ],
      result_statement: null,
      statement_count: 1,
      rows_read: 2,
      rows_written: 0,
      changes: 0,
      duration_ms: 12.5,
      limit_applied: false,
    };
    vi.mocked(d1Query).mockResolvedValueOnce(outcomeWithCols);

    await wrapper.find('button.default').trigger('click');
    await flushPromises();

    const grid = wrapper.findComponent(ResultGridStub);
    expect(grid.props('columns')).toEqual(['colA', 'colB']);
    expect(grid.props('rows')).toEqual([
      ['valA1', 'valB1'],
      ['valA2', 'valB2'],
    ]);
    expect(grid.attributes('data-columns')).toBe(JSON.stringify(['colA', 'colB']));
    expect(grid.attributes('data-rows')).toBe(
      JSON.stringify([
        ['valA1', 'valB1'],
        ['valA2', 'valB2'],
      ])
    );
    expect(status.value).toBe('2 row(s) · read 2 · written 0 · 12.5 ms');

    // Outcome with no columns leaves grid empty and sets Executed ... status
    const outcomeNoCols: QueryOutcome = {
      columns: [],
      rows: [],
      result_statement: null,
      statement_count: 2,
      rows_read: 0,
      rows_written: 5,
      changes: 5,
      duration_ms: 3.2,
      limit_applied: false,
    };
    vi.mocked(d1Query).mockResolvedValueOnce(outcomeNoCols);

    await wrapper.find('button.default').trigger('click');
    await flushPromises();

    expect(grid.props('columns')).toEqual([]);
    expect(grid.props('rows')).toEqual([]);
    expect(grid.attributes('data-columns')).toBe('[]');
    expect(grid.attributes('data-rows')).toBe('[]');
    expect(status.value).toBe(
      'Executed 2 statement(s) · 5 row(s) changed · read 0 · written 5 · 3.2 ms'
    );
  });

  it('rejected d1ListDatabases at start sets errorDialog to rejection string and leaves tree with only root row with loading cleared', async () => {
    let rejectList!: (reason: unknown) => void;
    vi.mocked(d1ListDatabases).mockImplementation(
      () =>
        new Promise<D1Database[]>((_, reject) => {
          rejectList = reject;
        })
    );

    const wrapper = mountD1Panel();

    const tree = wrapper.findComponent(TreeViewStub);
    const rootPending = tree.props('rows').find((r) => r.id === 'root');
    expect(rootPending?.loading).toBe(true);

    rejectList('Failed to list databases from Cloudflare API');
    await flushPromises();

    expect(errorDialog.value).toBe('Failed to list databases from Cloudflare API');

    const rows = tree.props('rows');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('root');
    expect(rows[0].loading).toBe(false);
  });
});
