export function formatBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  const kb = n / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  const mb = kb / 1024;
  if (mb < 1024) {
    return `${mb.toFixed(1)} MB`;
  }
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}

export function hexDump(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return '';
  }

  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const chunk = bytes.subarray(offset, Math.min(offset + 16, bytes.length));
    const offsetStr = offset.toString(16).padStart(8, '0');

    const g1: string[] = [];
    for (let i = 0; i < 8; i++) {
      if (i < chunk.length) {
        g1.push(chunk[i].toString(16).padStart(2, '0'));
      } else {
        g1.push('  ');
      }
    }

    const g2: string[] = [];
    for (let i = 8; i < 16; i++) {
      if (i < chunk.length) {
        g2.push(chunk[i].toString(16).padStart(2, '0'));
      } else {
        g2.push('  ');
      }
    }

    let ascii = '';
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];
      ascii += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.';
    }

    lines.push(`${offsetStr}  ${g1.join(' ')}  ${g2.join(' ')}  |${ascii}|`);
  }

  return lines.join('\n');
}

export function decodePreview(
  bytes: Uint8Array,
  truncated: boolean
): { kind: 'text' | 'hex'; text: string } {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text: string | null = null;

  try {
    text = decoder.decode(bytes);
  } catch {
    if (truncated) {
      for (let cut = 1; cut <= 3 && cut < bytes.length; cut++) {
        try {
          text = decoder.decode(bytes.subarray(0, bytes.length - cut));
          break;
        } catch {
          // retry next cut
        }
      }
    }
  }

  if (text !== null && !text.includes('\u0000')) {
    return { kind: 'text', text };
  }

  return { kind: 'hex', text: hexDump(bytes) };
}
