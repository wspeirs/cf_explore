// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { unref } from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import TreeView from './TreeView.vue';
import type { TreeNode } from '../types';
import { ICONS } from '../icons';
import { status, settingsStatus, settingsVersion, errorDialog } from '../state';

interface VirtualizerConfig {
  count: number;
  getScrollElement: () => HTMLDivElement | null;
  estimateSize: (index?: number) => number;
  overscan: number;
  getItemKey: (index: number) => string | number;
}

vi.mock('@tanstack/vue-virtual', async () => {
  // Dynamic import inside vi.mock factory: Vitest hoists mock factories above top-level static imports.
  const { unref: vueUnref, computed } = await import('vue');
  const mockUseVirtualizer = vi.fn((optionsRef: unknown) => {
    const v = computed(() => {
      // Library boundary: unref computed options passed by TreeView.vue
      const opts = vueUnref(optionsRef) as unknown as VirtualizerConfig | undefined;
      const count = opts?.count ?? 0;
      return {
        getTotalSize: () => {
          const currentOpts = vueUnref(optionsRef) as unknown as VirtualizerConfig | undefined;
          return (currentOpts?.count ?? 0) * 20;
        },
        getVirtualItems: () => {
          const currentOpts = vueUnref(optionsRef) as unknown as VirtualizerConfig | undefined;
          const currentCount = currentOpts?.count ?? 0;
          return Array.from({ length: currentCount }, (_, index) => ({
            index,
            key: currentOpts?.getItemKey ? currentOpts.getItemKey(index) : index,
            start: index * 20,
          }));
        },
      };
    });

    return Object.assign(v, {
      getTotalSize: () => v.value.getTotalSize(),
      getVirtualItems: () => v.value.getVirtualItems(),
    });
  });

  return {
    useVirtualizer: mockUseVirtualizer,
  };
});

function normalizeSvg(html: string): string {
  const container = document.createElement('div');
  container.innerHTML = html;
  return container.innerHTML;
}

const wrappers: VueWrapper[] = [];

function mountTree(props: { rows: TreeNode[]; selectedId: string | null }): VueWrapper {
  const wrapper = mount(TreeView, {
    props,
    attachTo: document.body,
  });
  wrappers.push(wrapper);
  return wrapper;
}

describe('TreeView', () => {
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

  it('renders rows in order with label text, icon SVG markup, and padding-left of depth*16 + 4 px', () => {
    const rows: TreeNode[] = [
      {
        id: 'row-0',
        label: 'Database Node',
        icon: 'database',
        depth: 0,
        expandable: true,
        expanded: false,
        loading: false,
      },
      {
        id: 'row-1',
        label: 'Table Node',
        icon: 'table',
        depth: 1,
        expandable: true,
        expanded: false,
        loading: false,
      },
      {
        id: 'row-3',
        label: 'Column Node',
        icon: 'column',
        depth: 3,
        expandable: false,
        expanded: false,
        loading: false,
      },
    ];

    const wrapper = mountTree({ rows, selectedId: null });
    const rowEls = wrapper.findAll('.tree-row');
    expect(rowEls).toHaveLength(3);

    // Row 0 (depth 0: 0 * 16 + 4 = 4px)
    const row0 = rowEls[0];
    expect((row0.element as HTMLElement).style.paddingLeft).toBe('4px');
    expect(row0.find('.tree-label').text()).toBe('Database Node');
    expect(row0.find('.tree-icon').element.innerHTML).toBe(normalizeSvg(ICONS['database']));
    expect(row0.find('.tree-icon svg').exists()).toBe(true);

    // Row 1 (depth 1: 1 * 16 + 4 = 20px)
    const row1 = rowEls[1];
    expect((row1.element as HTMLElement).style.paddingLeft).toBe('20px');
    expect(row1.find('.tree-label').text()).toBe('Table Node');
    expect(row1.find('.tree-icon').element.innerHTML).toBe(normalizeSvg(ICONS['table']));
    expect(row1.find('.tree-icon svg').exists()).toBe(true);

    // Row 2 (depth 3: 3 * 16 + 4 = 52px)
    const row2 = rowEls[2];
    expect((row2.element as HTMLElement).style.paddingLeft).toBe('52px');
    expect(row2.find('.tree-label').text()).toBe('Column Node');
    expect(row2.find('.tree-icon').element.innerHTML).toBe(normalizeSvg(ICONS['column']));
    expect(row2.find('.tree-icon svg').exists()).toBe(true);
  });

  it('shows + twisty when collapsed, minus sign when expanded, and 9px spacer without twisty text when non-expandable', () => {
    const rows: TreeNode[] = [
      {
        id: 'collapsed-node',
        label: 'Collapsed Node',
        icon: 'folder',
        depth: 0,
        expandable: true,
        expanded: false,
        loading: false,
      },
      {
        id: 'expanded-node',
        label: 'Expanded Node',
        icon: 'folder',
        depth: 0,
        expandable: true,
        expanded: true,
        loading: false,
      },
      {
        id: 'leaf-node',
        label: 'Leaf Node',
        icon: 'column',
        depth: 0,
        expandable: false,
        expanded: false,
        loading: false,
      },
    ];

    const wrapper = mountTree({ rows, selectedId: null });
    const rowEls = wrapper.findAll('.tree-row');

    // Collapsed expandable row
    const collapsedTwisty = rowEls[0].find('.tree-twisty');
    expect(collapsedTwisty.exists()).toBe(true);
    expect(collapsedTwisty.text()).toBe('+');
    expect(rowEls[0].find('.tree-spacer').exists()).toBe(false);

    // Expanded expandable row
    const expandedTwisty = rowEls[1].find('.tree-twisty');
    expect(expandedTwisty.exists()).toBe(true);
    // TreeView.vue line 57 renders the Unicode minus sign '−' (\u2212)
    expect(expandedTwisty.text()).toBe('−');
    expect(rowEls[1].find('.tree-spacer').exists()).toBe(false);

    // Non-expandable row
    expect(rowEls[2].find('.tree-twisty').exists()).toBe(false);
    const spacer = rowEls[2].find('.tree-spacer');
    expect(spacer.exists()).toBe(true);
    expect(spacer.text()).toBe('');
  });

  it('clicking twisty emits toggle once and not select; double-clicking twisty does not emit activate', async () => {
    const targetRow: TreeNode = {
      id: 'branch-1',
      label: 'Branch 1',
      icon: 'database',
      depth: 0,
      expandable: true,
      expanded: false,
      loading: false,
    };

    const wrapper = mountTree({ rows: [targetRow], selectedId: null });
    const twisty = wrapper.find('.tree-twisty');

    await twisty.trigger('click');
    expect(wrapper.emitted('toggle')).toHaveLength(1);
    expect(wrapper.emitted('toggle')?.[0]).toEqual([targetRow]);
    expect(wrapper.emitted('select')).toBeUndefined();

    await twisty.trigger('dblclick');
    expect(wrapper.emitted('activate')).toBeUndefined();
    expect(wrapper.emitted('select')).toBeUndefined();
    expect(wrapper.emitted('toggle')).toHaveLength(1);
  });

  it('clicking a row emits select once with that row, and double-clicking it emits activate', async () => {
    const targetRow: TreeNode = {
      id: 'row-select',
      label: 'Selectable Row',
      icon: 'table',
      depth: 0,
      expandable: false,
      expanded: false,
      loading: false,
    };

    const wrapper = mountTree({ rows: [targetRow], selectedId: null });
    const rowEl = wrapper.find('.tree-row');

    await rowEl.trigger('click');
    expect(wrapper.emitted('select')).toHaveLength(1);
    expect(wrapper.emitted('select')?.[0]).toEqual([targetRow]);

    await rowEl.trigger('dblclick');
    expect(wrapper.emitted('activate')).toHaveLength(1);
    expect(wrapper.emitted('activate')?.[0]).toEqual([targetRow]);
  });

  it('shows (loading…) when loading: true, and applies selected class only to matching selectedId', () => {
    const rows: TreeNode[] = [
      {
        id: 'node-loading',
        label: 'Loading Item',
        icon: 'folder',
        depth: 0,
        expandable: true,
        expanded: true,
        loading: true,
      },
      {
        id: 'node-selected',
        label: 'Selected Item',
        icon: 'table',
        depth: 0,
        expandable: false,
        expanded: false,
        loading: false,
      },
      {
        id: 'node-normal',
        label: 'Normal Item',
        icon: 'table',
        depth: 0,
        expandable: false,
        expanded: false,
        loading: false,
      },
    ];

    const wrapper = mountTree({ rows, selectedId: 'node-selected' });
    const rowEls = wrapper.findAll('.tree-row');

    // Row 0 (loading: true)
    const label0 = rowEls[0].find('.tree-label');
    expect(label0.text()).toBe('Loading Item (loading…)');
    expect(label0.classes()).not.toContain('selected');

    // Row 1 (selectedId match)
    const label1 = rowEls[1].find('.tree-label');
    expect(label1.text()).toBe('Selected Item');
    expect(label1.classes()).toContain('selected');

    // Row 2 (unselected, not loading)
    const label2 = rowEls[2].find('.tree-label');
    expect(label2.text()).toBe('Normal Item');
    expect(label2.classes()).not.toContain('selected');
  });

  it('reacts to setProps({ rows: <fewer rows> }) by re-rendering with new rows and updating spacer height', async () => {
    const initialRows: TreeNode[] = Array.from({ length: 5 }, (_, i) => ({
      id: `item-${i}`,
      label: `Item ${i}`,
      icon: 'table',
      depth: 0,
      expandable: false,
      expanded: false,
      loading: false,
    }));

    const wrapper = mountTree({ rows: initialRows, selectedId: null });

    const scrollContainer = wrapper.find('.tree-scroll > div');
    expect((scrollContainer.element as HTMLElement).style.height).toBe('100px');
    expect(wrapper.findAll('.tree-row')).toHaveLength(5);

    const fewerRows = initialRows.slice(0, 2);
    await wrapper.setProps({ rows: fewerRows });

    expect((scrollContainer.element as HTMLElement).style.height).toBe('40px');
    const remainingRows = wrapper.findAll('.tree-row');
    expect(remainingRows).toHaveLength(2);
    expect(remainingRows[0].find('.tree-label').text()).toBe('Item 0');
    expect(remainingRows[1].find('.tree-label').text()).toBe('Item 1');
  });

  it('configures virtualizer with estimateSize 20, overscan 10, and getItemKey returning row id', () => {
    const rows: TreeNode[] = [
      {
        id: 'alpha-key',
        label: 'Alpha',
        icon: 'database',
        depth: 0,
        expandable: true,
        expanded: false,
        loading: false,
      },
      {
        id: 'beta-key',
        label: 'Beta',
        icon: 'table',
        depth: 1,
        expandable: false,
        expanded: false,
        loading: false,
      },
    ];

    const wrapper = mountTree({ rows, selectedId: null });

    expect(useVirtualizer).toHaveBeenCalled();
    const calls = vi.mocked(useVirtualizer).mock.calls;
    const lastCall = calls[calls.length - 1];
    const optionsRef = lastCall[0];

    // Narrow options from the computed ref passed by TreeView.vue
    const opts = unref(optionsRef) as unknown as VirtualizerConfig;

    expect(opts.count).toBe(2);
    expect(opts.estimateSize()).toBe(20);
    expect(opts.estimateSize(0)).toBe(20);
    expect(opts.estimateSize(1)).toBe(20);
    expect(opts.overscan).toBe(10);
    expect(opts.getItemKey(0)).toBe('alpha-key');
    expect(opts.getItemKey(1)).toBe('beta-key');
    // Fallback when row at index does not exist
    expect(opts.getItemKey(42)).toBe(42);

    // Scroll element points to scrollRef
    expect(opts.getScrollElement()).toBe(wrapper.find('.tree-scroll').element);
  });
});
