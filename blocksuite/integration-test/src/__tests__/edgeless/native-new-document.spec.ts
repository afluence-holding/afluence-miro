import type {
  CanvasPlan,
  CanvasReceipt,
  CanvasToolResponse,
} from '@affine/realtime/canvas';
import { Text } from '@blocksuite/affine/store';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { exportNativeCanvas } from '../../../../../packages/frontend/core/src/blocksuite/ai/runtime/canvas/native-interchange.js';
import { canvasDocumentFactory } from '../../../../../packages/frontend/core/src/blocksuite/ai/runtime/canvas/new-document.js';
import { CanvasRuntime } from '../../../../../packages/frontend/core/src/blocksuite/ai/runtime/canvas/runtime.js';
import { getSurface } from '../utils/edgeless.js';
import { setupEditor } from '../utils/setup.js';

function ok<T>(response: CanvasToolResponse<unknown>): T {
  if (!response.ok)
    throw new Error(`${response.error.code}: ${response.error.message}`);
  return response.data as T;
}

describe('native canvas new-document lifecycle in Chromium', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => cleanup?.());

  test('imports losslessly, retries once, and reverts in the durable target document', async () => {
    cleanup = await setupEditor('edgeless');
    const sourceHost = window.editor.host!;
    const sourceStore = sourceHost.store;
    const sourceRoot = sourceStore.root;
    if (!sourceRoot) throw new Error('Source root is unavailable.');
    const sourceSurface = getSurface(window.doc, window.editor).model;

    const noteId = sourceStore.addBlock(
      'affine:note',
      { xywh: '[80,80,360,220]' },
      sourceRoot
    );
    sourceStore.addBlock(
      'affine:paragraph',
      { text: new Text('Jerarquía nativa de origen') },
      noteId
    );
    sourceSurface.addElement({
      type: 'shape',
      subType: 'rectangle',
      xywh: '[520,100,180,96]',
      text: 'Destino nuevo',
      fill: '#e8f0fe',
      stroke: '#1a73e8',
    });
    const assetId = 'native-new-document-asset';
    const png = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
      ),
      character => character.charCodeAt(0)
    );
    await sourceStore.workspace.blobSync.set(
      assetId,
      new Blob([png], { type: 'image/png' })
    );
    sourceStore.addBlock(
      'affine:image',
      { sourceId: assetId, xywh: '[760,100,120,90]' },
      sourceSurface.id
    );

    const sourceBundle = await exportNativeCanvas(sourceHost);
    const revisionProbe = new CanvasRuntime({
      host: sourceHost,
      workspaceId: window.collection.id,
      docId: sourceStore.id,
    });
    const sourceRevision = revisionProbe.getContentRevision();
    revisionProbe.dispose();
    const sourceBlockCount = sourceStore.getAllModels().length;
    const targetId = 'doc:native-new-document';

    // canvasDocumentFactory is the production lifecycle implementation. The
    // facade only adapts TestWorkspace's naming to the frontend Workspace
    // entity used by that factory.
    const workspaceFacade = {
      id: window.collection.id,
      rootYDoc: window.collection.doc,
      docCollection: window.collection,
      docs: {
        createDoc: ({ id }: { id: string }) => window.collection.createDoc(id),
      },
      engine: {
        doc: { waitForDocReady: async () => {} },
      },
    } as unknown as Parameters<typeof canvasDocumentFactory>[0];
    const productionFactory = canvasDocumentFactory(
      workspaceFacade,
      sourceHost
    );
    const lifecycleRequests: Array<{ operationId: string; docId: string }> = [];
    const createDocument = vi.fn(
      async (request: Parameters<typeof productionFactory>[0]) => {
        lifecycleRequests.push({
          operationId: request.operationId,
          docId: request.docId,
        });
        return productionFactory(request);
      }
    );
    const runtime = new CanvasRuntime({
      host: sourceHost,
      workspaceId: window.collection.id,
      docId: sourceStore.id,
      createDocument,
      resolveArtifact: async ({ handle }) => {
        if (handle !== 'source-native-bundle')
          throw new Error('Unknown native artifact handle.');
        return sourceBundle.blob;
      },
      authorizeTarget: async () => ({
        canRead: true,
        canWrite: true,
        canCreateDoc: true,
      }),
    });
    const destination = {
      type: 'new_document' as const,
      workspaceId: window.collection.id,
      title: 'Lienzo nativo importado',
      reservedDocumentId: targetId,
    };
    const plan = ok<{ plan: CanvasPlan }>(
      await runtime.execute(
        'canvas_import',
        {
          destination,
          format: 'native',
          content: {
            kind: 'artifact_handle',
            handle: 'source-native-bundle',
          },
          placement: { x: 1200, y: 400, w: 1, h: 1 },
        },
        { canWrite: true, canCreateDoc: true, taskId: 'native-new-document' }
      )
    ).plan;

    const applied = ok<CanvasReceipt>(
      await runtime.execute(
        'canvas_apply',
        { planId: plan.planId, requestId: 'native-new-document-apply' },
        { canWrite: true, canCreateDoc: true, taskId: 'native-new-document' }
      )
    );
    expect(applied).toMatchObject({
      execution: 'applied',
      destination,
    });
    expect(createDocument).toHaveBeenCalledTimes(1);

    const targetStore = window.collection.getDoc(targetId)?.getStore();
    if (!targetStore) throw new Error('Target store was not provisioned.');
    expect(targetStore.getBlocksByFlavour('affine:page')).toHaveLength(1);
    expect(targetStore.getBlocksByFlavour('affine:surface')).toHaveLength(1);
    expect(targetStore.getBlocksByFlavour('affine:note')).toHaveLength(1);
    expect(targetStore.getBlocksByFlavour('affine:paragraph')).toHaveLength(1);
    const targetImages = targetStore.getModelsByFlavour('affine:image');
    expect(targetImages).toHaveLength(1);
    const targetAssetId = targetImages[0]?.props.sourceId;
    expect(typeof targetAssetId).toBe('string');
    expect(
      typeof targetAssetId === 'string'
        ? await targetStore.workspace.blobSync.get(targetAssetId)
        : null
    ).toBeTruthy();

    const retried = ok<CanvasReceipt>(
      await runtime.execute(
        'canvas_apply',
        { planId: plan.planId, requestId: 'native-new-document-apply' },
        { canWrite: true, canCreateDoc: true, taskId: 'native-new-document' }
      )
    );
    expect(retried.operationId).toBe(applied.operationId);
    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(targetStore.getBlocksByFlavour('affine:note')).toHaveLength(1);

    const reverted = ok<CanvasReceipt>(
      await runtime.execute(
        'canvas_operation',
        {
          action: 'revert',
          operationId: applied.operationId,
          requestId: 'native-new-document-revert',
        },
        { canWrite: true, canCreateDoc: true, taskId: 'native-new-document' }
      )
    );
    expect(reverted).toMatchObject({
      execution: 'reverted',
      destination,
    });
    expect(lifecycleRequests).toHaveLength(2);
    expect(
      new Set(lifecycleRequests.map(request => request.operationId)).size
    ).toBe(1);
    expect(targetStore.getBlocksByFlavour('affine:page')).toHaveLength(1);
    expect(targetStore.getBlocksByFlavour('affine:surface')).toHaveLength(1);
    expect(targetStore.getBlocksByFlavour('affine:note')).toHaveLength(0);
    expect(targetStore.getBlocksByFlavour('affine:image')).toHaveLength(0);

    expect(sourceStore.getAllModels()).toHaveLength(sourceBlockCount);
    expect(runtime.getContentRevision()).toBe(sourceRevision);
    runtime.dispose();
  });
});
