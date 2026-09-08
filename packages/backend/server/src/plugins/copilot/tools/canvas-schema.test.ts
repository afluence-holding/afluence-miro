import { CANVAS_MAX_LAYOUT_OBJECTS } from '@affine/realtime/canvas';
import { describe, expect, it } from 'vitest';

import { CanvasToolSchemas } from './canvas';

const destination = { type: 'existing' as const, documentId: 'doc-qa' };
const requestedScope = { bounds: { x: 0, y: 0, w: 10_000, h: 10_000 } };

function shape(index: number) {
  return {
    id: `shape-${index}`,
    kind: 'shape',
    bounds: { x: index * 24, y: 0, w: 20, h: 20 },
    props: { shapeType: 'rect' },
  };
}

describe('canvas tool schema', () => {
  it('accepts a 201-node layout under the shared 500-object inspection limit', () => {
    const result = CanvasToolSchemas.canvas_layout.safeParse({
      destination,
      baseContentRevision: 'canvas:v1:qa',
      requestedScope,
      nodes: Array.from({ length: 201 }, (_, index) => shape(index)),
      options: { mode: 'row' },
    });

    expect(CANVAS_MAX_LAYOUT_OBJECTS).toBe(500);
    expect(result.success).toBe(true);
  });
});
