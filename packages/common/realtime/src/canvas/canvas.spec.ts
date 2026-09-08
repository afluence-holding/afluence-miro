import { describe, expect, it } from 'vitest';

import {
  CANVAS_MAX_READ_OBJECTS,
  CANVAS_MAX_WRITE_BATCH,
  type CanvasNode,
  exportCanvasInterchange,
  importCanvasInterchange,
  layoutCanvas,
  validateCanvasNode,
  validateCanvasPlan,
  validateCanvasToolArgs,
} from './index';

function node(id: string, overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id,
    kind: 'shape',
    bounds: { x: 999, y: 999, w: 100, h: 50 },
    props: {},
    ...overrides,
  };
}

function connector(id: string, sourceId: string, targetId: string): CanvasNode {
  return node(id, {
    kind: 'connector',
    bounds: { x: 0, y: 0, w: 1, h: 1 },
    sourceId,
    targetId,
  });
}

describe('canvas contract validation', () => {
  it('acepta scope vacío como selección de todo el canvas', () => {
    const destination = { type: 'existing', documentId: 'doc' };
    const cases = [
      ['canvas_read', { destination, scope: {} }],
      ['canvas_render', { destination, scope: {} }],
      ['canvas_focus', { destination, scope: {} }],
      ['canvas_export', { destination, scope: {}, format: 'png' }],
    ] as const;

    for (const [tool, args] of cases) {
      expect(validateCanvasToolArgs(tool, args)).toMatchObject({
        ok: true,
        value: { scope: {} },
      });
    }
  });

  it('sigue rechazando propiedades desconocidas en scope', () => {
    expect(
      validateCanvasToolArgs('canvas_read', {
        destination: { type: 'existing', documentId: 'doc' },
        scope: { unexpected: true },
      })
    ).toMatchObject({ ok: false, error: { code: 'INVALID_PLAN' } });
  });

  it('rechaza geometría no finita y propiedades desconocidas', () => {
    expect(
      validateCanvasNode({
        ...node('bad'),
        bounds: { x: Number.NaN, y: 0, w: 10, h: 10 },
      })
    ).toMatchObject({ ok: false, error: { code: 'INVALID_PLAN' } });
    expect(
      validateCanvasNode({ ...node('bad'), unexpected: true })
    ).toMatchObject({
      ok: false,
      error: { code: 'INVALID_PLAN' },
    });
  });

  it('restringe lecturas y lotes al límite del contrato', () => {
    expect(
      validateCanvasToolArgs('canvas_read', {
        destination: { type: 'existing', documentId: 'doc' },
        scope: { ids: ['n1'] },
        limit: CANVAS_MAX_READ_OBJECTS + 1,
      })
    ).toMatchObject({ ok: false, error: { code: 'INVALID_PLAN' } });

    const operations = Array.from(
      { length: CANVAS_MAX_WRITE_BATCH + 1 },
      (_, index) => ({
        type: 'create',
        node: node(`n-${index}`),
      })
    );
    expect(
      validateCanvasPlan({
        schemaVersion: 1,
        planId: 'plan',
        status: 'ready',
        baseContentRevision: 'r1',
        capabilitiesVersion: 'registry-1',
        requestedScope: { ids: ['n-0'] },
        effectiveScope: { ids: ['n-0'] },
        destination: { type: 'existing', documentId: 'doc' },
        operations,
        diagnostics: [],
      })
    ).toMatchObject({ ok: false, error: { code: 'INVALID_PLAN' } });
  });
});

describe('resume de importación nativa', () => {
  it('acepta resume con operación y nuevo requestId', () => {
    expect(
      validateCanvasToolArgs('canvas_operation', {
        action: 'resume',
        operationId: 'native_import_parent',
        requestId: 'resume-request',
      })
    ).toMatchObject({ ok: true });
  });
});

describe('layoutCanvas', () => {
  it('mantiene el gap exacto entre bordes para una fila', () => {
    const result = layoutCanvas({
      nodes: [node('b'), node('a')],
      options: { mode: 'row', density: 'normal', origin: { x: 10, y: 20 } },
    });
    const [b, a] = result.nodes;
    expect(b.bounds).toMatchObject({ x: 10, y: 20 });
    expect(a.bounds.x - (b.bounds.x + b.bounds.w)).toBe(40);
  });

  it('ordena ramas por capas topológicas conservando el orden semántico de entrada', () => {
    const result = layoutCanvas({
      nodes: [
        node('root'),
        node('z-child', { bounds: { x: 0, y: 0, w: 80, h: 50 } }),
        node('a-child', { bounds: { x: 0, y: 0, w: 80, h: 50 } }),
        connector('edge-z', 'root', 'z-child'),
        connector('edge-a', 'root', 'a-child'),
      ],
      options: { mode: 'flow', density: 'normal' },
    });
    const byId = new Map(result.nodes.map(item => [item.id, item]));
    expect(byId.get('root')?.bounds.x).toBe(0);
    expect(byId.get('a-child')?.bounds.x).toBe(180);
    expect(byId.get('z-child')?.bounds.x).toBe(180);
    expect(
      byId.get('a-child')!.bounds.y - (byId.get('z-child')!.bounds.y + 50)
    ).toBe(40);
  });

  it('preserva nodos fijos y nodos fuera de scope sin deriva', () => {
    const fixed = node('fixed', {
      layout: 'fixed',
      bounds: { x: 500, y: 400, w: 100, h: 50 },
    });
    const outside = node('outside', {
      bounds: { x: 700, y: 40, w: 100, h: 50 },
    });
    const result = layoutCanvas({
      nodes: [fixed, outside, node('inside')],
      scope: { ids: ['inside'] },
      options: { mode: 'row', origin: { x: 0, y: 0 } },
    });
    const byId = new Map(result.nodes.map(item => [item.id, item]));
    expect(byId.get('inside')?.bounds).toMatchObject({ x: 0, y: 0 });
    expect(byId.get('fixed')?.bounds).toEqual(fixed.bounds);
    expect(byId.get('outside')?.bounds).toEqual(outside.bounds);
    expect(
      layoutCanvas({
        nodes: result.nodes,
        scope: { ids: ['inside'] },
        options: { mode: 'row', origin: { x: 0, y: 0 } },
      }).nodes
    ).toEqual(result.nodes);
  });
});

describe('codecs de interoperabilidad', () => {
  it('importa el subconjunto Excalidraw y conserva extremos, labels y grupos', () => {
    const result = importCanvasInterchange({
      format: 'excalidraw',
      content: {
        type: 'excalidraw',
        elements: [
          {
            id: 'a',
            type: 'rectangle',
            x: 0,
            y: 0,
            width: 100,
            height: 40,
            groupIds: ['sales'],
          },
          {
            id: 'b',
            type: 'text',
            x: 220,
            y: 0,
            width: 100,
            height: 30,
            text: 'Compra',
            groupIds: ['sales'],
          },
          {
            id: 'edge',
            type: 'arrow',
            x: 100,
            y: 10,
            width: 120,
            height: 1,
            startBinding: { elementId: 'a' },
            endBinding: { elementId: 'b' },
          },
          {
            id: 'edge-label',
            type: 'text',
            x: 130,
            y: 0,
            width: 50,
            height: 20,
            text: 'sí',
            containerId: 'edge',
          },
        ],
      },
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const byId = new Map(result.data.nodes.map(item => [item.id, item]));
    expect(byId.get('edge')).toMatchObject({
      sourceId: 'a',
      targetId: 'b',
      props: { text: 'sí' },
    });
    expect(byId.get('a')?.parentId).toBe('group:sales');
    expect(byId.get('group:sales')?.kind).toBe('group');
    expect(result.data.fidelity.entries.map(entry => entry.outcome)).toContain(
      'converted'
    );
  });

  it('rechaza entradas de intercambio malformadas o fuera del subconjunto', () => {
    expect(
      importCanvasInterchange({
        format: 'excalidraw',
        content: {
          elements: [
            {
              id: 'a',
              type: 'rectangle',
              x: 0,
              y: 0,
              width: 10,
              height: 10,
            },
            {
              id: 'a',
              type: 'rectangle',
              x: 0,
              y: 0,
              width: 10,
              height: 10,
            },
          ],
        },
      })
    ).toMatchObject({ ok: false, error: { code: 'INVALID_PLAN' } });
    expect(
      importCanvasInterchange({
        format: 'mermaid',
        content: 'flowchart LR\nclick A "https://example.com"',
      })
    ).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_CAPABILITY' } });
    expect(
      importCanvasInterchange({
        format: 'freemind',
        content: '<!DOCTYPE map [<!ENTITY x "unsafe">]><map/>',
      })
    ).toMatchObject({ ok: false, error: { code: 'INVALID_PLAN' } });
  });

  it('convierte Mermaid flowchart y emite fuente exportable sin borrar relaciones', () => {
    const imported = importCanvasInterchange({
      format: 'mermaid',
      content: 'flowchart LR\nA[Inicio] -->|sí| B[Compra]',
    });
    expect(imported).toMatchObject({ ok: true });
    if (!imported.ok) return;
    const edge = imported.data.nodes.find(item => item.kind === 'connector');
    expect(edge).toMatchObject({
      sourceId: 'A',
      targetId: 'B',
      props: { text: 'sí' },
    });
    const exported = exportCanvasInterchange({
      format: 'mermaid',
      nodes: imported.data.nodes,
    });
    expect(exported).toMatchObject({ ok: true });
    if (exported.ok) expect(exported.data.content).toContain('A -->|sí| B');
  });

  it('convierte Markdown y árboles XML solo mediante un adaptador seguro', () => {
    const markdown = importCanvasInterchange({
      format: 'markdown',
      content: '# Título\n- Una idea\n- Otra idea',
    });
    expect(markdown).toMatchObject({ ok: true });
    if (markdown.ok) expect(markdown.data.nodes).toHaveLength(3);

    const freemind = importCanvasInterchange(
      { format: 'freemind', content: '<map><node TEXT="Raíz"/></map>' },
      {
        xml: {
          parse: () => ({
            name: 'map',
            attributes: {},
            children: [
              {
                name: 'node',
                attributes: { TEXT: 'Raíz' },
                children: [
                  {
                    name: 'node',
                    attributes: { TEXT: 'Hija' },
                    children: [],
                  },
                ],
              },
            ],
          }),
        },
      }
    );
    expect(freemind).toMatchObject({ ok: true });
    if (freemind.ok) {
      expect(freemind.data.nodes).toHaveLength(1);
      expect(freemind.data.nodes[0]).toMatchObject({
        kind: 'mindmap',
        props: {
          tree: { text: 'Raíz', children: [{ text: 'Hija' }] },
        },
      });
      expect(freemind.data.nodes[0].parentId).toBeUndefined();
      expect(freemind.data.fidelity.entries).toContainEqual(
        expect.objectContaining({
          outcome: 'preserved',
          feature: 'tree-topology-and-text',
        })
      );
    }
  });

  it('exporta Markdown y árboles nativos FreeMind/OPML con fidelidad explícita', () => {
    const nodes = [
      {
        id: 'title',
        kind: 'text' as const,
        bounds: { x: 0, y: 0, w: 100, h: 30 },
        props: { text: 'Plan' },
        design: { role: 'title' as const, order: 0 },
      },
      {
        id: 'body',
        kind: 'shape' as const,
        bounds: { x: 0, y: 80, w: 100, h: 40 },
        props: { text: 'Paso' },
        design: { role: 'body' as const, order: 1 },
      },
    ];
    const markdown = exportCanvasInterchange({ format: 'markdown', nodes });
    expect(markdown).toMatchObject({ ok: true });
    if (markdown.ok) {
      expect(markdown.data.content).toBe('# Plan\n- Paso');
      expect(markdown.data.fidelity.entries).toContainEqual(
        expect.objectContaining({ outcome: 'flattened' })
      );
    }

    const mindmap = [
      {
        id: 'map',
        kind: 'mindmap' as const,
        bounds: { x: 0, y: 0, w: 360, h: 240 },
        props: { tree: { text: 'Raíz &', children: [{ text: 'Hija' }] } },
      },
    ];
    for (const format of ['freemind', 'opml'] as const) {
      const exported = exportCanvasInterchange({ format, nodes: mindmap });
      expect(exported).toMatchObject({ ok: true });
      if (exported.ok) {
        expect(exported.data.content).toContain('Raíz &amp;');
        expect(exported.data.content).toContain('Hija');
        expect(exported.data.fidelity.entries).toContainEqual(
          expect.objectContaining({
            outcome: 'preserved',
            feature: 'tree-topology-and-text',
          })
        );
      }
    }
  });
});
