import type {
  CanvasJsonValue,
  CanvasNode,
  CanvasPlan,
  CanvasReceipt,
  CanvasToolResponse,
} from '@affine/realtime/canvas';
import { afterEach, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';

import { createExcalidrawBundle } from '../../../../../packages/frontend/core/src/blocksuite/ai/runtime/canvas/asset-import.js';
import { readNativeCanvas } from '../../../../../packages/frontend/core/src/blocksuite/ai/runtime/canvas/native-interchange.js';
import {
  nativePrimitiveCreateProps,
  snapshotNativePrimitive,
} from '../../../../../packages/frontend/core/src/blocksuite/ai/runtime/canvas/native-primitives.js';
import { CanvasRuntime } from '../../../../../packages/frontend/core/src/blocksuite/ai/runtime/canvas/runtime.js';
import { wait } from '../utils/common.js';
import { getDocRootBlock, getSurface } from '../utils/edgeless.js';
import { setupEditor } from '../utils/setup.js';

const destination = { type: 'existing' as const, documentId: 'doc:home' };
const scope = { bounds: { x: -1000, y: -1000, w: 5000, h: 3000 } };
const onePixelPng = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
  ),
  character => character.charCodeAt(0)
);

function assertOk<T>(response: CanvasToolResponse<any>): T {
  if (!response.ok)
    throw new Error(
      `${response.error.code}: ${response.error.message} ${JSON.stringify(response.error.details ?? {})}`
    );
  expect(response).toMatchObject({ ok: true });
  return response.data as T;
}

function memoryArtifacts() {
  const blobs = new Map<string, Blob>();
  let ordinal = 0;
  const put = (blob: Blob) => {
    const handle = `canvas-test-handle-${++ordinal}`;
    blobs.set(handle, blob);
    return handle;
  };
  return {
    put,
    get(handle: string) {
      const blob = blobs.get(handle);
      if (!blob) throw new Error(`Handle autenticado no encontrado: ${handle}`);
      return blob;
    },
    options: {
      createArtifact: async ({
        blob,
        fileName,
        mimeType,
      }: {
        blob: Blob;
        fileName: string;
        mimeType: string;
      }) => {
        const handle = put(blob);
        return {
          handle,
          url: `memory://canvas/${handle}`,
          fileName,
          mimeType,
        };
      },
      resolveArtifact: async ({ handle }: { handle: string }) =>
        blobs.get(handle) ?? Promise.reject(new Error('Handle no autorizado.')),
    },
  };
}

function artifactHandle(handle: string, fileName?: string): CanvasJsonValue {
  return {
    kind: 'artifact_handle',
    handle,
    ...(fileName ? { fileName } : {}),
  };
}

type NativePoint = readonly [number, number];

/** Returns true only when the open segment enters a node's visible body. */
function segmentCrossesBody(
  [startX, startY]: NativePoint,
  [endX, endY]: NativePoint,
  obstacle: CanvasNode
) {
  const dx = endX - startX;
  const dy = endY - startY;
  const minX = obstacle.bounds.x;
  const maxX = obstacle.bounds.x + obstacle.bounds.w;
  const minY = obstacle.bounds.y;
  const maxY = obstacle.bounds.y + obstacle.bounds.h;
  const enterX =
    dx === 0
      ? startX > minX && startX < maxX
        ? -Infinity
        : Infinity
      : Math.min((minX - startX) / dx, (maxX - startX) / dx);
  const leaveX =
    dx === 0
      ? startX > minX && startX < maxX
        ? Infinity
        : -Infinity
      : Math.max((minX - startX) / dx, (maxX - startX) / dx);
  const enterY =
    dy === 0
      ? startY > minY && startY < maxY
        ? -Infinity
        : Infinity
      : Math.min((minY - startY) / dy, (maxY - startY) / dy);
  const leaveY =
    dy === 0
      ? startY > minY && startY < maxY
        ? Infinity
        : -Infinity
      : Math.max((minY - startY) / dy, (maxY - startY) / dy);
  return (
    Math.max(enterX, enterY) < Math.min(leaveX, leaveY, 1) &&
    Math.min(leaveX, leaveY) > 0
  );
}

function nativePathCrossesBody(
  path: readonly NativePoint[],
  obstacle: CanvasNode
) {
  return path.some((point, index) =>
    index > 0 ? segmentCrossesBody(path[index - 1]!, point, obstacle) : false
  );
}

function funnelNodes(): CanvasNode[] {
  const stages = [
    'Atracción',
    'Landing',
    'Captura',
    'Oferta',
    'Compra',
    'Seguimiento',
  ];
  const shapes = Array.from({ length: 6 }, (_, index) => ({
    id: `funnel-shape-${index + 1}`,
    kind: 'shape' as const,
    parentId: 'funnel-frame',
    layout: 'auto' as const,
    bounds: { x: 48 + index * 184, y: 172, w: 120, h: 72 },
    props: {
      shapeType: 'rect',
      fillColor: '#E8F0FE',
      strokeColor: '#1A73E8',
      fontSize: 14,
      text: stages[index]!,
    },
    design: { order: index, role: 'section' as const },
  }));
  const connectors = shapes.slice(0, -1).map((shape, index) => ({
    id: `funnel-edge-${index + 1}`,
    kind: 'connector' as const,
    parentId: 'funnel-frame',
    bounds: { x: 0, y: 0, w: 1, h: 1 },
    props: { routing: 'avoid-obstacles' },
    sourceId: shape.id,
    targetId: shapes[index + 1]!.id,
  }));
  return [
    {
      id: 'funnel-frame',
      kind: 'frame',
      bounds: { x: 0, y: 80, w: 1120, h: 300 },
      props: { title: 'Funnel de conversión' },
    },
    ...shapes,
    ...connectors,
  ];
}

describe('Edgeless AI canvas en Chromium', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => cleanup?.());

  test('aplica, mide, preserva edición manual, renderiza y revierte un funnel real', async () => {
    cleanup = await setupEditor('edgeless');
    const runtime = new CanvasRuntime({
      host: window.editor.host!,
      workspaceId: 'browser-workspace',
      docId: 'doc:home',
    });

    const firstPlan = assertOk<{ plan: CanvasPlan }>(
      await runtime.execute(
        'canvas_validate',
        {
          destination,
          baseContentRevision: runtime.getContentRevision(),
          requestedScope: scope,
          operations: funnelNodes().map(node => ({
            type: 'create' as const,
            node,
          })),
          taskId: 'browser-funnel',
        },
        { canWrite: true }
      )
    ).plan;
    expect(firstPlan.status).toBe('ready');
    const sourceRevisionBeforePreview = runtime.getContentRevision();
    const sourceJournal = window.editor.host!.store.spaceDoc.getMap<string>(
      'affine:canvas-ai:operation-journal:v1'
    );
    const journalBeforePreview = [...sourceJournal.entries()];
    const preview = assertOk<{
      kind: string;
      planId?: string;
      contentRevision: string;
      artifact: { mimeType: string; dataUrl?: string };
    }>(
      await runtime.execute('canvas_render', {
        destination,
        planId: firstPlan.planId,
        scope: { bounds: { x: 0, y: 80, w: 1120, h: 300 } },
      })
    );
    expect(preview.kind).toBe('plan_preview');
    expect(preview.planId).toBe(firstPlan.planId);
    expect(preview.contentRevision).toBe(sourceRevisionBeforePreview);
    expect(preview.artifact.mimeType).toBe('image/png');
    expect(preview.artifact.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(runtime.getContentRevision()).toBe(sourceRevisionBeforePreview);
    expect([...sourceJournal.entries()]).toEqual(journalBeforePreview);

    const firstReceipt = assertOk<CanvasReceipt>(
      await runtime.execute(
        'canvas_apply',
        { planId: firstPlan.planId, requestId: 'browser-funnel-create' },
        { canWrite: true }
      )
    );
    const replayReceipt = assertOk<CanvasReceipt>(
      await runtime.execute(
        'canvas_apply',
        { planId: firstPlan.planId, requestId: 'browser-funnel-create' },
        { canWrite: true }
      )
    );
    expect(firstReceipt.execution, JSON.stringify(firstReceipt.warnings)).toBe(
      'applied'
    );
    expect(
      firstReceipt.verification,
      JSON.stringify(firstReceipt.warnings)
    ).toBe('passed');
    expect(replayReceipt.operationId).toBe(firstReceipt.operationId);
    expect(firstReceipt.createdIds).toHaveLength(12);

    const initialRead = assertOk<{ nodes: readonly CanvasNode[] }>(
      await runtime.execute('canvas_read', { destination, scope, limit: 100 })
    );
    const shapes = initialRead.nodes.filter(node => node.kind === 'shape');
    expect(shapes).toHaveLength(6);
    expect(
      initialRead.nodes.filter(node => node.kind === 'connector')
    ).toHaveLength(5);
    expect(
      initialRead.nodes.filter(node => node.kind === 'frame')
    ).toHaveLength(1);
    expect(
      initialRead.nodes
        .filter(node => node.kind === 'shape' || node.kind === 'connector')
        .every(node => node.parentId === firstReceipt.idMap['funnel-frame'])
    ).toBe(true);

    const manuallyEditedId = shapes.find(
      shape => shape.props.text === 'Captura'
    )?.id;
    expect(manuallyEditedId).toBeTruthy();
    getSurface(window.doc, window.editor).model.updateElement(
      manuallyEditedId!,
      {
        text: 'Captura manual',
      }
    );
    await wait();

    const root = getDocRootBlock(window.doc, window.editor, 'edgeless');
    root.service.viewport.setZoom(1.75, { x: 0, y: 0 }, false, true, true);
    expect(root.service.viewport.zoom).toBeCloseTo(1.75);
    const beforeLayout = assertOk<{ nodes: readonly CanvasNode[] }>(
      await runtime.execute('canvas_read', { destination, scope, limit: 100 })
    );

    const layoutPlan = assertOk<{ plan: CanvasPlan }>(
      await runtime.execute(
        'canvas_layout',
        {
          destination,
          baseContentRevision: runtime.getContentRevision(),
          requestedScope: { ids: shapes.map(shape => shape.id) },
          nodes: beforeLayout.nodes
            .filter(node => node.kind === 'shape')
            .map(node => ({ ...node, layout: 'auto' as const })),
          options: {
            mode: 'row',
            density: 'compact',
            siblingGap: 64,
            levelGap: 64,
            origin: { x: 48, y: 172 },
          },
          taskId: 'browser-funnel-layout',
        },
        { canWrite: true }
      )
    ).plan;
    expect(layoutPlan.status).toBe('ready');
    const layoutReceipt = assertOk<CanvasReceipt>(
      await runtime.execute(
        'canvas_apply',
        { planId: layoutPlan.planId, requestId: 'browser-funnel-layout' },
        { canWrite: true }
      )
    );
    const replayLayout = assertOk<CanvasReceipt>(
      await runtime.execute(
        'canvas_apply',
        { planId: layoutPlan.planId, requestId: 'browser-funnel-layout' },
        { canWrite: true }
      )
    );
    expect(replayLayout.operationId).toBe(layoutReceipt.operationId);

    const afterLayout = assertOk<{ nodes: readonly CanvasNode[] }>(
      await runtime.execute('canvas_read', { destination, scope, limit: 100 })
    );
    const laidOutShapes = afterLayout.nodes
      .filter(node => node.kind === 'shape')
      .sort((left, right) => left.bounds.x - right.bounds.x);
    for (let index = 1; index < laidOutShapes.length; index++) {
      const previous = laidOutShapes[index - 1]!;
      const current = laidOutShapes[index]!;
      expect(current.bounds.x - (previous.bounds.x + previous.bounds.w)).toBe(
        64
      );
    }
    expect(laidOutShapes.map(shape => shape.props.text)).toEqual([
      'Atracción',
      'Landing',
      'Captura manual',
      'Oferta',
      'Compra',
      'Seguimiento',
    ]);
    const surface = getSurface(window.doc, window.editor).model;
    const nativePath = (id: string): readonly NativePoint[] => {
      const model = surface.getElementById(id) as unknown as {
        absolutePath?: readonly (readonly number[])[];
        routing?: unknown;
      } | null;
      expect(model?.routing).toBe('avoid-obstacles');
      const path = model?.absolutePath ?? [];
      expect(path.length).toBeGreaterThanOrEqual(2);
      return path.map(point => [point[0]!, point[1]!] as const);
    };
    const connectorBodyCrossings = afterLayout.nodes.flatMap(connector => {
      if (connector.kind !== 'connector') return [];
      const source = connector.sourceId
        ? afterLayout.nodes.find(node => node.id === connector.sourceId)
        : undefined;
      const target = connector.targetId
        ? afterLayout.nodes.find(node => node.id === connector.targetId)
        : undefined;
      if (!source || !target) return [connector.id];
      const path = nativePath(connector.id);
      return laidOutShapes
        .filter(shape => shape.id !== source.id && shape.id !== target.id)
        .filter(shape => nativePathCrossesBody(path, shape))
        .map(shape => `${connector.id}:${shape.id}`);
    });
    expect(connectorBodyCrossings).toEqual([]);
    expect(
      afterLayout.nodes.find(node => node.id === manuallyEditedId)?.props.text
    ).toBe('Captura manual');

    const render = assertOk<{
      artifact: { mimeType: string; dataUrl?: string };
    }>(
      await runtime.execute('canvas_render', {
        destination,
        scope: {
          ids: afterLayout.nodes
            .filter(node => node.kind === 'shape' || node.kind === 'connector')
            .map(node => node.id),
        },
        contentRevision: runtime.getContentRevision(),
      })
    );
    expect(render.artifact.mimeType).toBe('image/png');
    expect(render.artifact.dataUrl).toMatch(/^data:image\/png;base64,/);
    const artifactWrite = await fetch('/__canvas-artifact', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: render.artifact.dataUrl,
    });
    expect(artifactWrite.status).toBe(204);

    const pdfExport = assertOk<{
      format: string;
      artifact: { mimeType: string; url?: string };
    }>(
      await runtime.execute('canvas_export', {
        destination,
        scope: {
          ids: afterLayout.nodes
            .filter(node => node.kind === 'shape' || node.kind === 'connector')
            .map(node => node.id),
        },
        format: 'pdf',
      })
    );
    expect(pdfExport.format).toBe('pdf');
    expect(pdfExport.artifact.mimeType).toBe('application/pdf');
    expect(pdfExport.artifact.url).toBeTruthy();
    const pdfBytes = new Uint8Array(
      await (await fetch(pdfExport.artifact.url!)).arrayBuffer()
    );
    expect(new TextDecoder().decode(pdfBytes.slice(0, 5))).toBe('%PDF-');
    const { PDFDocument } = await import('pdf-lib');
    const parsedPdf = await PDFDocument.load(pdfBytes);
    expect(parsedPdf.getPageCount()).toBe(1);
    expect(parsedPdf.getPages()[0].getWidth()).toBeGreaterThan(0);
    expect(parsedPdf.getPages()[0].getHeight()).toBeGreaterThan(0);

    const firstConnector = afterLayout.nodes.find(
      node => node.kind === 'connector' && node.sourceId && node.targetId
    )!;
    const firstSource = afterLayout.nodes.find(
      node => node.id === firstConnector.sourceId
    )!;
    const firstTarget = afterLayout.nodes.find(
      node => node.id === firstConnector.targetId
    )!;
    const movedObstacle = laidOutShapes.find(
      shape => shape.id !== firstSource.id && shape.id !== firstTarget.id
    )!;
    surface.updateElement(movedObstacle.id, {
      xywh: `[${firstSource.bounds.x + firstSource.bounds.w + 20},${firstSource.bounds.y},${movedObstacle.bounds.w},${movedObstacle.bounds.h}]`,
    });
    await wait();
    await wait();
    const reroutedPath = nativePath(firstConnector.id);
    const moved = assertOk<{ nodes: readonly CanvasNode[] }>(
      await runtime.execute('canvas_read', { destination, scope, limit: 100 })
    ).nodes.find(node => node.id === movedObstacle.id)!;
    expect(nativePathCrossesBody(reroutedPath, moved)).toBe(false);

    const nativeExport = assertOk<{
      checksum: string;
      artifact: { url?: string; mimeType: string };
    }>(
      await runtime.execute('canvas_export', {
        destination,
        scope,
        format: 'native',
      })
    );
    expect(nativeExport.artifact.mimeType).toBe('application/zip');
    expect(nativeExport.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(nativeExport.artifact.url).toBeTruthy();
    const exportedBlob = await (await fetch(nativeExport.artifact.url!)).blob();
    const exportedBundle = await readNativeCanvas(exportedBlob, window.doc);
    const nativeImport = assertOk<{ plan: CanvasPlan }>(
      await runtime.execute(
        'canvas_import',
        {
          destination,
          format: 'native',
          content: exportedBundle.snapshot,
          placement: { x: 1420, y: 172, w: 1120, h: 300 },
        },
        { canWrite: true }
      )
    ).plan;
    expect(nativeImport.status).toBe('ready');
    const nativeImportReceipt = assertOk<CanvasReceipt>(
      await runtime.execute(
        'canvas_apply',
        { planId: nativeImport.planId, requestId: 'browser-native-reimport' },
        { canWrite: true }
      )
    );
    expect(nativeImportReceipt.execution).toBe('applied');
    expect(nativeImportReceipt.createdIds.length).toBeGreaterThan(0);

    const reverted = assertOk<CanvasReceipt>(
      await runtime.execute(
        'canvas_operation',
        {
          action: 'revert',
          operationId: layoutReceipt.operationId,
          requestId: 'browser-funnel-layout-revert',
        },
        { canWrite: true }
      )
    );
    expect(reverted.execution, JSON.stringify(reverted.warnings)).toBe(
      'reverted'
    );
    const redone = assertOk<CanvasReceipt>(
      await runtime.execute(
        'canvas_operation',
        {
          action: 'redo',
          operationId: layoutReceipt.operationId,
          requestId: 'browser-funnel-layout-redo',
        },
        { canWrite: true }
      )
    );
    expect(redone.execution).toBe('applied');
    const focused = assertOk<{
      focusedScope: { bounds?: CanvasNode['bounds'] };
    }>(
      await runtime.execute(
        'canvas_focus',
        {
          destination,
          scope: { bounds: { x: 0, y: 80, w: 1120, h: 300 } },
          mode: 'view',
        },
        { canWrite: false }
      )
    );
    expect(focused.focusedScope.bounds).toEqual({
      x: 0,
      y: 80,
      w: 1120,
      h: 300,
    });
    await wait();
    await page.screenshot({ path: '/tmp/edgeless-ai-funnel.png' });
    runtime.dispose();
  });

  test('reasigna una figura a un frame creado en el mismo commit', async () => {
    cleanup = await setupEditor('edgeless');
    const runtime = new CanvasRuntime({
      host: window.editor.host!,
      workspaceId: 'browser-workspace',
      docId: 'doc:home',
    });
    const frameScope = { bounds: { x: 0, y: 0, w: 1000, h: 500 } };
    const initialPlan = assertOk<{ plan: CanvasPlan }>(
      await runtime.execute(
        'canvas_validate',
        {
          destination,
          baseContentRevision: runtime.getContentRevision(),
          requestedScope: frameScope,
          operations: [
            {
              type: 'create',
              node: {
                id: 'old-frame',
                kind: 'frame',
                bounds: { x: 0, y: 0, w: 400, h: 300 },
                props: { title: 'Anterior' },
              },
            },
            {
              type: 'create',
              node: {
                id: 'moving-shape',
                kind: 'shape',
                parentId: 'old-frame',
                bounds: { x: 40, y: 80, w: 120, h: 64 },
                props: { text: 'Mover' },
              },
            },
          ],
        },
        { canWrite: true }
      )
    ).plan;
    const initialReceipt = assertOk<CanvasReceipt>(
      await runtime.execute(
        'canvas_apply',
        { planId: initialPlan.planId, requestId: 'frame-reparent-initial' },
        { canWrite: true }
      )
    );
    expect(initialReceipt.execution).toBe('applied');
    const shapeId = initialReceipt.idMap['moving-shape'];
    const oldFrameId = initialReceipt.idMap['old-frame'];
    if (!shapeId || !oldFrameId)
      throw new Error('Initial frame identities were not allocated.');

    const reparentPlan = assertOk<{ plan: CanvasPlan }>(
      await runtime.execute(
        'canvas_validate',
        {
          destination,
          baseContentRevision: runtime.getContentRevision(),
          requestedScope: frameScope,
          operations: [
            {
              type: 'create',
              node: {
                id: 'new-frame',
                kind: 'frame',
                bounds: { x: 500, y: 0, w: 400, h: 300 },
                props: { title: 'Nuevo' },
              },
            },
            {
              type: 'update',
              target: { id: shapeId },
              patch: { parentId: 'new-frame' },
            },
          ],
        },
        { canWrite: true }
      )
    ).plan;
    const reparented = assertOk<CanvasReceipt>(
      await runtime.execute(
        'canvas_apply',
        { planId: reparentPlan.planId, requestId: 'frame-reparent-move' },
        { canWrite: true }
      )
    );
    expect(reparented.execution, JSON.stringify(reparented.warnings)).toBe(
      'applied'
    );
    const newFrameId = reparented.idMap['new-frame'];
    if (!newFrameId) throw new Error('New frame identity was not allocated.');
    const read = assertOk<{ nodes: readonly CanvasNode[] }>(
      await runtime.execute('canvas_read', {
        destination,
        scope: frameScope,
        limit: 100,
      })
    );
    expect(read.nodes.find(node => node.id === shapeId)?.parentId).toBe(
      newFrameId
    );
    const store = window.editor.host!.store;
    const oldFrame = store.getModelById(oldFrameId) as {
      props: { childElementIds?: Record<string, boolean> };
    } | null;
    const newFrame = store.getModelById(newFrameId) as {
      props: { childElementIds?: Record<string, boolean> };
    } | null;
    expect(oldFrame?.props.childElementIds?.[shapeId]).toBeUndefined();
    expect(newFrame?.props.childElementIds?.[shapeId]).toBe(true);
    runtime.dispose();
  });

  test('aplica y revierte jerarquía nativa note→paragraph→list mediante las herramientas', async () => {
    cleanup = await setupEditor('edgeless');
    const runtime = new CanvasRuntime({
      host: window.editor.host!,
      workspaceId: 'browser-workspace',
      docId: 'doc:home',
    });
    const nestedScope = { bounds: { x: -100, y: -100, w: 800, h: 800 } };
    const plan = assertOk<{ plan: CanvasPlan }>(
      await runtime.execute(
        'canvas_validate',
        {
          destination,
          baseContentRevision: runtime.getContentRevision(),
          requestedScope: nestedScope,
          taskId: 'nested-native-blocks',
          operations: [
            {
              type: 'create',
              node: {
                id: 'nested-note',
                kind: 'note',
                bounds: { x: 40, y: 40, w: 360, h: 220 },
                props: {},
              },
            },
            {
              type: 'create',
              node: {
                id: 'nested-paragraph',
                kind: 'block:affine:paragraph',
                parentId: 'nested-note',
                bounds: { x: 40, y: 40, w: 360, h: 40 },
                props: { text: 'Introducción nativa' },
              },
            },
            {
              type: 'create',
              node: {
                id: 'nested-list',
                kind: 'block:affine:list',
                parentId: 'nested-note',
                bounds: { x: 40, y: 90, w: 360, h: 40 },
                props: {
                  text: 'Acción pendiente',
                  type: 'todo',
                  checked: false,
                },
              },
            },
          ],
        },
        { canWrite: true }
      )
    ).plan;
    expect(plan.status).toBe('ready');
    const applied = assertOk<CanvasReceipt>(
      await runtime.execute(
        'canvas_apply',
        { planId: plan.planId, requestId: 'nested-native-create' },
        { canWrite: true }
      )
    );
    expect(applied.execution, JSON.stringify(applied.warnings)).toBe('applied');
    const read = assertOk<{ nodes: readonly CanvasNode[] }>(
      await runtime.execute('canvas_read', {
        destination,
        scope: nestedScope,
        limit: 100,
      })
    ).nodes;
    expect(read.find(node => node.id === 'nested-paragraph')).toMatchObject({
      kind: 'block:affine:paragraph',
      parentId: 'nested-note',
      props: { text: 'Introducción nativa' },
    });
    expect(read.find(node => node.id === 'nested-list')).toMatchObject({
      kind: 'block:affine:list',
      parentId: 'nested-note',
      props: { text: 'Acción pendiente' },
    });
    const updatePlan = assertOk<{ plan: CanvasPlan }>(
      await runtime.execute(
        'canvas_validate',
        {
          destination,
          baseContentRevision: runtime.getContentRevision(),
          requestedScope: nestedScope,
          operations: [
            {
              type: 'update',
              target: { id: 'nested-paragraph' },
              patch: { props: { text: 'Introducción actualizada' } },
            },
          ],
        },
        { canWrite: true }
      )
    ).plan;
    const updated = assertOk<CanvasReceipt>(
      await runtime.execute(
        'canvas_apply',
        { planId: updatePlan.planId, requestId: 'nested-native-update' },
        { canWrite: true }
      )
    );
    expect(
      assertOk<{ nodes: readonly CanvasNode[] }>(
        await runtime.execute('canvas_read', {
          destination,
          scope: nestedScope,
          limit: 100,
        })
      ).nodes.find(node => node.id === 'nested-paragraph')?.props.text
    ).toBe('Introducción actualizada');
    const revertedUpdate = assertOk<CanvasReceipt>(
      await runtime.execute(
        'canvas_operation',
        {
          action: 'revert',
          operationId: updated.operationId,
          requestId: 'nested-native-update-revert',
        },
        { canWrite: true }
      )
    );
    expect(revertedUpdate.execution).toBe('reverted');
    expect(
      assertOk<{ nodes: readonly CanvasNode[] }>(
        await runtime.execute('canvas_read', {
          destination,
          scope: nestedScope,
          limit: 100,
        })
      ).nodes.find(node => node.id === 'nested-paragraph')?.props.text
    ).toBe('Introducción nativa');
    const reverted = assertOk<CanvasReceipt>(
      await runtime.execute(
        'canvas_operation',
        {
          action: 'revert',
          operationId: applied.operationId,
          requestId: 'nested-native-create-revert',
        },
        { canWrite: true }
      )
    );
    expect(reverted.execution, JSON.stringify(reverted.warnings)).toBe(
      'reverted'
    );
    expect(
      assertOk<{ nodes: readonly CanvasNode[] }>(
        await runtime.execute('canvas_read', {
          destination,
          scope: nestedScope,
          limit: 100,
        })
      ).nodes.some(node => node.id === 'nested-paragraph')
    ).toBe(false);
    const redone = assertOk<CanvasReceipt>(
      await runtime.execute(
        'canvas_operation',
        {
          action: 'redo',
          operationId: applied.operationId,
          requestId: 'nested-native-redo',
        },
        { canWrite: true }
      )
    );
    expect(redone.execution).toBe('applied');
    runtime.dispose();
  });

  test('convierte Excalidraw con geometría e imagen local a un bundle nativo aislado', async () => {
    cleanup = await setupEditor('edgeless');
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
    const bundle = await createExcalidrawBundle(window.editor.host!, {
      elements: [
        {
          id: 'box',
          type: 'rectangle',
          x: 20,
          y: 20,
          width: 200,
          height: 100,
          groupIds: ['funnel'],
        },
        {
          id: 'label',
          type: 'text',
          x: 40,
          y: 50,
          width: 120,
          height: 24,
          text: 'Atracción',
          groupIds: ['funnel'],
        },
        {
          id: 'next',
          type: 'rectangle',
          x: 320,
          y: 20,
          width: 200,
          height: 100,
        },
        {
          id: 'arrow',
          type: 'arrow',
          x: 220,
          y: 70,
          width: 100,
          height: 1,
          startBinding: { elementId: 'box' },
          endBinding: { elementId: 'next' },
        },
        {
          id: 'image',
          type: 'image',
          fileId: 'asset-image',
          x: 40,
          y: 180,
          width: 160,
          height: 90,
        },
      ],
      files: {
        'asset-image': {
          mimeType: 'image/png',
          dataURL: `data:image/png;base64,${png}`,
          fileName: 'funnel.png',
        },
      },
    });
    const surface = bundle.snapshot.blocks.children.find(
      block => block.flavour === 'affine:surface'
    )!;
    expect(
      Object.values(surface.props.elements as Record<string, unknown>)
    ).toHaveLength(5);
    const image = surface.children.find(
      block => block.flavour === 'affine:image'
    )!;
    expect(bundle.assets.get(String(image.props.sourceId))).toBeTruthy();
  });

  test('importa assets y Excalidraw con handles autenticados, conserva blobs, grupos y flechas vinculadas', async () => {
    cleanup = await setupEditor('edgeless');
    const artifacts = memoryArtifacts();
    const runtime = new CanvasRuntime({
      host: window.editor.host!,
      workspaceId: 'browser-workspace',
      docId: 'doc:home',
      ...artifacts.options,
    });
    const context = { canWrite: true };

    const directAssetPlan = assertOk<{ plan: CanvasPlan }>(
      await runtime.execute(
        'canvas_import',
        {
          destination,
          format: 'asset',
          content: artifactHandle(
            artifacts.put(new Blob([onePixelPng], { type: 'image/png' })),
            'captura.png'
          ),
          placement: { x: 20, y: 20, w: 80, h: 80 },
        },
        context
      )
    ).plan;
    expect(
      directAssetPlan.status,
      JSON.stringify(directAssetPlan.diagnostics)
    ).toBe('ready');
    const directAssetReceipt = assertOk<CanvasReceipt>(
      await runtime.execute(
        'canvas_apply',
        { planId: directAssetPlan.planId, requestId: 'authenticated-asset' },
        context
      )
    );
    expect(directAssetReceipt.execution).toBe('applied');
    const directImage = assertOk<{ nodes: readonly CanvasNode[] }>(
      await runtime.execute('canvas_read', { destination, scope, limit: 100 })
    ).nodes.find(node => node.kind === 'block:affine:image');
    if (!directImage || typeof directImage.props.sourceId !== 'string')
      throw new Error('La imagen directa no fue creada por canvas_import.');
    expect(directImage.props.sourceId).toMatch(/^sha256-[a-f0-9]{64}$/);
    const persistedDirectBlob = await window.editor.host!.store.blobSync.get(
      directImage.props.sourceId
    );
    if (!persistedDirectBlob)
      throw new Error('El blob de la imagen directa no fue persistido.');
    expect(
      Array.from(new Uint8Array(await persistedDirectBlob.arrayBuffer()))
    ).toEqual(Array.from(onePixelPng));

    const truncatedPng = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
    ]);
    const malformed = await runtime.execute(
      'canvas_import',
      {
        destination,
        format: 'asset',
        content: artifactHandle(
          artifacts.put(new Blob([truncatedPng], { type: 'image/png' })),
          'truncated.png'
        ),
        placement: { x: 120, y: 20, w: 80, h: 80 },
      },
      context
    );
    expect(malformed).toMatchObject({
      ok: false,
      error: { code: 'INVALID_PLAN' },
    });

    const oversizedPng = new Uint8Array(24);
    oversizedPng.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    oversizedPng.set([0x49, 0x48, 0x44, 0x52], 12);
    oversizedPng.set([0, 0xff, 0xff, 0xff, 0, 0xff, 0xff, 0xff], 16);
    const tooLarge = await runtime.execute(
      'canvas_import',
      {
        destination,
        format: 'asset',
        content: artifactHandle(
          artifacts.put(new Blob([oversizedPng], { type: 'image/png' })),
          'too-large.png'
        ),
        placement: { x: 220, y: 20, w: 80, h: 80 },
      },
      context
    );
    expect(tooLarge).toMatchObject({
      ok: false,
      error: { code: 'BUDGET_EXCEEDED' },
    });

    const dataUrl = `data:image/png;base64,${btoa(String.fromCharCode(...onePixelPng))}`;
    const excalidraw = {
      elements: [
        {
          id: 'image-a',
          type: 'image',
          fileId: 'file-a',
          x: 20,
          y: 180,
          width: 100,
          height: 100,
          groupIds: ['only-images'],
        },
        {
          id: 'image-b',
          type: 'image',
          fileId: 'file-b',
          x: 260,
          y: 180,
          width: 100,
          height: 100,
          groupIds: ['only-images'],
        },
        {
          id: 'image-arrow',
          type: 'arrow',
          x: 120,
          y: 230,
          width: 140,
          height: 1,
          startBinding: { elementId: 'image-a' },
          endBinding: { elementId: 'image-b' },
        },
      ],
      files: {
        'file-a': { mimeType: 'image/png', dataURL: dataUrl },
        'file-b': { mimeType: 'image/png', dataURL: dataUrl },
      },
    };
    const excalidrawPlan = assertOk<{ plan: CanvasPlan }>(
      await runtime.execute(
        'canvas_import',
        {
          destination,
          format: 'excalidraw',
          content: artifactHandle(
            artifacts.put(
              new Blob([JSON.stringify(excalidraw)], {
                type: 'application/json',
              })
            ),
            'images.excalidraw'
          ),
          placement: { x: 20, y: 180, w: 340, h: 100 },
        },
        context
      )
    ).plan;
    const excalidrawReceipt = assertOk<CanvasReceipt>(
      await runtime.execute(
        'canvas_apply',
        {
          planId: excalidrawPlan.planId,
          requestId: 'authenticated-excalidraw',
        },
        context
      )
    );
    expect(excalidrawReceipt.execution).toBe('applied');
    const importedRead = await runtime.execute('canvas_read', {
      destination,
      scope,
      limit: 100,
    });
    const imported = assertOk<{ nodes: readonly CanvasNode[] }>(
      importedRead
    ).nodes;
    const images = imported.filter(node => node.kind === 'block:affine:image');
    const excalidrawImages = images.filter(node => node.id !== directImage.id);
    const imageConnector = imported.find(
      node =>
        node.kind === 'connector' &&
        excalidrawImages.some(image => image.id === node.sourceId) &&
        excalidrawImages.some(image => image.id === node.targetId)
    );
    const imageGroup = imported.find(node => node.kind === 'group');
    expect(images).toHaveLength(3);
    expect(excalidrawImages).toHaveLength(2);
    expect(imageConnector).toBeTruthy();
    expect(imageGroup).toBeTruthy();
    if (!imageConnector || !imageGroup)
      throw new Error('El grupo o la flecha de imágenes no fue materializado.');
    expect(
      excalidrawImages.every(node => node.parentId === imageGroup.id)
    ).toBe(true);

    const exportScope = {
      ids: [...excalidrawImages, imageConnector, imageGroup].map(
        node => node.id
      ),
    };
    const exported = assertOk<{
      artifact: { handle?: string; mimeType: string };
    }>(
      await runtime.execute(
        'canvas_export',
        { destination, format: 'excalidraw', scope: exportScope },
        { canWrite: false }
      )
    );
    expect(exported.artifact.handle).toBeTruthy();
    expect(exported.artifact.mimeType).toBe('application/json');
    if (!exported.artifact.handle)
      throw new Error('La exportación Excalidraw no devolvió un handle.');
    const exportedContent = JSON.parse(
      await artifacts.get(exported.artifact.handle).text()
    ) as {
      elements: Array<Record<string, unknown>>;
      files: Record<string, unknown>;
    };
    const exportedImages = exportedContent.elements.filter(
      element => element.type === 'image'
    );
    const exportedArrow = exportedContent.elements.find(
      element => element.type === 'arrow'
    );
    expect(exportedImages).toHaveLength(2);
    expect(Object.keys(exportedContent.files)).toHaveLength(2);
    expect(exportedImages.every(image => image.groupIds)).toBe(true);
    expect(exportedArrow?.startBinding).toEqual({
      elementId: imageConnector.sourceId,
    });
    expect(exportedArrow?.endBinding).toEqual({
      elementId: imageConnector.targetId,
    });

    const roundTripPlan = assertOk<{ plan: CanvasPlan }>(
      await runtime.execute(
        'canvas_import',
        {
          destination,
          format: 'excalidraw',
          content: artifactHandle(
            exported.artifact.handle,
            'roundtrip.excalidraw'
          ),
          placement: { x: 500, y: 180, w: 340, h: 100 },
        },
        context
      )
    ).plan;
    const roundTripReceipt = assertOk<CanvasReceipt>(
      await runtime.execute(
        'canvas_apply',
        {
          planId: roundTripPlan.planId,
          requestId: 'authenticated-excalidraw-roundtrip',
        },
        context
      )
    );
    expect(roundTripReceipt.execution).toBe('applied');
    const afterRoundTrip = assertOk<{ nodes: readonly CanvasNode[] }>(
      await runtime.execute('canvas_read', { destination, scope, limit: 100 })
    ).nodes;
    expect(
      afterRoundTrip.filter(node => node.kind === 'block:affine:image')
    ).toHaveLength(5);
    expect(
      afterRoundTrip.filter(node => node.kind === 'connector')
    ).toHaveLength(2);
    runtime.dispose();
  });

  test('crea brush, highlighter y mindmap como modelos nativos y conserva sus relaciones', async () => {
    cleanup = await setupEditor('edgeless');
    const surface = getSurface(window.doc, window.editor).model;
    const brush = {
      id: 'browser-brush',
      kind: 'brush' as const,
      bounds: { x: 100, y: 100, w: 160, h: 44 },
      props: {
        points: [
          [100, 100],
          [180, 140, 0.5],
          [260, 100],
        ],
        color: '#1677ff',
        lineWidth: 4,
      },
    } satisfies CanvasNode;
    const highlighter = {
      id: 'browser-highlighter',
      kind: 'highlighter' as const,
      bounds: { x: 100, y: 220, w: 160, h: 16 },
      props: {
        points: [
          [100, 220],
          [260, 220],
        ],
        color: '#fff200',
        lineWidth: 12,
      },
    } satisfies CanvasNode;
    const mindmap = {
      id: 'browser-mindmap',
      kind: 'mindmap' as const,
      bounds: { x: 380, y: 100, w: 200, h: 120 },
      props: {
        tree: {
          text: 'Canales',
          children: [
            { text: 'Orgánico', children: [{ text: 'Instagram' }] },
            { text: 'Pagado' },
          ],
        },
        layoutType: 1,
        style: 2,
      },
    } satisfies CanvasNode;
    const brushId = surface.addElement(nativePrimitiveCreateProps(brush));
    const highlighterId = surface.addElement(
      nativePrimitiveCreateProps(highlighter)
    );
    const mindmapId = surface.addElement(nativePrimitiveCreateProps(mindmap));
    await wait();

    const nativeBrush = surface.getElementById(brushId)!;
    const nativeHighlighter = surface.getElementById(highlighterId)!;
    const nativeMindmap = surface.getElementById(mindmapId)!;
    expect(nativeBrush.type).toBe('brush');
    expect(nativeHighlighter.type).toBe('highlighter');
    expect(nativeMindmap.type).toBe('mindmap');
    expect(snapshotNativePrimitive(nativeBrush)).toMatchObject({
      color: '#1677ff',
      lineWidth: 4,
      points: brush.props.points,
    });
    expect(snapshotNativePrimitive(nativeHighlighter)).toMatchObject({
      color: '#fff200',
      lineWidth: 12,
      points: highlighter.props.points,
    });
    const snapshot = snapshotNativePrimitive(nativeMindmap);
    expect(snapshot).toMatchObject({
      tree: mindmap.props.tree,
      layoutType: 1,
      style: 2,
    });
    const nativeTree = nativeMindmap as unknown as {
      tree: {
        element: { id: string };
        children: readonly { element: { id: string } }[];
      };
    };
    expect(nativeTree.tree.children).toHaveLength(2);
    expect(nativeTree.tree.children[0]!.element.id).not.toBe(
      nativeTree.tree.element.id
    );
  });
});
