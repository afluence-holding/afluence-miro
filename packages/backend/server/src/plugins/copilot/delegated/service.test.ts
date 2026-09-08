import 'reflect-metadata';

import type {
  DelegatedEditorLeaseInput,
  DelegatedToolRequest,
} from '@affine/realtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PermissionAccess } from '../../../core/permission';
import type { RealtimePublisher } from '../../../core/realtime';
import { DelegatedEditorService } from './service';

const metric = vi.hoisted(() => ({
  add: vi.fn(),
  record: vi.fn(),
}));
vi.mock('../../../base', () => ({
  OnEvent: () => () => undefined,
  metrics: {
    ai: {
      counter: () => ({ add: metric.add }),
      histogram: () => ({ record: metric.record }),
    },
  },
}));
vi.mock('../../../core/permission', () => ({ PermissionAccess: class {} }));
vi.mock('../../../core/realtime', () => ({
  RealtimePublisher: class {},
  realtimeUserRoom: (user: string, topic: string) => `${user}:${topic}`,
}));

function fixture() {
  const published: DelegatedToolRequest[] = [];
  const can = vi.fn(async (_permission: string) => true);
  const claims = new Map<string, unknown>();
  const locked = new Set<string>();
  const cache = {
    get: vi.fn(async (key: string) => claims.get(key)),
    setnx: vi.fn(async (key: string, value: unknown) => {
      if (claims.has(key)) return false;
      claims.set(key, value);
      return true;
    }),
  };
  const mutex = {
    acquire: vi.fn(async (key: string) => {
      if (locked.has(key)) return undefined;
      locked.add(key);
      return { release: async () => locked.delete(key) };
    }),
  };
  const builder = {
    can,
    doc: vi.fn(() => builder),
    workspace: vi.fn(() => builder),
    user: vi.fn(() => builder),
  };
  const service = new DelegatedEditorService(
    {
      publish: (
        _topic: unknown,
        _input: unknown,
        event: DelegatedToolRequest
      ) => published.push(event),
    } as unknown as RealtimePublisher,
    builder as unknown as PermissionAccess,
    cache as never,
    mutex as never
  );
  const lease: DelegatedEditorLeaseInput = {
    clientId: 'client',
    sessionId: 'session',
    workspaceId: 'ws',
    docId: 'doc',
    editorStateId: 'state',
    mode: 'edgeless',
    readonly: false,
    focused: true,
    capabilities: ['frontend_canvas'],
  };
  service.upsert('user', 'connection', lease);
  const options = { user: 'user', workspace: 'ws', session: 'session' };
  const respond = async (data: unknown = { execution: 'applied' }) => {
    await vi.waitFor(() => expect(published).toHaveLength(1));
    const request = published[0];
    service.receive('user', {
      ...request,
      result: {
        editor_state_id: request.editorStateId,
        editor_state_after_id: 'state-after',
        ok: true,
        data,
      },
    });
    return request;
  };
  return {
    service,
    published,
    can,
    lease,
    options,
    respond,
    cache,
    mutex,
    builder,
  };
}

describe('server canvas delegation', () => {
  beforeEach(() => {
    vi.stubEnv('AFFINE_CANVAS_AI_WRITES', '1');
    vi.stubGlobal('env', { dev: false, namespaces: { canary: false } });
    metric.add.mockClear();
    metric.record.mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('authorizes the bound document and accepts an acknowledged changed revision', async () => {
    const f = fixture();
    const result = f.service.execute(f.options, 'frontend_canvas', {
      tool: 'canvas_apply',
      planId: 'plan',
      requestId: 'stable',
    });
    const request = await f.respond({
      execution: 'applied',
      contentRevision: 'after',
    });
    expect(f.can).toHaveBeenCalledWith('Doc.Update');
    expect(request.canvasAuthorization).toEqual({
      canWrite: true,
      canCreateDoc: true,
    });
    expect(await result).toMatchObject({
      ok: true,
      data: { execution: 'applied', contentRevision: 'after' },
    });
    expect(metric.add).toHaveBeenCalledWith(1, {
      tool: 'canvas_apply',
      outcome: 'applied',
      execution: 'applied',
      persistence: 'none',
    });
    expect(metric.record).toHaveBeenCalledWith(expect.any(Number), {
      tool: 'canvas_apply',
      outcome: 'applied',
    });
  });

  it('rejects denied permission and a disabled write flag before dispatch', async () => {
    const f = fixture();
    f.can.mockResolvedValue(false);
    expect(
      await f.service.execute(f.options, 'frontend_canvas', {
        tool: 'canvas_apply',
      })
    ).toMatchObject({ error: { code: 'PERMISSION_DENIED' } });
    f.can.mockResolvedValue(true);
    vi.stubEnv('AFFINE_CANVAS_AI_WRITES', '0');
    for (const args of [
      { tool: 'canvas_apply' },
      { tool: 'canvas_import' },
      { tool: 'canvas_operation', action: 'revert' },
    ]) {
      expect(
        await f.service.execute(f.options, 'frontend_canvas', args)
      ).toMatchObject({ error: { code: 'PERMISSION_DENIED' } });
    }
    expect(f.published).toHaveLength(0);
  });

  it('keeps recovery status available when new writes are disabled', async () => {
    const f = fixture();
    vi.stubEnv('AFFINE_CANVAS_AI_WRITES', '0');
    const result = f.service.execute(f.options, 'frontend_canvas', {
      tool: 'canvas_operation',
      action: 'status',
      requestId: 'stable',
    });
    const request = await f.respond();
    expect(request.canvasAuthorization?.canWrite).toBe(false);
    expect(await result).toMatchObject({ ok: true });
  });

  it('requires exact MCP editor identity and does not invent a chat session', async () => {
    const f = fixture();
    expect(
      await f.service.executeCanvas('other-user', 'ws', 'client', 'doc', {})
    ).toMatchObject({ error: { code: 'EDITOR_UNAVAILABLE' } });
    expect(
      await f.service.executeCanvas('user', 'ws', 'client', 'other-doc', {})
    ).toMatchObject({ error: { code: 'EDITOR_UNAVAILABLE' } });
    const result = f.service.executeCanvas('user', 'ws', 'client', 'doc', {
      tool: 'canvas_read',
    });
    const request = await f.respond({ nodes: [] });
    expect(request.sessionId).toBe('session');
    expect(await result).toMatchObject({ ok: true, data: { nodes: [] } });
  });

  it('authorizes a target separately from the active source lease', async () => {
    const f = fixture();
    f.can.mockImplementation(
      async (permission: string) => permission !== 'Doc.Update'
    );
    await expect(
      f.service.authorizeCanvasTarget(
        'user',
        'ws',
        'client',
        'doc',
        'revoked-target',
        false
      )
    ).resolves.toEqual({ canRead: true, canWrite: false, canCreateDoc: false });
    expect(f.can).toHaveBeenCalledWith('Doc.Read');
    expect(f.can).toHaveBeenCalledWith('Doc.Update');

    await expect(
      f.service.authorizeCanvasTarget(
        'user',
        'ws',
        'client',
        'doc',
        'new-target',
        true
      )
    ).resolves.toEqual({ canRead: true, canWrite: false, canCreateDoc: true });

    await expect(
      f.service.authorizeCanvasTarget(
        'user',
        'ws',
        'client',
        'wrong-source',
        'new-target',
        true
      )
    ).resolves.toMatchObject({ error: { code: 'EDITOR_UNAVAILABLE' } });
  });

  it('does not pick the newest of two matching focused canvas editors', () => {
    const f = fixture();
    f.service.upsert('user', 'connection-two', {
      ...f.lease,
      clientId: 'other-client',
    });
    expect(f.service.getLease(f.options, 'frontend_canvas')).toBeNull();
    expect(f.service.listAvailableEditors('other-user', 'ws')).toEqual([]);
    expect(f.service.listAvailableEditors('user', 'ws')).toHaveLength(2);
  });

  it('discovers only readable, live Edgeless canvas editors for the actor', async () => {
    const readable = new Set(
      Array.from({ length: 21 }, (_value, index) => `doc-${index}`)
    );
    const access = {
      user: (userId: string) => ({
        workspace: (workspaceId: string) => ({
          doc: (docId: string) => ({
            can: async (permission: string) =>
              userId === 'user' &&
              workspaceId === 'ws' &&
              permission === 'Doc.Read' &&
              readable.has(docId),
          }),
        }),
      }),
    };
    const service = new DelegatedEditorService(
      { publish: vi.fn() } as unknown as RealtimePublisher,
      access as unknown as PermissionAccess
    );
    const add = (
      clientId: string,
      docId: string,
      overrides: Partial<DelegatedEditorLeaseInput> = {},
      userId = 'user'
    ) =>
      service.upsert(userId, 'connection', {
        clientId,
        sessionId: 'session',
        workspaceId: 'ws',
        docId,
        editorStateId: `state-${clientId}`,
        mode: 'edgeless',
        readonly: false,
        focused: false,
        capabilities: ['frontend_canvas'],
        ...overrides,
      });

    for (let index = 0; index < 21; index++) {
      const suffix = String(index).padStart(2, '0');
      add(`client-${suffix}`, `doc-${index}`);
    }
    add('other-workspace', 'doc-0', { workspaceId: 'other-workspace' });
    add('page-editor', 'doc-0', { mode: 'page' });
    add('missing-capability', 'doc-0', { capabilities: [] });
    add('denied-editor', 'denied-doc');
    add('other-actor', 'doc-0', {}, 'other-user');
    add('expired-editor', 'doc-0');
    const expired = (
      service as unknown as {
        leases: Map<string, { expiresAt: number }>;
      }
    ).leases.get(service.leaseKey('user', 'expired-editor'));
    if (!expired) throw new Error('expected an expired editor lease');
    expired.expiresAt = Date.now() - 1;

    const result = await service.listCanvasEditors('user', 'ws');

    expect(result.truncated).toBe(true);
    expect(result.editors).toHaveLength(20);
    expect(result.editors).toEqual(
      Array.from({ length: 20 }, (_value, index) => ({
        clientId: `client-${String(index).padStart(2, '0')}`,
        docId: `doc-${index}`,
        expiresAt: expect.any(Number),
        mode: 'edgeless',
      }))
    );
  });

  it('serializes one stable apply across two explicitly bound editors, then permits status reconciliation', async () => {
    const f = fixture();
    f.service.upsert('user', 'connection-two', {
      ...f.lease,
      clientId: 'client-two',
      editorStateId: 'state-two',
    });
    const args = { tool: 'canvas_apply', planId: 'plan', requestId: 'stable' };
    const first = f.service.executeCanvas('user', 'ws', 'client', 'doc', args);
    await vi.waitFor(() => expect(f.published).toHaveLength(1));
    const retry = f.service.executeCanvas(
      'user',
      'ws',
      'client-two',
      'doc',
      args
    );
    expect(f.published).toHaveLength(1);

    const apply = f.published[0];
    f.service.receive('user', {
      ...apply,
      result: {
        editor_state_id: apply.editorStateId,
        ok: true,
        data: { execution: 'applied', contentRevision: 'after' },
      },
    });
    await expect(first).resolves.toMatchObject({
      ok: true,
      data: { execution: 'applied' },
    });
    await expect(retry).resolves.toMatchObject({
      ok: true,
      data: { execution: 'applied' },
    });
    expect(f.published).toHaveLength(1);

    const status = f.service.executeCanvas('user', 'ws', 'client-two', 'doc', {
      tool: 'canvas_operation',
      action: 'status',
      requestId: 'stable',
    });
    await vi.waitFor(() => expect(f.published).toHaveLength(2));
    const query = f.published[1];
    expect(query.args).toMatchObject({
      tool: 'canvas_operation',
      action: 'status',
      requestId: 'stable',
    });
    f.service.receive('user', {
      ...query,
      result: {
        editor_state_id: query.editorStateId,
        ok: true,
        data: { execution: 'applied' },
      },
    });
    await expect(status).resolves.toMatchObject({
      ok: true,
      data: { execution: 'applied' },
    });
  });

  it('rejects a requestId reused with another apply payload before publishing it', async () => {
    const f = fixture();
    const first = f.service.execute(f.options, 'frontend_canvas', {
      tool: 'canvas_apply',
      planId: 'plan-a',
      requestId: 'stable',
    });
    await vi.waitFor(() => expect(f.published).toHaveLength(1));
    await expect(
      f.service.executeCanvas('user', 'ws', 'client', 'doc', {
        tool: 'canvas_apply',
        planId: 'plan-b',
        requestId: 'stable',
      })
    ).resolves.toMatchObject({ error: { code: 'OPERATION_CONFLICT' } });
    expect(f.published).toHaveLength(1);
    const request = f.published[0];
    f.service.receive('user', {
      ...request,
      result: {
        editor_state_id: request.editorStateId,
        ok: true,
        data: { execution: 'applied' },
      },
    });
    await expect(first).resolves.toMatchObject({ ok: true });
  });

  it('does not dispatch a different write while the document write lock is held', async () => {
    const f = fixture();
    const first = f.service.execute(f.options, 'frontend_canvas', {
      tool: 'canvas_apply',
      planId: 'plan-a',
      requestId: 'one',
    });
    await vi.waitFor(() => expect(f.published).toHaveLength(1));
    await expect(
      f.service.executeCanvas('user', 'ws', 'client', 'doc', {
        tool: 'canvas_apply',
        planId: 'plan-b',
        requestId: 'two',
      })
    ).resolves.toMatchObject({ error: { code: 'OPERATION_CONFLICT' } });
    expect(f.published).toHaveLength(1);
    const request = f.published[0];
    f.service.receive('user', {
      ...request,
      result: {
        editor_state_id: request.editorStateId,
        ok: true,
        data: { execution: 'applied' },
      },
    });
    await first;
  });

  it('uses the shared claim and document lock across service replicas', async () => {
    const primary = fixture();
    const replicaPublished: DelegatedToolRequest[] = [];
    const replica = new DelegatedEditorService(
      {
        publish: (
          _topic: unknown,
          _input: unknown,
          event: DelegatedToolRequest
        ) => replicaPublished.push(event),
      } as unknown as RealtimePublisher,
      primary.builder as unknown as PermissionAccess,
      primary.cache as never,
      primary.mutex as never
    );
    replica.upsert('user', 'replica-connection', {
      ...primary.lease,
      clientId: 'replica-client',
      editorStateId: 'replica-state',
    });
    const args = {
      tool: 'canvas_apply',
      planId: 'plan',
      requestId: 'shared-stable',
    };
    const first = primary.service.executeCanvas(
      'user',
      'ws',
      'client',
      'doc',
      args
    );
    await vi.waitFor(() => expect(primary.published).toHaveLength(1));
    await expect(
      replica.executeCanvas('user', 'ws', 'replica-client', 'doc', args)
    ).resolves.toMatchObject({ error: { code: 'OPERATION_CONFLICT' } });
    expect(replicaPublished).toHaveLength(0);
    const request = primary.published[0];
    primary.service.receive('user', {
      ...request,
      result: {
        editor_state_id: request.editorStateId,
        ok: true,
        data: { execution: 'applied' },
      },
    });
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(
      replica.executeCanvas('user', 'ws', 'replica-client', 'doc', args)
    ).resolves.toMatchObject({ error: { code: 'OPERATION_CONFLICT' } });
    expect(replicaPublished).toHaveLength(0);
  });

  it('serializes cancel, revert, and redo with apply while status remains available for reconciliation', async () => {
    const f = fixture();
    const apply = f.service.executeCanvas('user', 'ws', 'client', 'doc', {
      tool: 'canvas_apply',
      planId: 'plan',
      requestId: 'write-one',
    });
    await vi.waitFor(() => expect(f.published).toHaveLength(1));

    for (const action of ['cancel', 'revert', 'redo'] as const) {
      await expect(
        f.service.executeCanvas('user', 'ws', 'client', 'doc', {
          tool: 'canvas_operation',
          action,
          operationId: 'operation-one',
        })
      ).resolves.toMatchObject({ error: { code: 'OPERATION_CONFLICT' } });
    }
    expect(f.published).toHaveLength(1);

    const status = f.service.executeCanvas('user', 'ws', 'client', 'doc', {
      tool: 'canvas_operation',
      action: 'status',
      requestId: 'write-one',
    });
    await vi.waitFor(() => expect(f.published).toHaveLength(2));
    const statusRequest = f.published[1];
    expect(statusRequest.args).toMatchObject({
      tool: 'canvas_operation',
      action: 'status',
    });
    f.service.receive('user', {
      ...statusRequest,
      result: {
        editor_state_id: statusRequest.editorStateId,
        ok: true,
        data: { execution: 'applying' },
      },
    });
    await expect(status).resolves.toMatchObject({
      ok: true,
      data: { execution: 'applying' },
    });

    const applyRequest = f.published[0];
    f.service.receive('user', {
      ...applyRequest,
      result: {
        editor_state_id: applyRequest.editorStateId,
        ok: true,
        data: { execution: 'applied' },
      },
    });
    await expect(apply).resolves.toMatchObject({
      ok: true,
      data: { execution: 'applied' },
    });

    for (const action of ['cancel', 'revert', 'redo'] as const) {
      const operation = f.service.executeCanvas('user', 'ws', 'client', 'doc', {
        tool: 'canvas_operation',
        action,
        operationId: 'operation-one',
      });
      await vi.waitFor(() => expect(f.published).toHaveLength(3));
      const request = f.published[2];
      f.service.receive('user', {
        ...request,
        result: {
          editor_state_id: request.editorStateId,
          ok: true,
          data: { execution: action === 'cancel' ? 'cancelled' : 'applied' },
        },
      });
      await expect(operation).resolves.toMatchObject({ ok: true });
      f.published.splice(2, 1);
    }
  });

  it('authorizes a created-document target independently and rejects workspace or source-binding swaps', async () => {
    const f = fixture();
    await expect(
      f.service.authorizeCanvasTarget(
        'user',
        'ws',
        'client',
        'doc',
        'created-target',
        true
      )
    ).resolves.toEqual({ canRead: true, canWrite: true, canCreateDoc: true });

    await expect(
      f.service.authorizeCanvasTarget(
        'user',
        'other-workspace',
        'client',
        'doc',
        'created-target',
        true
      )
    ).resolves.toMatchObject({ error: { code: 'EDITOR_UNAVAILABLE' } });

    f.can.mockImplementation(
      async (permission: string) => permission !== 'Doc.Update'
    );
    await expect(
      f.service.authorizeCanvasTarget(
        'user',
        'ws',
        'client',
        'doc',
        'created-target',
        false
      )
    ).resolves.toEqual({ canRead: true, canWrite: false, canCreateDoc: false });
  });

  it('requires exact response identity and reports disconnect as uncertain, not rolled back', async () => {
    const f = fixture();
    const result = f.service.execute(f.options, 'frontend_canvas', {
      tool: 'canvas_apply',
      requestId: 'stable',
    });
    await vi.waitFor(() => expect(f.published).toHaveLength(1));
    const request = f.published[0];
    expect(
      f.service.receive('other-user', {
        ...request,
        result: { editor_state_id: request.editorStateId },
      })
    ).toBe(false);
    expect(
      f.service.receive('user', {
        ...request,
        docId: 'other',
        result: { editor_state_id: request.editorStateId },
      })
    ).toBe(false);
    f.service.onDisconnect({ connectionId: 'connection' });
    expect(await result).toMatchObject({
      error: { code: 'OPERATION_CONFLICT', retryable: false },
    });
  });

  it('never dispatches an already cancelled request', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await f.service.execute(
      f.options,
      'frontend_canvas',
      { tool: 'canvas_apply' },
      controller.signal
    );
    expect(f.published).toHaveLength(0);
  });

  it('rechecks the binding after an asynchronous permission decision', async () => {
    const f = fixture();
    let allow!: (value: boolean) => void;
    f.can.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          allow = resolve;
        })
    );
    const result = f.service.execute(f.options, 'frontend_canvas', {
      tool: 'canvas_apply',
    });
    f.service.release('user', 'client', 'state');
    allow(true);
    expect(await result).toMatchObject({
      error: { code: 'EDITOR_UNAVAILABLE' },
    });
    expect(f.published).toHaveLength(0);
  });
});

describe('canvas feature flags', () => {
  beforeEach(() => {
    vi.stubEnv('AFFINE_CANVAS_AI_WRITES', '1');
    vi.stubGlobal('env', { dev: false, namespaces: { canary: false } });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('blocks disabled design, import, and export before they reach an editor', async () => {
    const f = fixture();
    for (const [variable, tool] of [
      ['AFFINE_CANVAS_AI_DESIGN', 'canvas_layout'],
      ['AFFINE_CANVAS_AI_IMPORT', 'canvas_import'],
      ['AFFINE_CANVAS_AI_EXPORT', 'canvas_export'],
    ] as const) {
      vi.stubEnv(variable, '0');
      await expect(
        f.service.execute(f.options, 'frontend_canvas', { tool })
      ).resolves.toMatchObject({
        error: { code: 'UNSUPPORTED_CAPABILITY', retryable: false },
      });
      vi.unstubAllEnvs();
      vi.stubEnv('AFFINE_CANVAS_AI_WRITES', '1');
    }
    expect(f.published).toHaveLength(0);
  });

  it('keeps MCP status read-only while rejecting MCP canvas writes when disabled', async () => {
    const f = fixture();
    vi.stubEnv('AFFINE_CANVAS_AI_MCP_WRITES', '0');

    for (const args of [
      { tool: 'canvas_apply', planId: 'plan', requestId: 'mcp-write' },
      { tool: 'canvas_import', format: 'recipe' },
      { tool: 'canvas_operation', action: 'revert', operationId: 'mcp-write' },
    ]) {
      await expect(
        f.service.executeCanvasFromMcp('user', 'ws', 'client', 'doc', args)
      ).resolves.toMatchObject({
        error: { code: 'UNSUPPORTED_CAPABILITY', retryable: false },
      });
    }
    const status = f.service.executeCanvasFromMcp(
      'user',
      'ws',
      'client',
      'doc',
      {
        tool: 'canvas_operation',
        action: 'status',
        requestId: 'mcp-write',
      }
    );
    const request = await f.respond({ execution: 'ready' });
    expect(request.tool).toBe('frontend_canvas');
    await expect(status).resolves.toMatchObject({ ok: true });
  });

  it('defensively rejects a mutation when an MCP caller is marked read-only', async () => {
    const f = fixture();

    await expect(
      f.service.executeCanvasFromMcp(
        'user',
        'ws',
        'client',
        'doc',
        { tool: 'canvas_apply', planId: 'plan', requestId: 'request' },
        undefined,
        undefined,
        false
      )
    ).resolves.toMatchObject({
      error: { code: 'PERMISSION_DENIED', retryable: false },
    });
    expect(f.published).toHaveLength(0);
  });

  it('passes read-only MCP authorization to the editor and filters its manifest', async () => {
    const f = fixture();
    const capabilities = f.service.executeCanvasFromMcp(
      'user',
      'ws',
      'client',
      'doc',
      {
        tool: 'canvas_capabilities',
        destination: { type: 'existing', documentId: 'doc' },
      },
      undefined,
      undefined,
      false
    );
    const request = await f.respond({
      tools: [
        'canvas_capabilities',
        'canvas_read',
        'canvas_apply',
        'canvas_operation',
        'canvas_import',
      ],
      authorization: { canWrite: true, canCreateDoc: true },
      nodeKinds: [
        { kind: 'shape', operations: ['read', 'create', 'update', 'export'] },
      ],
      formats: [{ format: 'recipe', import: 'supported', export: 'supported' }],
    });

    expect(request.canvasAuthorization).toEqual({
      canWrite: false,
      canCreateDoc: false,
    });
    await expect(capabilities).resolves.toMatchObject({
      ok: true,
      data: {
        tools: ['canvas_capabilities', 'canvas_read', 'canvas_operation'],
        authorization: { canWrite: false, canCreateDoc: false },
        nodeKinds: [{ operations: ['read', 'export'] }],
        formats: [{ import: 'unavailable', export: 'supported' }],
      },
    });
  });

  it('filters disabled features from the capability result', async () => {
    const f = fixture();
    vi.stubEnv('AFFINE_CANVAS_AI_DESIGN', '0');
    vi.stubEnv('AFFINE_CANVAS_AI_IMPORT', '0');
    const capabilities = f.service.execute(f.options, 'frontend_canvas', {
      tool: 'canvas_capabilities',
    });
    await f.respond({
      tools: [
        'canvas_capabilities',
        'canvas_layout',
        'canvas_import',
        'canvas_export',
        'canvas_read',
      ],
    });
    await expect(capabilities).resolves.toMatchObject({
      ok: true,
      data: {
        tools: ['canvas_capabilities', 'canvas_export', 'canvas_read'],
      },
    });
  });
});
