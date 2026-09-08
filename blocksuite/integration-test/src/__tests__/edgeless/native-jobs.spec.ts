import type {
  CanvasPlan,
  CanvasReceipt,
  CanvasToolResponse,
} from '@affine/realtime/canvas';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  exportNativeCanvas,
  readNativeCanvas,
} from '../../../../../packages/frontend/core/src/blocksuite/ai/runtime/canvas/native-interchange.js';
import { CanvasRuntime } from '../../../../../packages/frontend/core/src/blocksuite/ai/runtime/canvas/runtime.js';
import { getSurface } from '../utils/edgeless.js';
import { setupEditor } from '../utils/setup.js';

function ok<T>(response: CanvasToolResponse<unknown>): T {
  if (!response.ok)
    throw new Error(`${response.error.code}: ${response.error.message}`);
  return response.data as T;
}

async function nativePlan(runtime: CanvasRuntime, snapshot: unknown) {
  return ok<{ plan: CanvasPlan }>(
    await runtime.execute(
      'canvas_import',
      {
        destination: { type: 'existing', documentId: runtime.options.docId },
        format: 'native',
        content: snapshot,
        placement: { x: 4000, y: 0, w: 1, h: 1 },
      },
      { canWrite: true }
    )
  ).plan;
}

async function sourceBundle() {
  const surface = getSurface(window.doc, window.editor).model;
  for (let index = 0; index < 220; index++) {
    surface.addElement({
      type: 'shape',
      subType: 'rectangle',
      xywh: `[${index * 92}, 0, 80, 48]`,
      fill: '#e8f0fe',
      stroke: '#1a73e8',
    });
  }
  return exportNativeCanvas(window.editor.host!);
}

describe('native canvas import jobs in Chromium', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => cleanup?.());

  test('batches >200 native objects, reloads, resumes without duplicates, and parent revert preserves human changes', async () => {
    cleanup = await setupEditor('edgeless');
    const bundle = await sourceBundle();
    const sourceIds = new Set(
      getSurface(window.doc, window.editor).model.elementModels.map(
        element => element.id
      )
    );
    const decoded = await readNativeCanvas(bundle.blob, window.doc);
    const docId = window.editor.host!.store.id;
    const persist = vi.fn(async () => 'synced' as const);
    const first = new CanvasRuntime({
      host: window.editor.host!,
      workspaceId: 'jobs',
      docId,
      persist,
    });
    const plan = await nativePlan(first, decoded.snapshot);

    let expire = false;
    const journal = window.editor.host!.store.spaceDoc.getMap<string>(
      'affine:canvas-ai:operation-journal:v1'
    );
    journal.observe(() => {
      if (
        [...journal.values()].some(value => {
          const item = JSON.parse(value) as {
            nativeJob?: { nextIndex?: number };
          };
          return item.nativeJob?.nextIndex === 100;
        })
      )
        expire = true;
    });
    const now = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => (expire ? 100 : 0));
    let partialResponse: CanvasToolResponse<unknown>;
    try {
      partialResponse = await first.execute(
        'canvas_apply',
        { planId: plan.planId, requestId: 'native-220' },
        { canWrite: true, deadline: 10 }
      );
    } finally {
      now.mockRestore();
    }
    const partial = ok<CanvasReceipt>(partialResponse!);
    expect(partial.execution).toBe('partial');
    expect(partial.persistence).toBe('sync_pending');
    expect(persist).toHaveBeenCalledOnce();
    expect(partial.progress).toMatchObject({
      completed: 100,
      total: expect.any(Number),
      canResume: true,
    });

    first.dispose();
    const reloaded = new CanvasRuntime({
      host: window.editor.host!,
      workspaceId: 'jobs',
      docId,
      persist,
    });
    const resumed = ok<CanvasReceipt>(
      await reloaded.execute(
        'canvas_operation',
        {
          action: 'resume',
          operationId: partial.operationId,
          requestId: 'native-220-resume',
        },
        { canWrite: true }
      )
    );
    expect(resumed.execution).toBe('applied');
    expect(resumed.persistence).toBe('synced');
    expect(persist.mock.calls.length).toBeGreaterThan(1);
    expect(resumed.progress).toMatchObject({
      completed: resumed.progress?.total,
      canResume: false,
    });
    expect(resumed.truncated).toMatchObject({
      value: true,
      counts: { created: 220, idMap: expect.any(Number) },
      continuation: { tool: 'canvas_read', cursor: '0', limit: 200 },
    });
    expect(new Set(resumed.createdIds).size).toBe(resumed.createdIds.length);
    expect(resumed.createdIds).toHaveLength(200);
    const importedIds = getSurface(window.doc, window.editor)
      .model.elementModels.map(element => element.id)
      .filter(id => !sourceIds.has(id));
    expect(new Set(importedIds).size).toBe(220);

    const humanId = resumed.createdIds[0]!;
    getSurface(window.doc, window.editor).model.updateElement(humanId, {
      text: 'human text',
    });
    const reverted = ok<CanvasReceipt>(
      await reloaded.execute(
        'canvas_operation',
        {
          action: 'revert',
          operationId: resumed.operationId,
          requestId: 'native-220-undo',
        },
        { canWrite: true }
      )
    );
    expect(reverted.execution).toBe('partial');
    expect(
      getSurface(window.doc, window.editor).model.getElementById(humanId)
    ).toBeTruthy();
  });

  test('refuses resume when a human edit changed the document after a durable batch', async () => {
    cleanup = await setupEditor('edgeless');
    const bundle = await sourceBundle();
    const decoded = await readNativeCanvas(bundle.blob, window.doc);
    const docId = window.editor.host!.store.id;
    const runtime = new CanvasRuntime({
      host: window.editor.host!,
      workspaceId: 'jobs',
      docId,
    });
    const plan = await nativePlan(runtime, decoded.snapshot);
    let expire = false;
    const journal = window.editor.host!.store.spaceDoc.getMap<string>(
      'affine:canvas-ai:operation-journal:v1'
    );
    journal.observe(() => {
      if (
        [...journal.values()].some(value => {
          const item = JSON.parse(value) as {
            nativeJob?: { nextIndex?: number };
          };
          return item.nativeJob?.nextIndex === 100;
        })
      )
        expire = true;
    });
    const now = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => (expire ? 100 : 0));
    let partialResponse: CanvasToolResponse<unknown>;
    try {
      partialResponse = await runtime.execute(
        'canvas_apply',
        { planId: plan.planId, requestId: 'native-stale' },
        { canWrite: true, deadline: 10 }
      );
    } finally {
      now.mockRestore();
    }
    const partial = ok<CanvasReceipt>(partialResponse!);
    getSurface(window.doc, window.editor).model.addElement({
      type: 'shape',
      subType: 'rectangle',
      xywh: '[0, 200, 80, 48]',
    });
    await expect(
      runtime.execute(
        'canvas_operation',
        {
          action: 'resume',
          operationId: partial.operationId,
          requestId: 'native-stale-resume',
        },
        { canWrite: true }
      )
    ).resolves.toMatchObject({ ok: false, error: { code: 'STALE_PLAN' } });
  });
});
