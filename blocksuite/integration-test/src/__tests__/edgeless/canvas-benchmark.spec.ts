import type {
  CanvasNode,
  CanvasPlan,
  CanvasReceipt,
  CanvasToolResponse,
} from '@affine/realtime/canvas';
import { afterEach, describe, expect, test } from 'vitest';

import { CanvasRuntime } from '../../../../../packages/frontend/core/src/blocksuite/ai/runtime/canvas/runtime.js';
import { getSurface } from '../utils/edgeless.js';
import { setupEditor } from '../utils/setup.js';

const destination = { type: 'existing' as const, documentId: 'doc:home' };
const scope = { bounds: { x: -100, y: -100, w: 4000, h: 4000 } };
function data<T>(response: CanvasToolResponse<any>): T {
  if (!response.ok)
    throw new Error(`${response.error.code}: ${response.error.message}`);
  return response.data as T;
}
function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * p) - 1]!;
}
function shapes(): CanvasNode[] {
  return Array.from({ length: 100 }, (_, index) => ({
    id: `bench-shape-${index}`,
    kind: 'shape' as const,
    layout: 'auto' as const,
    bounds: {
      x: (index % 10) * 180,
      y: Math.floor(index / 10) * 110,
      w: 130,
      h: 70,
    },
    props: { shapeType: 'rect', text: `N${index}` },
  }));
}
describe('benchmark Chromium canvas', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => cleanup?.());
  test('mide 30 apply de 100 shapes y layout+router de 100/150 sin proveedores', async () => {
    cleanup = await setupEditor('edgeless');
    const runtime = new CanvasRuntime({
      host: window.editor.host!,
      workspaceId: 'benchmark',
      docId: 'doc:home',
    });
    const initial = data<{ plan: CanvasPlan }>(
      await runtime.execute(
        'canvas_validate',
        {
          destination,
          baseContentRevision: runtime.getContentRevision(),
          requestedScope: scope,
          operations: shapes().map(node => ({ type: 'create' as const, node })),
        },
        { canWrite: true }
      )
    ).plan;
    data<CanvasReceipt>(
      await runtime.execute(
        'canvas_apply',
        { planId: initial.planId, requestId: 'bench-seed' },
        { canWrite: true }
      )
    );
    const surface = getSurface(window.doc, window.editor).model;
    for (let index = 0; index < 150; index++)
      surface.addElement({
        type: 'connector',
        xywh: '[0,0,1,1]',
        routing: 'avoid-obstacles',
        source: { id: `bench-shape-${index % 100}` },
        target: { id: `bench-shape-${(index * 13 + 7) % 100}` },
      });
    const applySamples: number[] = [];
    const layoutSamples: number[] = [];
    for (let iteration = 0; iteration < 30; iteration++) {
      // The public read limit is intentionally 200; benchmark the complete
      // 250-object layout graph through the runtime's native adapter.
      const nodes = (
        runtime as unknown as {
          adapter: { allNodes: readonly CanvasNode[] };
        }
      ).adapter.allNodes.filter(
        node => node.kind === 'shape' || node.kind === 'connector'
      );
      const layoutStart = performance.now();
      const plan = data<{ plan: CanvasPlan }>(
        await runtime.execute(
          'canvas_layout',
          {
            destination,
            baseContentRevision: runtime.getContentRevision(),
            requestedScope: {
              ids: nodes
                .filter(node => node.kind === 'shape')
                .map(node => node.id),
            },
            nodes,
            options: {
              mode: 'flow',
              density: 'normal',
              origin: { x: 40 + (iteration % 2) * 8, y: 40 },
            },
          },
          { canWrite: true }
        )
      ).plan;
      layoutSamples.push(performance.now() - layoutStart);
      expect(plan.operations.length).toBeLessThanOrEqual(100);
      const applyStart = performance.now();
      const receipt = data<CanvasReceipt>(
        await runtime.execute(
          'canvas_apply',
          { planId: plan.planId, requestId: `bench-layout-${iteration}` },
          { canWrite: true }
        )
      );
      applySamples.push(performance.now() - applyStart);
      expect(receipt.execution).toBe('applied');
    }
    const report = {
      name: 'edgeless-ai-chromium-apply100-layout100n150e',
      iterations: 30,
      environment: {
        userAgent: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency,
      },
      milliseconds: {
        layoutAndRouting: {
          p50: percentile(layoutSamples, 0.5),
          p95: percentile(layoutSamples, 0.95),
          samples: layoutSamples,
        },
        applyWithFonts: {
          p50: percentile(applySamples, 0.5),
          p95: percentile(applySamples, 0.95),
          samples: applySamples,
        },
      },
    };
    await fetch('/__canvas-benchmark', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
    });
    runtime.dispose();
  });
});
