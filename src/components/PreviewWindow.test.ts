// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import PreviewWindow, { type PreviewTarget } from './PreviewWindow.vue';
import { errorDialog, status, settingsVersion } from '../state';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const mockR2GetRange = vi.fn();

vi.mock('../api', () => ({
  r2GetRange: (...args: unknown[]) => mockR2GetRange(...args),
}));

describe('PreviewWindow', () => {
  beforeEach(() => {
    errorDialog.value = null;
    status.value = 'Ready';
    settingsVersion.value = 0;
    vi.clearAllMocks();
  });

  it('(i) cache miss issues exactly one r2GetRange and size 0 issues none showing (empty object)', async () => {
    const targetMiss: PreviewTarget = {
      bucket: 'test-bucket',
      key: 'miss.txt',
      size: 5000,
      etag: 'etag-miss-1',
    };

    const def = createDeferred<Uint8Array>();
    mockR2GetRange.mockReturnValueOnce(def.promise);

    const wrapper = mount(PreviewWindow, {
      props: { target: targetMiss },
    });

    expect(mockR2GetRange).toHaveBeenCalledTimes(1);
    expect(mockR2GetRange).toHaveBeenCalledWith('test-bucket', 'miss.txt', 0, 4095);

    def.resolve(new TextEncoder().encode('loaded text'));
    await flushPromises();

    expect(wrapper.find('pre').text()).toBe('loaded text');

    // Test size 0:
    mockR2GetRange.mockClear();
    const targetZero: PreviewTarget = {
      bucket: 'test-bucket',
      key: 'empty.txt',
      size: 0,
      etag: 'etag-zero-1',
    };

    const wrapperZero = mount(PreviewWindow, {
      props: { target: targetZero },
    });
    await flushPromises();

    expect(mockR2GetRange).not.toHaveBeenCalled();
    expect(wrapperZero.find('pre').text()).toBe('(empty object)');
  });

  it('(ii) stale response: discards late response for earlier target while caching under original key', async () => {
    const targetA: PreviewTarget = {
      bucket: 'test-bucket',
      key: 'fileA.txt',
      size: 100,
      etag: 'etag-stale-A',
    };
    const targetB: PreviewTarget = {
      bucket: 'test-bucket',
      key: 'fileB.txt',
      size: 100,
      etag: 'etag-stale-B',
    };

    // Prime cache for B
    const defB = createDeferred<Uint8Array>();
    mockR2GetRange.mockReturnValueOnce(defB.promise);
    const wrapperPrime = mount(PreviewWindow, { props: { target: targetB } });
    defB.resolve(new TextEncoder().encode('content B'));
    await flushPromises();
    wrapperPrime.unmount();
    mockR2GetRange.mockClear();

    // Open A (pending in-flight)
    const defA = createDeferred<Uint8Array>();
    mockR2GetRange.mockReturnValueOnce(defA.promise);
    const wrapper = mount(PreviewWindow, { props: { target: targetA } });
    expect(mockR2GetRange).toHaveBeenCalledTimes(1);
    expect(mockR2GetRange).toHaveBeenCalledWith('test-bucket', 'fileA.txt', 0, 99);
    mockR2GetRange.mockClear();

    // setProps to cached B
    await wrapper.setProps({ target: targetB });
    await flushPromises();
    expect(mockR2GetRange).not.toHaveBeenCalled();
    expect(wrapper.find('pre').text()).toBe('content B');

    // Now resolve A
    defA.resolve(new TextEncoder().encode('content A'));
    await flushPromises();

    // Window still shows B's content
    expect(wrapper.find('pre').text()).toBe('content B');

    // And A's bytes were cached: reopening A makes 0 calls and shows content A
    mockR2GetRange.mockClear();
    await wrapper.setProps({ target: targetA });
    await flushPromises();
    expect(mockR2GetRange).not.toHaveBeenCalled();
    expect(wrapper.find('pre').text()).toBe('content A');
  });

  it('(iii) switching to a new target clears old bytes immediately and hides Show More while loading', async () => {
    const target1: PreviewTarget = {
      bucket: 'test-bucket',
      key: 'doc1.txt',
      size: 6000,
      etag: 'etag-switch-1',
    };
    const target2: PreviewTarget = {
      bucket: 'test-bucket',
      key: 'doc2.txt',
      size: 8000,
      etag: 'etag-switch-2',
    };

    const def1 = createDeferred<Uint8Array>();
    mockR2GetRange.mockReturnValueOnce(def1.promise);
    const wrapper = mount(PreviewWindow, { props: { target: target1 } });

    def1.resolve(new Uint8Array(4096));
    await flushPromises();

    expect(wrapper.find('.preview-info').text()).toContain('Showing 4096 of 6000 bytes');
    expect(wrapper.find('a').exists()).toBe(true);

    // Switch to target2 with pending request
    const def2 = createDeferred<Uint8Array>();
    mockR2GetRange.mockReturnValueOnce(def2.promise);
    await wrapper.setProps({ target: target2 });

    // Old bytes cleared immediately and info shows 0 of 8000 bytes
    expect(wrapper.find('.preview-info').text()).toContain('Showing 0 of 8000 bytes');
    // Show More... link is not offered while loading
    expect(wrapper.find('a').exists()).toBe(false);

    def2.resolve(new Uint8Array(4096));
    await flushPromises();

    expect(wrapper.find('.preview-info').text()).toContain('Showing 4096 of 8000 bytes');
    expect(wrapper.find('a').exists()).toBe(true);
  });

  it('(iv) double-clicking Show More makes ONE request, link disappears at limit, and 1 MiB note appears', async () => {
    const targetLarge: PreviewTarget = {
      bucket: 'test-bucket',
      key: 'large.bin',
      size: 2097152, // 2 MiB
      etag: 'etag-large-1',
    };

    const defInitial = createDeferred<Uint8Array>();
    mockR2GetRange.mockReturnValueOnce(defInitial.promise);
    const wrapper = mount(PreviewWindow, { props: { target: targetLarge } });

    defInitial.resolve(new Uint8Array(4096));
    await flushPromises();

    expect(wrapper.find('a').text()).toBe('Show More...');

    // Prepare deferred for showMore
    const defMore = createDeferred<Uint8Array>();
    mockR2GetRange.mockReturnValueOnce(defMore.promise);

    const link = wrapper.find('a');
    await link.trigger('click');
    // Double click: second click while loading is in-flight
    await link.trigger('click');

    // Exactly one range request made for showMore: 4096..1048575
    expect(mockR2GetRange).toHaveBeenCalledTimes(2);
    expect(mockR2GetRange).toHaveBeenLastCalledWith('test-bucket', 'large.bin', 4096, 1048575);

    // Link is hidden while loading
    expect(wrapper.find('a').exists()).toBe(false);

    // Resolve showMore with remaining chunk up to 1048576
    const chunkSize = 1048576 - 4096;
    defMore.resolve(new Uint8Array(chunkSize));
    await flushPromises();

    // Link remains gone as loaded === 1048576
    expect(wrapper.find('a').exists()).toBe(false);

    // Note appears for size > 1 MiB
    expect(wrapper.text()).toContain(
      'Only the first 1 MiB is shown; use Download for the full object.'
    );
  });

  it('(v) Show More in flight, target changes, response arrives without RangeError, and bytes cached under old key', async () => {
    const target1: PreviewTarget = {
      bucket: 'test-bucket',
      key: 'obj1.txt',
      size: 5000,
      etag: 'etag-sm-flight-1',
    };
    const target2: PreviewTarget = {
      bucket: 'test-bucket',
      key: 'obj2.txt',
      size: 50,
      etag: 'etag-sm-flight-2',
    };

    const def1 = createDeferred<Uint8Array>();
    mockR2GetRange.mockReturnValueOnce(def1.promise);
    const wrapper = mount(PreviewWindow, { props: { target: target1 } });

    def1.resolve(new Uint8Array(4096));
    await flushPromises();

    // Start showMore for target1
    const defMore1 = createDeferred<Uint8Array>();
    mockR2GetRange.mockReturnValueOnce(defMore1.promise);
    await wrapper.find('a').trigger('click');

    // While showMore is in flight, switch to target2
    const def2 = createDeferred<Uint8Array>();
    mockR2GetRange.mockReturnValueOnce(def2.promise);
    await wrapper.setProps({ target: target2 });

    // Now showMore response for target1 arrives
    const chunkRemaining = new Uint8Array(5000 - 4096);
    chunkRemaining.fill(42);
    expect(() => {
      defMore1.resolve(chunkRemaining);
    }).not.toThrow();
    await flushPromises();

    // Nothing of old object is displayed
    expect(wrapper.find('.preview-info').text()).toContain('Showing 0 of 50 bytes');

    // Resolve target2
    def2.resolve(new TextEncoder().encode('target 2 content'));
    await flushPromises();
    expect(wrapper.find('pre').text()).toBe('target 2 content');

    // Verify combined bytes for target1 are cached under old key
    mockR2GetRange.mockClear();
    await wrapper.setProps({ target: target1 });
    await flushPromises();

    expect(mockR2GetRange).not.toHaveBeenCalled();
    expect(wrapper.find('.preview-info').text()).toContain('Showing 5000 of 5000 bytes');
  });

  it('(vi) reopening same object after Show More makes 0 calls and shows extended bytes', async () => {
    const target: PreviewTarget = {
      bucket: 'test-bucket',
      key: 'reopen.txt',
      size: 5000,
      etag: 'etag-reopen-1',
    };

    const defInitial = createDeferred<Uint8Array>();
    mockR2GetRange.mockReturnValueOnce(defInitial.promise);
    const wrapper = mount(PreviewWindow, { props: { target } });

    defInitial.resolve(new TextEncoder().encode('A'.repeat(4096)));
    await flushPromises();

    const defMore = createDeferred<Uint8Array>();
    mockR2GetRange.mockReturnValueOnce(defMore.promise);
    await wrapper.find('a').trigger('click');

    defMore.resolve(new TextEncoder().encode('B'.repeat(5000 - 4096)));
    await flushPromises();

    expect(wrapper.find('.preview-info').text()).toContain('Showing 5000 of 5000 bytes');
    expect(wrapper.find('pre').text()).toBe('A'.repeat(4096) + 'B'.repeat(904));

    // Clear target and reopen
    await wrapper.setProps({ target: null });
    await flushPromises();

    mockR2GetRange.mockClear();
    await wrapper.setProps({ target });
    await flushPromises();

    expect(mockR2GetRange).not.toHaveBeenCalled();
    expect(wrapper.find('.preview-info').text()).toContain('Showing 5000 of 5000 bytes');
    expect(wrapper.find('pre').text()).toBe('A'.repeat(4096) + 'B'.repeat(904));
  });

  it('(vii) rejected r2GetRange sets errorDialog and leaves window usable', async () => {
    const targetFail: PreviewTarget = {
      bucket: 'test-bucket',
      key: 'error.txt',
      size: 200,
      etag: 'etag-fail-1',
    };

    mockR2GetRange.mockRejectedValueOnce(new Error('Cloudflare network timeout'));
    const wrapper = mount(PreviewWindow, { props: { target: targetFail } });
    await flushPromises();

    expect(errorDialog.value).toBe('Cloudflare network timeout');

    // Window is still usable: close button emits close
    await wrapper.find('.title-bar-controls button').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);

    // Switching to a successful target works
    const targetSuccess: PreviewTarget = {
      bucket: 'test-bucket',
      key: 'recover.txt',
      size: 100,
      etag: 'etag-recover-1',
    };
    mockR2GetRange.mockResolvedValueOnce(new TextEncoder().encode('recovered'));
    await wrapper.setProps({ target: targetSuccess });
    await flushPromises();

    expect(wrapper.find('pre').text()).toBe('recovered');
  });
});
