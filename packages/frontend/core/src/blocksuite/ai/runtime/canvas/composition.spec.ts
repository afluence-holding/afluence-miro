import { type CanvasNode, layoutCanvas } from '@affine/realtime/canvas';
import { orthogonalRoute } from '@blocksuite/global/gfx';
import { describe, expect, it } from 'vitest';

import { composeCanvas } from './composition';

const shape = (id: string, x = 0): CanvasNode => ({
  id,
  kind: 'shape',
  bounds: { x, y: 0, w: 180, h: 80 },
  props: { text: id },
  layout: 'auto',
});
describe('canvas composition and obstacle routing', () => {
  it('keeps feedback loops readable instead of collapsing all cyclic nodes into one column', () => {
    const nodes = ['start', 'review', 'revise', 'finish'].map((id, order) => ({
      ...shape(id),
      design: { order },
    }));
    const edge = (
      id: string,
      sourceId: string,
      targetId: string
    ): CanvasNode => ({
      id,
      kind: 'connector',
      bounds: { x: 0, y: 0, w: 1, h: 1 },
      props: {},
      sourceId,
      targetId,
    });
    const edges = [
      edge('a', 'start', 'review'),
      edge('b', 'review', 'revise'),
      edge('c', 'revise', 'review'),
      edge('d', 'review', 'finish'),
    ];
    const first = layoutCanvas({
      nodes: [...nodes, ...edges],
      options: { mode: 'flow' },
    });
    const x = (id: string) =>
      first.nodes.find(node => node.id === id)!.bounds.x;
    expect(x('start')).toBeLessThan(x('review'));
    expect(x('review')).toBeLessThan(x('revise'));
    expect(x('revise')).toBeLessThan(x('finish'));
    expect(
      first.diagnostics.filter(diagnostic => diagnostic.severity === 'error')
    ).toEqual([]);
    const second = layoutCanvas({
      nodes: first.nodes,
      options: { mode: 'flow' },
    });
    expect(second.nodes.map(node => node.bounds)).toEqual(
      first.nodes.map(node => node.bounds)
    );
  });
  it('preserves human reading order despite random native IDs and input ordering', () => {
    const arranged = layoutCanvas({
      nodes: [shape('aaa', 500), shape('zzz', 100), shape('mmm', 900)],
      options: { mode: 'row', siblingGap: 64 },
    });
    const nodes = [...arranged.nodes].sort((a, b) => a.bounds.x - b.bounds.x);
    expect(nodes.map(node => node.id)).toEqual(['zzz', 'aaa', 'mmm']);
    expect(nodes[1].bounds.x - nodes[0].bounds.x - nodes[0].bounds.w).toBe(64);
  });
  it('fits native frames after laying out children and moves them as a cluster', () => {
    const frame: CanvasNode = {
      id: 'frame',
      kind: 'frame',
      bounds: { x: 0, y: 0, w: 100, h: 100 },
      props: { title: 'Proceso' },
      layout: 'auto',
    };
    const nodes = [
      frame,
      { ...shape('first'), parentId: frame.id },
      { ...shape('second'), parentId: frame.id },
    ];
    const result = composeCanvas(nodes, {
      mode: 'row',
      grammar: 'board',
      density: 'normal',
      origin: { x: 500, y: 300 },
    });
    const [box, first, second] = result.nodes;
    expect(box.bounds).toMatchObject({ x: 500, y: 300 });
    for (const node of [first, second]) {
      expect(node.bounds.x).toBeGreaterThanOrEqual(box.bounds.x + 48);
      expect(node.bounds.y).toBeGreaterThanOrEqual(box.bounds.y + 88);
      expect(node.bounds.x + node.bounds.w).toBeLessThanOrEqual(
        box.bounds.x + box.bounds.w - 48
      );
    }
    expect(result.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
  });
  it('keeps a pinned child and its container anchored', () => {
    const frame: CanvasNode = {
      id: 'frame',
      kind: 'frame',
      bounds: { x: 100, y: 100, w: 600, h: 300 },
      props: {},
      layout: 'preserve',
    };
    const child = {
      ...shape('pin', 180),
      parentId: 'frame',
      layout: 'fixed' as const,
      bounds: { x: 180, y: 210, w: 180, h: 80 },
    };
    const result = composeCanvas([frame, child], {
      mode: 'row',
      origin: { x: 1000, y: 1000 },
    });
    expect(result.nodes[0].bounds).toEqual(frame.bounds);
    expect(result.nodes[1].bounds).toEqual(child.bounds);
  });
  it('finds strictly orthogonal routes around multiple bodies and returns failure for an enclosed endpoint', () => {
    const obstacles = [
      { x: 100, y: -30, w: 80, h: 100 },
      { x: 230, y: -90, w: 60, h: 100 },
    ];
    const route = orthogonalRoute({ x: 0, y: 0 }, { x: 400, y: 0 }, obstacles)!;
    expect(route.length).toBeGreaterThan(2);
    route.slice(1).forEach((end, i) => {
      const start = route[i];
      expect(start.x === end.x || start.y === end.y).toBe(true);
      for (const b of obstacles) {
        const crossing =
          start.y === end.y
            ? start.y > b.y &&
              start.y < b.y + b.h &&
              Math.max(start.x, end.x) > b.x &&
              Math.min(start.x, end.x) < b.x + b.w
            : start.x > b.x &&
              start.x < b.x + b.w &&
              Math.max(start.y, end.y) > b.y &&
              Math.min(start.y, end.y) < b.y + b.h;
        expect(crossing).toBe(false);
      }
    });
    expect(
      orthogonalRoute({ x: 120, y: 0 }, { x: 400, y: 0 }, obstacles)
    ).toBeNull();
  });
});
