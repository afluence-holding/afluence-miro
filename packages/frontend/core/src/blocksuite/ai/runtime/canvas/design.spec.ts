import type { CanvasNode } from '@affine/realtime/canvas';
import { describe, expect, it } from 'vitest';

import {
  auditCanvasVisual,
  CANVAS_TEXT_TOKENS,
  prepareDesign,
  routeCanvasConnectors,
} from './design';

function node(id: string, overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id,
    kind: 'shape',
    bounds: { x: 0, y: 0, w: 100, h: 40 },
    props: {},
    ...overrides,
  };
}

describe('canvas design preparation', () => {
  it('mide CJK y texto español largo, ajustando únicamente nodos auto', async () => {
    const measureText = async (request: { text: string }) => ({
      width: request.text.includes('日本語') ? 180 : 260,
      height: 60,
      lineHeight: 30,
      lines: 2,
    });
    const result = await prepareDesign(
      [
        node('auto', {
          layout: 'auto',
          props: { text: 'Proceso 日本語 con explicación larga' },
        }),
        node('fixed', {
          layout: 'fixed',
          props: { text: 'Una explicación española muy extensa' },
        }),
        node('outside', {
          layout: 'auto',
          props: { text: 'Texto fuera del scope' },
        }),
      ],
      { autoFit: true },
      { measureText, scope: { ids: ['auto', 'fixed'] } }
    );
    expect(result.nodes.find(item => item.id === 'auto')?.bounds).toMatchObject(
      {
        w: 220,
        h: 80,
      }
    );
    expect(
      result.nodes.find(item => item.id === 'fixed')?.bounds
    ).toMatchObject({
      w: 100,
      h: 40,
    });
    expect(result.nodes.find(item => item.id === 'outside')?.bounds).toEqual({
      x: 0,
      y: 0,
      w: 100,
      h: 40,
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'CONSTRAINT_CONFLICT',
          affectedIds: ['fixed'],
        }),
      ])
    );
  });

  it('prioriza la fuente/tamaño explícitos y expande frames auto con reserva de título', async () => {
    let requestedSize = 0;
    const result = await prepareDesign(
      [
        node('frame', {
          kind: 'frame',
          layout: 'auto',
          bounds: { x: 0, y: 0, w: 80, h: 80 },
          props: {},
        }),
        node('section', {
          parentId: 'frame',
          bounds: { x: 100, y: 100, w: 120, h: 40 },
          props: { text: 'Sección', role: 'section', fontSize: 33 },
        }),
      ],
      { density: 'ample' },
      {
        measureText: request => {
          requestedSize = request.fontSize;
          return { width: 90, height: 33, lineHeight: 33, lines: 1 };
        },
      }
    );
    expect(requestedSize).toBe(33);
    expect(CANVAS_TEXT_TOKENS.section).toBe(28);
    const frame = result.nodes.find(item => item.id === 'frame')!;
    expect(frame.bounds.w).toBeGreaterThanOrEqual(248);
    expect(frame.bounds.h).toBeGreaterThanOrEqual(201);
  });

  it('audita geometría sin atribuir puntuaciones visuales humanas y enruta con obstáculos', () => {
    const routed = routeCanvasConnectors([
      node('source', { bounds: { x: 0, y: 0, w: 80, h: 40 } }),
      node('obstacle', { bounds: { x: 120, y: 0, w: 100, h: 80 } }),
      node('target', { bounds: { x: 280, y: 0, w: 80, h: 40 } }),
      node('edge', {
        kind: 'connector',
        bounds: { x: 0, y: 0, w: 1, h: 1 },
        props: { label: 'sí' },
        sourceId: 'source',
        targetId: 'target',
      }),
    ]);
    const edge = routed.find(item => item.id === 'edge')!;
    expect(edge.props.aiRoute).toEqual(expect.any(Array));
    expect(edge.props.aiLabelAnchor).toEqual(expect.any(Object));
    const audit = auditCanvasVisual([
      node('a', { props: { rotate: 35 } }),
      node('b', { bounds: { x: 40, y: 0, w: 100, h: 40 } }),
      node('frame', {
        kind: 'frame',
        bounds: { x: 400, y: 0, w: 80, h: 80 },
      }),
      node('outside-frame', {
        parentId: 'frame',
        bounds: { x: 460, y: 60, w: 80, h: 40 },
      }),
      edge,
    ]);
    expect(audit.axes).toEqual(
      expect.objectContaining({ structure: 'pending', routes: 'pending' })
    );
    expect(audit.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'CONSTRAINT_CONFLICT' }),
        expect.objectContaining({ affectedIds: ['outside-frame', 'frame'] }),
      ])
    );
  });
});
