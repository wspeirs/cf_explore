import { describe, it, expect } from 'vitest';
import { formatBytes, hexDump, decodePreview } from './format';

describe('formatBytes', () => {
  it('formats byte boundaries correctly', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1048575)).toBe('1.0 MB');
    expect(formatBytes(1048576)).toBe('1.0 MB');
    expect(formatBytes(1073741824)).toBe('1.0 GB');
    expect(formatBytes(1099511627776)).toBe('1024.0 GB');
  });
});

describe('hexDump', () => {
  it('returns empty string for empty input', () => {
    expect(hexDump(new Uint8Array(0))).toBe('');
  });

  it('formats 16 bytes on a single line', () => {
    const bytes = new TextEncoder().encode('0123456789abcdef');
    expect(hexDump(bytes)).toBe(
      '00000000  30 31 32 33 34 35 36 37  38 39 61 62 63 64 65 66  |0123456789abcdef|'
    );
  });

  it('formats 17 bytes across two lines with proper padding', () => {
    const bytes = new TextEncoder().encode('0123456789abcdefg');
    const line1 = '00000000  30 31 32 33 34 35 36 37  38 39 61 62 63 64 65 66  |0123456789abcdef|';
    const line2 = '00000010  67' + ' '.repeat(48) + '|g|';
    expect(hexDump(bytes)).toBe(`${line1}\n${line2}`);
  });

  it('handles non-printable characters and spaces in ascii field', () => {
    const bytes = new Uint8Array([0x00, 0x7f, 0x20, 0x7e]);
    expect(hexDump(bytes)).toContain('|.. ~|');
  });
});

describe('decodePreview', () => {
  it('decodes ASCII text when truncated is false', () => {
    const bytes = new TextEncoder().encode('hello');
    expect(decodePreview(bytes, false)).toEqual({
      kind: 'text',
      text: 'hello',
    });
  });

  it('decodes UTF-8 text with multi-byte characters', () => {
    const bytes = new TextEncoder().encode('héllo €');
    expect(decodePreview(bytes, false)).toEqual({
      kind: 'text',
      text: 'héllo €',
    });
  });

  it('drops trailing incomplete UTF-8 bytes when truncated is true', () => {
    const bytes = new Uint8Array([0x61, 0xe2, 0x82]);
    expect(decodePreview(bytes, true)).toEqual({
      kind: 'text',
      text: 'a',
    });
  });

  it('falls back to hex dump for incomplete UTF-8 when truncated is false', () => {
    const bytes = new Uint8Array([0x61, 0xe2, 0x82]);
    const res = decodePreview(bytes, false);
    expect(res.kind).toBe('hex');
    expect(res.text).toBe(hexDump(bytes));
  });

  it('falls back to hex dump when NUL byte is present', () => {
    const bytes = new Uint8Array([0x61, 0x00, 0x62]);
    const res = decodePreview(bytes, false);
    expect(res.kind).toBe('hex');
    expect(res.text).toBe(hexDump(bytes));
  });

  it('falls back to hex dump when error is not at the end even if truncated is true', () => {
    const bytes = new Uint8Array([0xff, 0x61]);
    const res = decodePreview(bytes, true);
    expect(res.kind).toBe('hex');
    expect(res.text).toBe(hexDump(bytes));
  });

  it('decodes empty bytes to empty text', () => {
    const bytes = new Uint8Array(0);
    expect(decodePreview(bytes, false)).toEqual({
      kind: 'text',
      text: '',
    });
  });
});
