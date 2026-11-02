// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import SettingsDialog from './SettingsDialog.vue';
import { saveSettings } from '../api';
import { status, settingsStatus, settingsVersion } from '../state';
import type { SettingsStatus } from '../types';

vi.mock('../api', () => ({
  saveSettings: vi.fn(),
}));

describe('SettingsDialog', () => {
  const wrappers: VueWrapper[] = [];

  beforeEach(() => {
    status.value = 'Ready';
    settingsStatus.value = {
      settings: {
        account_id: 'initial_acc',
        api_token: 'initial_token',
        r2_access_key_id: 'initial_r2_key',
        r2_secret_access_key: 'initial_r2_secret',
      },
      configured: true,
      r2_configured: true,
    };
    settingsVersion.value = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const w of wrappers) {
      w.unmount();
    }
    wrappers.length = 0;
    document.body.innerHTML = '';
  });

  it('prefills from settingsStatus and typing does not mutate settingsStatus until save succeeds', async () => {
    const wrapper = mount(SettingsDialog);
    wrappers.push(wrapper);

    expect(wrapper.find<HTMLInputElement>('#account_id').element.value).toBe('initial_acc');
    expect(wrapper.find<HTMLInputElement>('#api_token').element.value).toBe('initial_token');
    expect(wrapper.find<HTMLInputElement>('#r2_access_key_id').element.value).toBe('initial_r2_key');
    expect(wrapper.find<HTMLInputElement>('#r2_secret_access_key').element.value).toBe(
      'initial_r2_secret'
    );

    await wrapper.find('#account_id').setValue('modified_acc');
    await wrapper.find('#api_token').setValue('modified_token');
    await wrapper.find('#r2_access_key_id').setValue('modified_r2_key');
    await wrapper.find('#r2_secret_access_key').setValue('modified_r2_secret');

    expect(settingsStatus.value.settings).toEqual({
      account_id: 'initial_acc',
      api_token: 'initial_token',
      r2_access_key_id: 'initial_r2_key',
      r2_secret_access_key: 'initial_r2_secret',
    });
  });

  it('submits with typed snake_case fields and updates state and emits close on success', async () => {
    const savedResponse: SettingsStatus = {
      settings: {
        account_id: 'new_acc',
        api_token: 'new_token',
        r2_access_key_id: 'new_r2_key',
        r2_secret_access_key: 'new_r2_secret',
      },
      configured: true,
      r2_configured: true,
    };
    vi.mocked(saveSettings).mockResolvedValue(savedResponse);

    const wrapper = mount(SettingsDialog);
    wrappers.push(wrapper);

    await wrapper.find('#account_id').setValue('new_acc');
    await wrapper.find('#api_token').setValue('new_token');
    await wrapper.find('#r2_access_key_id').setValue('new_r2_key');
    await wrapper.find('#r2_secret_access_key').setValue('new_r2_secret');

    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(saveSettings).toHaveBeenCalledWith({
      account_id: 'new_acc',
      api_token: 'new_token',
      r2_access_key_id: 'new_r2_key',
      r2_secret_access_key: 'new_r2_secret',
    });
    expect(settingsStatus.value).toEqual(savedResponse);
    expect(settingsVersion.value).toBe(1);
    expect(status.value).toBe('Settings saved');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('handles string and Error rejections inline, preserves state, and remains usable for retry', async () => {
    const initialSettingsSnapshot = { ...settingsStatus.value };
    const initialVersion = settingsVersion.value;

    vi.mocked(saveSettings).mockRejectedValueOnce('bad token');

    const wrapper = mount(SettingsDialog);
    wrappers.push(wrapper);

    await wrapper.find('form').trigger('submit');
    await flushPromises();

    const badTokenEl = wrapper.findAll('p').find((p) => p.text() === 'bad token');
    expect(badTokenEl).toBeDefined();
    expect(badTokenEl?.exists()).toBe(true);

    expect(wrapper.emitted('close')).toBeUndefined();
    expect(settingsVersion.value).toBe(initialVersion);
    expect(settingsStatus.value).toEqual(initialSettingsSnapshot);

    // Dialog stays usable: second submit succeeds after mock resolves
    const retryResponse: SettingsStatus = {
      settings: {
        account_id: 'initial_acc',
        api_token: 'initial_token',
        r2_access_key_id: 'initial_r2_key',
        r2_secret_access_key: 'initial_r2_secret',
      },
      configured: true,
      r2_configured: true,
    };
    vi.mocked(saveSettings).mockResolvedValueOnce(retryResponse);

    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(saveSettings).toHaveBeenCalledTimes(2);
    expect(wrapper.emitted('close')).toHaveLength(1);
    expect(settingsStatus.value).toEqual(retryResponse);
    expect(settingsVersion.value).toBe(initialVersion + 1);

    // Also an Error('boom') rejection shows 'boom'
    const wrapperBoom = mount(SettingsDialog);
    wrappers.push(wrapperBoom);

    vi.mocked(saveSettings).mockRejectedValueOnce(new Error('boom'));
    await wrapperBoom.find('form').trigger('submit');
    await flushPromises();

    const boomEl = wrapperBoom.findAll('p').find((p) => p.text() === 'boom');
    expect(boomEl).toBeDefined();
    expect(boomEl?.exists()).toBe(true);
  });

  it('disables the OK button while saveSettings is pending and does not submit twice', async () => {
    let resolveSave!: (res: SettingsStatus) => void;
    vi.mocked(saveSettings).mockImplementation(
      () =>
        new Promise<SettingsStatus>((resolve) => {
          resolveSave = resolve;
        })
    );

    const wrapper = mount(SettingsDialog, { attachTo: document.body });
    wrappers.push(wrapper);

    const okButton = wrapper.find<HTMLButtonElement>('button.default');
    expect(okButton.text()).toBe('OK');
    expect(okButton.element.disabled).toBe(false);

    okButton.element.click();
    await flushPromises();

    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(okButton.element.disabled).toBe(true);

    // Attempt second submit while pending
    okButton.element.click();
    await flushPromises();

    expect(saveSettings).toHaveBeenCalledTimes(1);

    resolveSave({
      settings: null,
      configured: true,
      r2_configured: false,
    });
    await flushPromises();
  });

  it('emits close on Cancel without calling saveSettings', async () => {
    const wrapper = mount(SettingsDialog);
    wrappers.push(wrapper);

    const cancelButton = wrapper.findAll('button').find((b) => b.text() === 'Cancel');
    expect(cancelButton).toBeDefined();
    expect(cancelButton?.exists()).toBe(true);

    await cancelButton!.trigger('click');

    expect(wrapper.emitted('close')).toHaveLength(1);
    expect(saveSettings).not.toHaveBeenCalled();
  });
});
