import { describe, it, expect } from 'vitest';
import { initialRange, showMoreRange, createPreviewCache } from './preview';

describe('initialRange', () => {
  it('returns null for size 0', () => {
    expect(initialRange(0)).toBeNull();
  });

  it('returns [0, 0] for size 1', () => {
    expect(initialRange(1)).toEqual([0, 0]);
  });

  it('returns [0, 4095] for size 4096', () => {
    expect(initialRange(4096)).toEqual([0, 4095]);
  });

  it('returns [0, 4095] for size 10000', () => {
    expect(initialRange(10000)).toEqual([0, 4095]);
  });
});

describe('showMoreRange', () => {
  it('returns [4096, 9999] for (10000, 4096)', () => {
    expect(showMoreRange(10000, 4096)).toEqual([4096, 9999]);
  });

  it('returns [4096, 1048575] for (2097152, 4096)', () => {
    expect(showMoreRange(2097152, 4096)).toEqual([4096, 1048575]);
  });

  it('returns null for (4096, 4096)', () => {
    expect(showMoreRange(4096, 4096)).toBeNull();
  });

  it('returns null for (2097152, 1048576)', () => {
    expect(showMoreRange(2097152, 1048576)).toBeNull();
  });
});

describe('createPreviewCache', () => {
  it('evicts oldest entries in LRU order with max 16 items', () => {
    const cache = createPreviewCache(16);

    for (let i = 0; i <= 16; i++) {
      cache.set(`k${i}`, new Uint8Array([i]));
    }

    expect(cache.size).toBe(16);
    expect(cache.get('k0')).toBeUndefined();
    for (let i = 1; i <= 16; i++) {
      expect(cache.has(`k${i}`)).toBe(true);
    }

    // Touch k1 so it moves to MRU
    const valK1 = cache.get('k1');
    expect(valK1).toEqual(new Uint8Array([1]));

    // Insert k17: k2 should be evicted (as oldest) and k1 should remain
    cache.set('k17', new Uint8Array([17]));
    expect(cache.size).toBe(16);
    expect(cache.get('k2')).toBeUndefined();
    expect(cache.has('k1')).toBe(true);
    expect(cache.get('k1')).toEqual(new Uint8Array([1]));
    expect(cache.has('k17')).toBe(true);
  });
});
