/** @vitest-environment happy-dom */
import type {
  DelegatedToolCancel,
  DelegatedToolRequest,
} from '@affine/realtime';
import type { EditorHost } from '@blocksuite/affine/std';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DelegatedEditorHost } from './delegated-editor-host';

const canvas = vi.hoisted(() => ({ execute: vi.fn(), dispose: vi.fn() }));
vi.mock('../canvas', () => ({
  CanvasRuntime: class {
    execute = canvas.execute;
    dispose = canvas.dispose;
  },
}));
vi.mock('./live-projection', () => ({
  getLiveEditorMode: () => 'edgeless',
  getLiveSelectionIds: () => [],
  lightEditorContext: () => ({}),
  readEditorState: (_host: unknown, id: string) => ({ editor_state_id: id }),
  readNodes: vi.fn(),
  readSelection: vi.fn(),
  snapshotDocument: vi.fn(),
}));

function fixture(openDocument?: (input: { docId: string }) => void) {
  const blocks = new Subject<void>();
  const viewport = new Subject<void>();
  const requests = new Subject<DelegatedToolRequest | DelegatedToolCancel>();
  const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
  const host = new DelegatedEditorHost({
    workspaceId: 'ws',
    docId: 'doc',
    sessionId: 'session',
    openDocument,
    realtime: {
      subscribe: () => requests,
      request: async (op: string, input: Record<string, unknown>) => {
        calls.push({ op, input });
        return { ok: true };
      },
    } as never,
    host: {
      store: { readonly$: { value: false }, slots: { blockUpdated: blocks } },
      selection: { slots: { changed: new Subject() } },
      std: {
        get: () => ({
          viewport: { viewportUpdated: viewport, sizeUpdated: new Subject() },
        }),
      },
    } as unknown as EditorHost,
  });
  const start = async () => {
    await host.start();
    const editorStateId = calls.find(call => call.op.endsWith('.upsert'))!.input
      .editorStateId as string;
    const request: DelegatedToolRequest = {
      type: 'request',
      tool: 'frontend_canvas',
      requestId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      toolCallId: 'call',
      workspaceId: 'ws',
      docId: 'doc',
      sessionId: 'session',
      clientId: host.clientId,
      editorStateId,
      deadlineAt: Date.now() + 15_000,
      args: {
        tool: 'canvas_apply',
        planId: 'plan',
        requestId: 'logical-request',
      },
      canvasAuthorization: { canWrite: true, canCreateDoc: false },
    };
    return request;
  };
  const response = () =>
    calls.find(call => call.op.endsWith('.respond'))?.input;
  return { host, blocks, viewport, requests, calls, start, response };
}

describe('canvas delegated editor protocol', () => {
  const hosts: DelegatedEditorHost[] = [];
  beforeEach(() => {
    canvas.execute.mockReset();
    canvas.dispose.mockReset();
  });
  afterEach(() => hosts.splice(0).forEach(host => host.dispose()));

  it('acknowledges a focus handoff before navigation can unmount and cancel the source host', async () => {
    const navigation = vi.fn(() => {
      expect(f.response()).toMatchObject({
        result: { ok: true, data: { navigation: { docId: 'new-doc' } } },
      });
      f.host.dispose();
    });
    const f = fixture(navigation);
    hosts.push(f.host);
    canvas.execute.mockResolvedValue({
      ok: true,
      data: { navigation: { docId: 'new-doc' } },
    });
    const request = await f.start();
    f.requests.next({
      ...request,
      args: {
        tool: 'canvas_focus',
        destination: {
          type: 'new_document',
          workspaceId: 'ws',
          title: 'New',
          reservedDocumentId: 'new-doc',
        },
        scope: {},
      },
    });
    await vi.waitFor(() =>
      expect(navigation).toHaveBeenCalledWith({ docId: 'new-doc' })
    );
  });

  it('acknowledges a commit despite viewport and content changes, preserving request identity', async () => {
    const f = fixture();
    hosts.push(f.host);
    const request = await f.start();
    f.viewport.next();
    canvas.execute.mockImplementation(async () => {
      f.blocks.next();
      return {
        ok: true,
        data: {
          operationId: 'op',
          execution: 'applied',
          beforeRevision: 'r1',
          afterRevision: 'r2',
        },
      };
    });
    f.requests.next(request);
    await vi.waitFor(() => expect(f.response()).toBeDefined());
    expect(f.response()).toMatchObject({
      editorStateId: request.editorStateId,
      result: {
        ok: true,
        editor_state_id: request.editorStateId,
        data: { execution: 'applied', afterRevision: 'r2' },
      },
    });
    const result = f.response()!.result as Record<string, unknown>;
    expect(result.editor_state_after_id).not.toBe(request.editorStateId);
    expect(canvas.execute).toHaveBeenCalledOnce();
  });

  it('retains the stale-state guard for existing read tools', async () => {
    const f = fixture();
    hosts.push(f.host);
    const request = await f.start();
    f.blocks.next();
    f.requests.next({
      ...request,
      tool: 'frontend_get_editor_state',
      args: {},
    });
    await vi.waitFor(() => expect(f.response()).toBeDefined());
    expect(f.response()).toMatchObject({
      error: { code: 'EDITOR_STATE_CHANGED' },
    });
    expect(canvas.execute).not.toHaveBeenCalled();
  });

  it('takes permissions and task identity from the server, not model arguments', async () => {
    const f = fixture();
    hosts.push(f.host);
    const request = await f.start();
    canvas.execute.mockResolvedValue({
      ok: false,
      error: { code: 'PERMISSION_DENIED', message: 'Read-only.' },
    });
    f.requests.next({
      ...request,
      canvasAuthorization: { canWrite: false, canCreateDoc: false },
      args: { ...request.args, canWrite: true, taskId: 'spoofed' },
    });
    await vi.waitFor(() => expect(f.response()).toBeDefined());
    expect(canvas.execute.mock.calls[0][2]).toMatchObject({
      taskId: request.runId,
      canWrite: false,
      canCreateDoc: false,
    });
    expect(f.response()).toMatchObject({
      result: { ok: false, error: { code: 'PERMISSION_DENIED' } },
    });
  });

  it('does not execute an expired request or one for another document', async () => {
    const f = fixture();
    hosts.push(f.host);
    const request = await f.start();
    f.requests.next({ ...request, deadlineAt: Date.now() - 1 });
    await vi.waitFor(() => expect(f.response()).toBeDefined());
    expect(f.response()).toMatchObject({ error: { code: 'BUDGET_EXCEEDED' } });
    f.calls.length = 0;
    f.requests.next({ ...request, docId: 'other' });
    await vi.waitFor(() => expect(f.response()).toBeDefined());
    expect(f.response()).toMatchObject({
      error: { code: 'EDITOR_UNAVAILABLE' },
    });
    expect(canvas.execute).not.toHaveBeenCalled();
  });

  it('propagates cancellation without claiming that an in-flight commit rolled back', async () => {
    const f = fixture();
    hosts.push(f.host);
    const request = await f.start();
    let finish!: (result: unknown) => void;
    canvas.execute.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    f.requests.next(request);
    await vi.waitFor(() => expect(canvas.execute).toHaveBeenCalledOnce());
    const signal = canvas.execute.mock.calls[0][2].signal as AbortSignal;
    f.requests.next({ ...request, type: 'cancel', reason: 'aborted' });
    expect(signal.aborted).toBe(true);
    finish({ ok: true, data: { execution: 'applied' } });
    await Promise.resolve();
    expect(f.response()).toBeUndefined();
  });
});
