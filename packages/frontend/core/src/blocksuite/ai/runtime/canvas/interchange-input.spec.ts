/** @vitest-environment happy-dom */
import {
  type CanvasNode,
  importCanvasInterchange,
} from '@affine/realtime/canvas';
import { describe, expect, it, vi } from 'vitest';

import {
  canvasXmlParser,
  placeImportedCanvas,
  readInterchangeInput,
} from './interchange-input';

describe('canvas imports from real chat attachments', () => {
  it('resolves and decodes JSON attachments before invoking the semantic codec', async () => {
    const recipe = {
      schemaVersion: 1,
      recipeVersion: 1,
      nodes: [
        {
          id: 'a',
          kind: 'shape',
          bounds: { x: 10, y: 20, w: 100, h: 80 },
          props: { text: 'Original' },
        },
      ],
    };
    const resolve = vi.fn(async () => new Blob([JSON.stringify(recipe)]));
    const content = await readInterchangeInput(
      'recipe',
      { kind: 'artifact_handle', handle: 'cah_data,sig' },
      resolve
    );
    expect(resolve).toHaveBeenCalledWith('cah_data,sig');
    const decoded = importCanvasInterchange({ format: 'recipe', content });
    expect(decoded.ok).toBe(true);
    expect(content).toEqual(recipe);
  });
  it('parses FreeMind/OPML XML as inert data and rejects entity definitions and excessive depth', () => {
    for (const [format, xml] of [
      ['freemind', '<map><node TEXT="Idea"><node TEXT="Acción"/></node></map>'],
      [
        'opml',
        '<opml><body><outline text="Idea"><outline text="Acción"/></outline></body></opml>',
      ],
    ] as const) {
      const result = importCanvasInterchange(
        { format, content: xml },
        { xml: canvasXmlParser }
      );
      expect(result.ok).toBe(true);
    }
    expect(() =>
      canvasXmlParser.parse(
        '<!DOCTYPE node [<!ENTITY x SYSTEM "file:///etc/passwd">]><node TEXT="&x;"/>'
      )
    ).toThrow();
    expect(() =>
      canvasXmlParser.parse('<node>'.repeat(70) + '</node>'.repeat(70))
    ).toThrow();
  });
  it('places a copy at the requested origin while remapping its relationships and preserving source content', () => {
    const nodes: CanvasNode[] = [
      {
        id: 'a',
        kind: 'shape',
        bounds: { x: 10, y: 20, w: 100, h: 80 },
        props: { text: 'a' },
      },
      {
        id: 'b',
        kind: 'shape',
        bounds: { x: 200, y: 20, w: 100, h: 80 },
        props: { text: 'b' },
      },
      {
        id: 'e',
        kind: 'connector',
        bounds: { x: 110, y: 60, w: 90, h: 1 },
        props: {},
        sourceId: 'a',
        targetId: 'b',
      },
    ];
    const original = structuredClone(nodes);
    let next = 0;
    const placed = placeImportedCanvas(
      nodes,
      { x: 800, y: 500, w: 500, h: 200 },
      () => `copy-${++next}`
    );
    expect(placed.nodes[0].bounds).toMatchObject({ x: 800, y: 500 });
    expect(placed.nodes[2]).toMatchObject({
      sourceId: 'copy-1',
      targetId: 'copy-2',
    });
    expect(nodes).toEqual(original);
  });
});
