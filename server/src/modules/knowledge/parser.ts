import { sha256 } from '../../lib/ids.js';

export type ParsedDoc = {
  docId: string;
  title: string;
  audience: string;
  version: string;
  content: string;
  checksum: string;
  chunks: Array<{ ordinal: number; heading: string; content: string }>;
};

/**
 * Parses the KB markdown format:
 *   # Title / Doc ID: X / Audience: Y / Version: Z / ## Section ...
 * One chunk per "##" section; heading is "Title > Section" so the title is searchable.
 */
export function parseKbMarkdown(markdown: string): ParsedDoc {
  const text = markdown.replace(/\r\n/g, '\n').trim();
  const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const docId = text.match(/^Doc ID:\s*(\S+)/m)?.[1]?.trim();
  const audience = text.match(/^Audience:\s*(.+)$/m)?.[1]?.trim() ?? 'unknown';
  const version = text.match(/^Version:\s*(.+)$/m)?.[1]?.trim() ?? 'unversioned';
  if (!title || !docId) throw new Error('KB document is missing "# Title" or "Doc ID:" header');

  const sections = text.split(/^##\s+/m).slice(1);
  const chunks = sections
    .map((section, i) => {
      const [headingLine, ...rest] = section.split('\n');
      return { ordinal: i, heading: `${title} > ${headingLine.trim()}`, content: rest.join('\n').trim() };
    })
    .filter((c) => c.content.length > 0);

  return { docId, title, audience, version, content: text, checksum: sha256(text), chunks };
}
