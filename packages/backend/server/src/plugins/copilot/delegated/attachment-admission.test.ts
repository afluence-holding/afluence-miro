import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../base', () => ({ OneMB: 1024 * 1024, OneMinute: 60_000 }));
vi.mock('../../../native', () => ({}));
vi.mock('../runtime/hosts/attachment-materializer', () => ({
  AttachmentMaterializer: class {},
}));

import { canvasInterchangeMimeType } from '../runtime/hosts/attachment-admission';

describe('canvas interchange attachment admission', () => {
  it('requires a PKZip signature and canonicalizes a native canvas bundle', () => {
    expect(
      canvasInterchangeMimeType(
        'board.bs.zip',
        Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14])
      )
    ).toBe('application/vnd.affine.canvas+zip');
    expect(() =>
      canvasInterchangeMimeType('board.bs.zip', Buffer.from('not a zip'))
    ).toThrow('PKZip');
  });

  it.each([
    ['diagram.excalidraw', 'application/vnd.excalidraw+json'],
    ['mindmap.mm', 'application/vnd.freemind'],
    ['outline.opml', 'text/x-opml'],
    ['flow.mmd', 'text/vnd.mermaid'],
    ['recipe.json', 'application/json'],
  ])('allows %s as %s without trusting browser MIME', (fileName, mimeType) => {
    expect(canvasInterchangeMimeType(fileName, Buffer.from('{}'))).toBe(
      mimeType
    );
  });
});
