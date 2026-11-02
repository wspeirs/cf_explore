// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import App from './App.vue';
import { loadSettings, saveSettings } from './api';
import { getVersion } from '@tauri-apps/api/app';
import { listen } from '@tauri-apps/api/event';
import { status, settingsStatus, settingsVersion, errorDialog } from './state';
import type { SettingsStatus } from './types';

vi.mock('./api', () => ({
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
}));

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

const D1PanelStub = defineComponent({
  name: 'D1Panel',
  render: () => h('div', { 'data-testid': 'd1-panel' }),
});

const R2PanelStub = defineComponent({
  name: 'R2Panel',
  props: {
    active: {
      type: Boolean,
      default: false,
    },
  },
  setup(props) {
    return () =>
      h('div', {
        'data-testid': 'r2-panel',
        'data-active': String(props.active),
      });
  },
});

const defaultMountOptions = {
  global: {
    stubs: {
      D1Panel: D1PanelStub,
      R2Panel: R2PanelStub,
    },
  },
};

type MenuEventHandler = (event: { payload: string }) => void;

describe('App', () => {
  const wrappers: VueWrapper[] = [];
  let unlistenSpy: ReturnType<typeof vi.fn>;
  let capturedMenuHandler: MenuEventHandler | null = null;
  let execCommandMock: ReturnType<typeof vi.fn>;

  const configuredResponse: SettingsStatus = {
    settings: {
      account_id: 'acc_123',
      api_token: 'tok_abc',
      r2_access_key_id: 'r2_key',
      r2_secret_access_key: 'r2_secret',
    },
    configured: true,
    r2_configured: true,
  };

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

    unlistenSpy = vi.fn();
    capturedMenuHandler = null;
    vi.mocked(listen).mockImplementation(async (event: string, handler: unknown) => {
      if (event === 'menu') {
        capturedMenuHandler = handler as MenuEventHandler;
      }
      return unlistenSpy;
    });

    vi.mocked(getVersion).mockResolvedValue('1.2.3');
    vi.mocked(loadSettings).mockResolvedValue(configuredResponse);

    execCommandMock = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', {
      value: execCommandMock,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    for (const w of wrappers) {
      w.unmount();
    }
    wrappers.length = 0;
    document.body.innerHTML = '';
  });

  it('opens Settings dialog and sets unconfigured status when loadSettings is unconfigured', async () => {
    vi.mocked(loadSettings).mockResolvedValue({
      settings: null,
      configured: false,
      r2_configured: false,
    });

    const wrapper = mount(App, defaultMountOptions);
    wrappers.push(wrapper);
    await flushPromises();

    const titles = wrapper.findAll('.title-bar-text').map((el) => el.text());
    expect(titles).toContain('Settings');
    expect(status.value).toBe('Not configured: use File › Settings...');
  });

  it('leaves dialogs closed and updates settingsStatus on configured start', async () => {
    const wrapper = mount(App, defaultMountOptions);
    wrappers.push(wrapper);
    await flushPromises();

    const overlays = wrapper.findAll('.modal-overlay');
    expect(overlays.length).toBe(0);
    expect(settingsStatus.value).toEqual(configuredResponse);
  });

  it('shows Error dialog and opens Settings dialog when loadSettings rejects, and clears errorDialog on OK', async () => {
    vi.mocked(loadSettings).mockRejectedValue('broken file');

    const wrapper = mount(App, defaultMountOptions);
    wrappers.push(wrapper);
    await flushPromises();

    const titles = wrapper.findAll('.title-bar-text').map((el) => el.text());
    expect(titles).toContain('Error');
    expect(titles).toContain('Settings');
    expect(errorDialog.value).toBe('broken file');

    const errorDialogEl = wrapper
      .findAll('.modal-overlay')
      .find((overlay) => overlay.find('.title-bar-text').text() === 'Error');
    expect(errorDialogEl).toBeDefined();
    expect(errorDialogEl?.text()).toContain('broken file');

    const errorOkBtn = errorDialogEl!.findAll('button').find((b) => b.text() === 'OK');
    expect(errorOkBtn).toBeDefined();
    await errorOkBtn!.trigger('click');
    await flushPromises();

    expect(errorDialog.value).toBeNull();
  });

  it('handles menu events for about, settings, and clipboard commands', async () => {
    const wrapper = mount(App, defaultMountOptions);
    wrappers.push(wrapper);
    await flushPromises();

    expect(capturedMenuHandler).not.toBeNull();

    // payload: 'about' opens About with version, description, and font credit
    capturedMenuHandler!({ payload: 'about' });
    await flushPromises();

    const aboutDialog = wrapper
      .findAll('.modal-overlay')
      .find((overlay) => overlay.find('.title-bar-text').text() === 'About cf_explore');
    expect(aboutDialog).toBeDefined();

    expect(aboutDialog!.find('strong').text()).toBe('cf_explore v1.2.3');
    expect(aboutDialog!.text()).toContain(
      'A lightweight explorer for Cloudflare D1 databases and R2 buckets.'
    );
    expect(aboutDialog!.text()).toContain(
      'Font: “MS Sans Serif” by lou (FontStruct), CC BY-SA 3.0.'
    );

    // About OK button closes it
    const aboutOkBtn = aboutDialog!.findAll('button').find((b) => b.text() === 'OK');
    expect(aboutOkBtn).toBeDefined();
    await aboutOkBtn!.trigger('click');
    await flushPromises();

    expect(
      wrapper.findAll('.title-bar-text').map((el) => el.text())
    ).not.toContain('About cf_explore');

    // payload: 'settings' opens Settings
    capturedMenuHandler!({ payload: 'settings' });
    await flushPromises();

    const settingsDialog = wrapper
      .findAll('.modal-overlay')
      .find((overlay) => overlay.find('.title-bar-text').text() === 'Settings');
    expect(settingsDialog).toBeDefined();

    // Close Settings dialog
    const cancelBtn = settingsDialog!.findAll('button').find((b) => b.text() === 'Cancel');
    expect(cancelBtn).toBeDefined();
    await cancelBtn!.trigger('click');
    await flushPromises();

    // payloads 'cut' / 'copy' / 'paste' call document.execCommand
    capturedMenuHandler!({ payload: 'cut' });
    expect(execCommandMock).toHaveBeenCalledWith('cut');

    capturedMenuHandler!({ payload: 'copy' });
    expect(execCommandMock).toHaveBeenCalledWith('copy');

    capturedMenuHandler!({ payload: 'paste' });
    expect(execCommandMock).toHaveBeenCalledWith('paste');

    // When execCommand returns false, status is updated
    execCommandMock.mockReturnValue(false);
    capturedMenuHandler!({ payload: 'copy' });
    expect(status.value).toBe(
      'Clipboard command unavailable; use Ctrl+X / Ctrl+C / Ctrl+V'
    );

    // An unknown payload does nothing
    execCommandMock.mockClear();
    status.value = 'Ready';
    capturedMenuHandler!({ payload: 'unknown_command' });
    expect(execCommandMock).not.toHaveBeenCalled();
    expect(status.value).toBe('Ready');
  });

  it('opens About showing cf_explore without version suffix and still loads settings when getVersion rejects', async () => {
    vi.mocked(getVersion).mockRejectedValue(new Error('version lookup failed'));

    const wrapper = mount(App, defaultMountOptions);
    wrappers.push(wrapper);
    await flushPromises();

    expect(loadSettings).toHaveBeenCalledTimes(1);

    expect(capturedMenuHandler).not.toBeNull();
    capturedMenuHandler!({ payload: 'about' });
    await flushPromises();

    const aboutDialog = wrapper
      .findAll('.modal-overlay')
      .find((overlay) => overlay.find('.title-bar-text').text() === 'About cf_explore');
    expect(aboutDialog).toBeDefined();
    expect(aboutDialog!.find('strong').text()).toBe('cf_explore');
  });

  it('selects D1 first and switches to R2 on tab click while keeping both panels mounted', async () => {
    const wrapper = mount(App, defaultMountOptions);
    wrappers.push(wrapper);
    await flushPromises();

    const tabs = wrapper.findAll('menu[role="tablist"] [role="tab"]');
    expect(tabs).toHaveLength(2);
    expect(tabs[0].attributes('aria-selected')).toBe('true');
    expect(tabs[1].attributes('aria-selected')).toBe('false');

    const d1Panel = wrapper.findComponent(D1PanelStub);
    const r2Panel = wrapper.findComponent(R2PanelStub);

    expect(d1Panel.exists()).toBe(true);
    expect(d1Panel.isVisible()).toBe(true);
    expect(r2Panel.exists()).toBe(true);
    expect(r2Panel.isVisible()).toBe(false);
    expect(r2Panel.props('active')).toBe(false);
    expect(r2Panel.attributes('data-active')).toBe('false');

    // Click R2 tab
    await tabs[1].find('a').trigger('click');
    await flushPromises();

    expect(tabs[0].attributes('aria-selected')).toBe('false');
    expect(tabs[1].attributes('aria-selected')).toBe('true');

    expect(d1Panel.exists()).toBe(true);
    expect(d1Panel.isVisible()).toBe(false);
    expect(r2Panel.exists()).toBe(true);
    expect(r2Panel.isVisible()).toBe(true);
    expect(r2Panel.props('active')).toBe(true);
    expect(r2Panel.attributes('data-active')).toBe('true');
  });

  it('cleans up listener when unmounting after listen resolves', async () => {
    const wrapper = mount(App, defaultMountOptions);
    wrappers.push(wrapper);
    await flushPromises();

    expect(unlistenSpy).not.toHaveBeenCalled();
    wrapper.unmount();
    expect(unlistenSpy).toHaveBeenCalledTimes(1);
  });

  it('cleans up listener when unmounting before listen resolves', async () => {
    const unlistenDeferredSpy = vi.fn();
    let resolveListenPromise!: (unlisten: () => void) => void;
    vi.mocked(listen).mockImplementationOnce(
      () =>
        new Promise<() => void>((resolve) => {
          resolveListenPromise = resolve;
        })
    );

    const wrapper = mount(App, defaultMountOptions);
    wrappers.push(wrapper);

    // Unmount before listen promise resolves
    wrapper.unmount();
    expect(unlistenDeferredSpy).not.toHaveBeenCalled();

    // Now resolve the promise
    resolveListenPromise(unlistenDeferredSpy);
    await flushPromises();

    expect(unlistenDeferredSpy).toHaveBeenCalledTimes(1);
  });
});
