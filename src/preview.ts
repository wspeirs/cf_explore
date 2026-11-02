export interface PreviewCache {
  get(key: string): Uint8Array | undefined;
  set(key: string, data: Uint8Array): void;
  has(key: string): boolean;
  delete(key: string): boolean;
  clear(): void;
  readonly size: number;
}

export function createPreviewCache(max = 16): PreviewCache {
  const map = new Map<string, Uint8Array>();
  return {
    get(key: string): Uint8Array | undefined {
      if (!map.has(key)) return undefined;
      const val = map.get(key)!;
      map.delete(key);
      map.set(key, val);
      return val;
    },
    set(key: string, data: Uint8Array): void {
      if (map.has(key)) {
        map.delete(key);
      }
      map.set(key, data);
      while (map.size > max) {
        const oldestKey = map.keys().next().value;
        if (oldestKey !== undefined) {
          map.delete(oldestKey);
        } else {
          break;
        }
      }
    },
    has(key: string): boolean {
      return map.has(key);
    },
    delete(key: string): boolean {
      return map.delete(key);
    },
    clear(): void {
      map.clear();
    },
    get size(): number {
      return map.size;
    },
  };
}

export function initialRange(size: number): [number, number] | null {
  if (size <= 0) return null;
  return [0, Math.min(size, 4096) - 1];
}

export function showMoreRange(size: number, loaded: number): [number, number] | null {
  const maxEnd = Math.min(size, 1048576) - 1;
  if (loaded > maxEnd) return null;
  return [loaded, maxEnd];
}
