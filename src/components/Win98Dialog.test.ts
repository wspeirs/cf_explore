// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import Win98Dialog from './Win98Dialog.vue';

describe('Win98Dialog', () => {
  const wrappers: VueWrapper[] = [];

  afterEach(() => {
    for (const w of wrappers) {
      try {
        w.unmount();
      } catch {
        // ignore if already unmounted
      }
    }
    wrappers.length = 0;
    document.body.innerHTML = '';
  });

  it('only closes the top-most dialog on Escape and closes lower dialog after top unmounts', () => {
    const wrapperA = mount(Win98Dialog, {
      props: { title: 'Dialog A' },
      attachTo: document.body,
    });
    wrappers.push(wrapperA);

    const wrapperB = mount(Win98Dialog, {
      props: { title: 'Dialog B' },
      attachTo: document.body,
    });
    wrappers.push(wrapperB);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(wrapperB.emitted('close')).toHaveLength(1);
    expect(wrapperA.emitted('close')).toBeUndefined();

    wrapperB.unmount();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(wrapperA.emitted('close')).toHaveLength(1);
  });

  it('one Escape closes only one dialog even when the top one is removed from the DOM before the lower one is notified', () => {
    // A native key event flushes Vue's DOM updates between listeners. Reproduce that order: the top dialog
    // (B, last in the DOM) registered its listener FIRST and its close handler removes it from the DOM at once.
    const containerB = document.createElement('div');
    document.body.appendChild(containerB);
    const containerA = document.createElement('div');
    document.body.insertBefore(containerA, containerB);

    const closedA = vi.fn();
    const closedB = vi.fn();
    const wrapperB: VueWrapper = mount(Win98Dialog, {
      props: {
        title: 'Dialog B',
        onClose: () => {
          closedB();
          wrapperB.unmount();
        },
      },
      attachTo: containerB,
    });
    wrappers.push(wrapperB);
    const wrapperA = mount(Win98Dialog, { props: { title: 'Dialog A', onClose: closedA }, attachTo: containerA });
    wrappers.push(wrapperA);

    // Real key events are cancelable; a handled event must not reach the lower dialog's handler as "unhandled".
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));

    expect(closedB).toHaveBeenCalledTimes(1);
    expect(closedA).not.toHaveBeenCalled();

    // The next Escape closes the remaining dialog.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(closedA).toHaveBeenCalledTimes(1);
  });

  it('does not emit close on a non-Escape key', () => {
    const wrapper = mount(Win98Dialog, {
      props: { title: 'Test Dialog' },
      attachTo: document.body,
    });
    wrappers.push(wrapper);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));

    expect(wrapper.emitted('close')).toBeUndefined();
  });

  it('does not react to Escape once unmounted', () => {
    const wrapper = mount(Win98Dialog, {
      props: { title: 'Test Dialog' },
      attachTo: document.body,
    });
    wrappers.push(wrapper);

    wrapper.unmount();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(wrapper.emitted('close')).toBeUndefined();
  });

  it('emits close when clicking the close button', async () => {
    const wrapper = mount(Win98Dialog, {
      props: { title: 'Test Dialog' },
      attachTo: document.body,
    });
    wrappers.push(wrapper);

    await wrapper.find('button[aria-label="Close"]').trigger('click');

    expect(wrapper.emitted('close')).toHaveLength(1);
  });
});
