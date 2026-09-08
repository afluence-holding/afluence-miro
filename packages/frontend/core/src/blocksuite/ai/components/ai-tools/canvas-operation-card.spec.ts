/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';

import {
  canvasOperationCardModel,
  dispatchCanvasOperationAction,
} from './canvas-operation-card';

describe('canvas operation card', () => {
  it('shows a truthful sync-pending receipt with a safe artifact and bounded actions', () => {
    const model = canvasOperationCardModel({
      ok: true,
      binding: { workspaceId: 'workspace', docId: 'doc', clientId: 'client' },
      data: {
        operationId: 'operation-1',
        execution: 'applied',
        persistence: 'sync_pending',
        contentRevision: 'canvas:v1:2:1',
        createdIds: ['shape-1'],
        updatedIds: [],
        revert: { available: true },
        artifact: {
          url: 'https://assets.example/canvas.png',
          mimeType: 'image/png',
        },
      },
    });

    expect(model.title).toBe('Cambios aplicados; sincronización pendiente');
    expect(model.downloadUrl).toBe('https://assets.example/canvas.png');
    expect(model.focus).toMatchObject({
      tool: 'canvas_focus',
      args: { destination: { documentId: 'doc' }, scope: { ids: ['shape-1'] } },
    });
    expect(model.revert).toMatchObject({
      tool: 'canvas_operation',
      args: { action: 'revert', operationId: 'operation-1' },
      binding: { workspaceId: 'workspace', docId: 'doc', clientId: 'client' },
    });
  });

  it('does not create a client mutation when the trusted binding or callback is absent', async () => {
    const model = canvasOperationCardModel({
      ok: true,
      data: {
        operationId: 'operation-1',
        execution: 'applied',
        createdIds: ['shape-1'],
        revert: { available: true },
      },
    });
    expect(model.focus).toBeUndefined();
    expect(model.revert).toBeUndefined();
    await expect(
      dispatchCanvasOperationAction(undefined, model.revert)
    ).resolves.toBe(false);
  });

  it('never exposes a javascript artifact URL as a download target', () => {
    const model = canvasOperationCardModel({
      ok: true,
      data: {
        artifact: { url: 'javascript:alert(1)', mimeType: 'image/png' },
      },
    });

    expect(model.downloadUrl).toBeUndefined();
  });

  it('focuses the actual new document and preserves the native download extension', () => {
    const model = canvasOperationCardModel({
      ok: true,
      binding: {
        workspaceId: 'workspace',
        docId: 'source',
        clientId: 'client',
      },
      data: {
        operationId: 'operation-1',
        execution: 'applied',
        destination: {
          type: 'new_document',
          workspaceId: 'workspace',
          title: 'Funnel',
          reservedDocumentId: 'new-doc',
        },
        artifact: {
          url: '/api/copilot/canvas-artifact?handle=signed',
          mimeType: 'application/zip',
          fileName: 'funnel.bs.zip',
        },
      },
    });
    expect(model.focus?.args.destination).toMatchObject({
      type: 'new_document',
      reservedDocumentId: 'new-doc',
    });
    expect(model.focus?.binding.docId).toBe('source');
    expect(model.downloadName).toBe('funnel.bs.zip');
  });

  it('surfaces semantic failures from the server callback instead of claiming success', async () => {
    const action = canvasOperationCardModel({
      ok: true,
      binding: { workspaceId: 'workspace', docId: 'doc' },
      data: {
        operationId: 'operation-1',
        execution: 'applied',
        revert: { available: true },
      },
    }).revert;
    expect(action).toBeDefined();
    await expect(
      dispatchCanvasOperationAction(
        () => ({
          ok: false,
          error: { code: 'PERMISSION_DENIED', message: 'Acceso revocado' },
        }),
        action
      )
    ).rejects.toThrow('Acceso revocado');
    const result = {
      ok: true,
      binding: action?.binding,
      data: {
        operationId: 'undo-1',
        parentOperationId: 'operation-1',
        execution: 'reverted',
      },
    };
    await expect(
      dispatchCanvasOperationAction(() => result, action)
    ).resolves.toBe(result);
    expect(canvasOperationCardModel(result).redo?.args.operationId).toBe(
      'operation-1'
    );
  });

  it('shows resumable import progress and sends a fresh resume command to the same durable job', () => {
    const model = canvasOperationCardModel({
      ok: true,
      binding: { workspaceId: 'workspace', docId: 'doc' },
      data: {
        operationId: 'native-job',
        execution: 'partial',
        persistence: 'sync_pending',
        progress: { completed: 100, total: 220, canResume: true },
        revert: { available: true },
      },
    });
    expect(model.title).toBe('Cambios aplicados parcialmente');
    expect(model.detail).toContain('100 de 220');
    expect(model.resume?.args).toMatchObject({
      operationId: 'native-job',
      action: 'resume',
      requestId: expect.any(String),
    });
    expect(model.cancel?.args.action).toBe('cancel');
    expect(model.revert).toBeDefined();
  });
});
