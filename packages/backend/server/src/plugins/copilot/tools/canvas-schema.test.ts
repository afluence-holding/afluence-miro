import { CANVAS_MAX_LAYOUT_OBJECTS } from '@affine/realtime/canvas';
import { describe, expect, it } from 'vitest';

import { CanvasToolSchemas } from './canvas';
import { defineTool } from './tool';

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
  it('preserves optional canvas fields in the provider tool schema', () => {
    const readSchema = defineTool({
      inputSchema: CanvasToolSchemas.canvas_read,
      execute: () => undefined,
    }).jsonSchema!;
    const readProperties = readSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    const scopeSchema = readProperties.scope;
    const scopeRequired = scopeSchema.required as string[] | undefined;

    expect(readSchema.required).toEqual(['destination', 'scope']);
    expect(scopeRequired ?? []).not.toContain('ids');
    expect(scopeRequired ?? []).not.toContain('bounds');
    expect(scopeSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });

    const renderSchema = defineTool({
      inputSchema: CanvasToolSchemas.canvas_render,
      execute: () => undefined,
    }).jsonSchema!;
    const renderRequired = renderSchema.required as string[] | undefined;
    expect(renderRequired ?? []).not.toContain('planId');
    expect(renderRequired ?? []).not.toContain('scope');

    expect(
      CanvasToolSchemas.canvas_read.safeParse({ destination, scope: {} })
        .success
    ).toBe(true);
    expect(
      CanvasToolSchemas.canvas_render.safeParse({ destination, scope: {} })
        .success
    ).toBe(true);
  });

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

  it('describes native connector direction without reversing its endpoint markers', () => {
    const validateSchema = defineTool({
      inputSchema: CanvasToolSchemas.canvas_validate,
      execute: () => undefined,
    }).jsonSchema!;
    const schemaText = JSON.stringify(validateSchema);

    expect(schemaText).toContain('frontEndpointStyle decorates sourceId/start');
    expect(schemaText).toContain('rearEndpointStyle decorates targetId/end');
    expect(schemaText).toContain(
      'frontEndpointStyle:\\"None\\" and rearEndpointStyle:\\"Arrow\\"'
    );
  });
});
