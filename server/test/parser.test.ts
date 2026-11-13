import { describe, expect, it } from 'vitest';
import { parseKbMarkdown } from '../src/modules/knowledge/parser.js';

describe('parseKbMarkdown', () => {
  it('extracts header fields and one chunk per ## section', () => {
    const doc = parseKbMarkdown(
      '# Refund Policy\n\nDoc ID: KB-X-001\nAudience: Agents\nVersion: 2026.07\n\n## Physical\n\nSeven days.\n\n## Software\n\nFinal sale.\n',
    );
    expect(doc).toMatchObject({ docId: 'KB-X-001', title: 'Refund Policy', audience: 'Agents', version: '2026.07' });
    expect(doc.chunks).toEqual([
      { ordinal: 0, heading: 'Refund Policy > Physical', content: 'Seven days.' },
      { ordinal: 1, heading: 'Refund Policy > Software', content: 'Final sale.' },
    ]);
    expect(doc.checksum).toHaveLength(64);
  });

  it('rejects documents without a Doc ID', () => {
    expect(() => parseKbMarkdown('# No id\n\n## A\n\ntext')).toThrow(/Doc ID/);
  });
});
