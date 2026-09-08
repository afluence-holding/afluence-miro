/** @vitest-environment node */
import type {
  CanvasNode,
  CanvasOperation,
  CanvasPlan,
  CanvasReceipt,
} from '@affine/realtime/canvas';
import type { EditorHost } from '@blocksuite/affine/std';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

const adapterState = vi.hoisted(() => ({
  throwAfterCreate: undefined as number | undefined,
  silentUpdate: false,
  cascadeDeletes: false,
  failFontReadiness: false,
  createCalls: 0,
}));

vi.mock('./native-adapter', () => {
  class NativeCanvasAdapter {
    readonly nodes: Y.Map<CanvasNode>;
    readonly gfx = {
      viewport: { setViewportByBound: vi.fn() },
      selection: { set: vi.fn() },
    };

    constructor(host: EditorHost) {
      this.nodes = (
        host as unknown as TestHost
      ).store.spaceDoc.getMap<CanvasNode>('test:canvas-nodes');
    }

    get allNodes() {
      return [...this.nodes.values()].map(node => structuredClone(node));
    }

    getNode(id: string) {
      const node = this.nodes.get(id);
      return node && structuredClone(node);
    }

    getModel(id: string) {
      return this.nodes.has(id) ? { id, isLocked: () => false } : undefined;
    }

    get blockCapabilities() {
      return [];
    }

    validateNativeBlock() {
      return { ok: true, errors: [] };
    }

    validateNativePrimitive() {
      return { ok: true, errors: [] };
    }

    create(node: CanvasNode) {
      adapterState.createCalls += 1;
      if (
        adapterState.failFontReadiness &&
        node.props.fontFamily === 'Missing Font'
      ) {
        throw new Error('FONT_UNAVAILABLE: Missing Font');
      }
      if (
        adapterState.throwAfterCreate !== undefined &&
        adapterState.createCalls >= adapterState.throwAfterCreate
      ) {
        throw new Error('native adapter threw after a durable mutation');
      }
      this.nodes.set(node.id, structuredClone(node));
      return node.id;
    }

    update(id: string, patch: Partial<Omit<CanvasNode, 'id' | 'kind'>>) {
      if (adapterState.silentUpdate) return;
      const current = this.nodes.get(id);
      if (!current) throw new Error(`Element ${id} does not exist`);
      this.nodes.set(id, {
        ...current,
        ...structuredClone(patch),
        ...(patch.props ? { props: { ...current.props, ...patch.props } } : {}),
      });
    }

    setParent(id: string, parentId?: string) {
      this.update(id, { parentId });
    }

    delete(id: string) {
      this.nodes.delete(id);
      if (!adapterState.cascadeDeletes) return;
      for (const node of this.nodes.values()) {
        if (
          node.kind === 'connector' &&
          (node.sourceId === id || node.targetId === id)
        ) {
          this.nodes.delete(node.id);
        }
      }
    }

    async render() {
      return undefined;
    }
  }

  return { NativeCanvasAdapter, assertEditableProps: () => undefined };
});

import { CanvasRuntime } from './runtime';

const JOURNAL_KEY = 'affine:canvas-ai:operation-journal:v1';
const destination = { type: 'existing' as const, documentId: 'doc' };
const scope = {
  bounds: { x: -10_000, y: -10_000, w: 20_000, h: 20_000 },
};

interface TestHost {
  store: {
    spaceDoc: Y.Doc;
    readonly$: { value: boolean };
    captureSync: ReturnType<typeof vi.fn>;
  };
  viewportChanges: number;
}

function host(spaceDoc = new Y.Doc()): TestHost {
  return {
    store: { spaceDoc, readonly$: { value: false }, captureSync: vi.fn() },
    viewportChanges: 0,
  };
}

function runtime(testHost: TestHost) {
  return new CanvasRuntime({
    host: testHost as unknown as EditorHost,
    workspaceId: 'workspace',
    docId: 'doc',
  });
}

function node(id: string, overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id,
    kind: 'shape',
    bounds: { x: 0, y: 0, w: 100, h: 60 },
    props: { fillColor: 'red', text: id },
    ...overrides,
  };
}

function connector(id: string, sourceId: string, targetId: string): CanvasNode {
  return {
    id,
    kind: 'connector',
    bounds: { x: 0, y: 0, w: 100, h: 60 },
    props: {},
    sourceId,
    targetId,
  };
}

async function prepare(
  canvas: CanvasRuntime,
  operations: readonly CanvasOperation[],
  options: { parentOperationId?: string } = {}
) {
  const response = await canvas.execute(
    'canvas_validate',
    {
      destination,
      baseContentRevision: canvas.getContentRevision(),
      requestedScope: {
        bounds: { x: -10_000, y: -10_000, w: 20_000, h: 20_000 },
      },
      operations,
      ...options,
    },
    { canWrite: true }
  );
  expect(response.ok).toBe(true);
  if (!response.ok) throw new Error(response.error.message);
  return response.data.plan;
}

async function apply(
  canvas: CanvasRuntime,
  plan: CanvasPlan,
  requestId: string,
  repairIndex = 0
) {
  return canvas.execute(
    'canvas_apply',
    { planId: plan.planId, requestId },
    { canWrite: true, repairIndex }
  );
}

function receipt(response: Awaited<ReturnType<typeof apply>>): CanvasReceipt {
  expect(response, JSON.stringify(response)).toMatchObject({ ok: true });
  if (!response.ok) throw new Error(response.error.message);
  return response.data;
}

function nodes(testHost: TestHost) {
  return testHost.store.spaceDoc.getMap<CanvasNode>('test:canvas-nodes');
}

describe('CanvasRuntime durable executor invariants', () => {
  beforeEach(() => {
    adapterState.throwAfterCreate = undefined;
    adapterState.silentUpdate = false;
    adapterState.cascadeDeletes = false;
    adapterState.failFontReadiness = false;
    adapterState.createCalls = 0;
  });

  afterEach(() => vi.restoreAllMocks());

  it('does not duplicate nodes when the same request retries the same plan', async () => {
    const testHost = host();
    const canvas = runtime(testHost);
    const plan = await prepare(canvas, [{ type: 'create', node: node('one') }]);

    const first = receipt(await apply(canvas, plan, 'request-one'));
    const retry = receipt(await apply(canvas, plan, 'request-one'));

    expect(retry.operationId).toBe(first.operationId);
    expect([...nodes(testHost).keys()]).toEqual(['one']);
    expect(adapterState.createCalls).toBe(1);
  });

  it('recovers a prior receipt after reload even though the prepared-plan cache is empty', async () => {
    const testHost = host();
    const original = runtime(testHost);
    const plan = await prepare(original, [
      { type: 'create', node: node('one') },
    ]);
    const committed = receipt(await apply(original, plan, 'lost-ack'));

    const reloaded = runtime(testHost);
    const recovered = await apply(reloaded, plan, 'lost-ack');

    expect(recovered).toMatchObject({
      ok: true,
      data: { operationId: committed.operationId, requestId: 'lost-ack' },
    });
    expect([...nodes(testHost).keys()]).toEqual(['one']);
  });

  it('writes a complete, recoverable journal marker in the same Yjs update as content', async () => {
    const testHost = host();
    const canvas = runtime(testHost);
    const journal = testHost.store.spaceDoc.getMap<string>(JOURNAL_KEY);
    const journalValuesDuringCommit: unknown[] = [];
    journal.observe(event => {
      for (const key of event.keysChanged) {
        const value = journal.get(key);
        if (value) journalValuesDuringCommit.push(JSON.parse(value));
      }
    });
    const transactions: Array<{
      changedNodes: boolean;
      changedJournal: boolean;
    }> = [];
    const nativeNodes = nodes(testHost);
    testHost.store.spaceDoc.on('afterTransaction', transaction => {
      transactions.push({
        changedNodes: transaction.changed.has(nativeNodes as never),
        changedJournal: transaction.changed.has(journal as never),
      });
    });
    const plan = await prepare(canvas, [{ type: 'create', node: node('one') }]);

    const committed = receipt(await apply(canvas, plan, 'atomic-journal'));
    const atomicMarker = journalValuesDuringCommit.find(
      value =>
        (value as { receipt?: { requestId?: string } }).receipt?.requestId ===
          'atomic-journal' && (value as { receipt?: unknown }).receipt
    ) as Record<string, unknown> | undefined;

    expect(transactions).toContainEqual({
      changedNodes: true,
      changedJournal: true,
    });
    expect(atomicMarker).toMatchObject({
      receipt: {
        operationId: committed.operationId,
        requestId: 'atomic-journal',
      },
      changes: expect.any(Array),
    });
  });

  it('reports a thrown mid-batch mutation as durable partial application and supports request-id recovery', async () => {
    adapterState.throwAfterCreate = 2;
    const testHost = host();
    const canvas = runtime(testHost);
    const plan = await prepare(canvas, [
      { type: 'create', node: node('first') },
      { type: 'create', node: node('second') },
    ]);

    const result = await apply(canvas, plan, 'mid-batch');
    const status = await canvas.execute('canvas_operation', {
      action: 'status',
      requestId: 'mid-batch',
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        requestId: 'mid-batch',
        execution: 'partial',
        verification: 'needs_attention',
      },
    });
    expect(status).toMatchObject({
      ok: true,
      data: {
        requestId: 'mid-batch',
        execution: 'partial',
        createdIds: ['first'],
      },
    });
    expect([...nodes(testHost).keys()]).toEqual(['first']);
  });

  it('rejects a different payload that reuses an existing request id', async () => {
    const testHost = host();
    const canvas = runtime(testHost);
    const firstPlan = await prepare(canvas, [
      { type: 'create', node: node('one') },
    ]);
    receipt(await apply(canvas, firstPlan, 'reused-request'));
    const differentPlan = await prepare(canvas, [
      {
        type: 'update',
        target: { id: 'one' },
        patch: { props: { fillColor: 'blue' } },
      },
    ]);

    const result = await apply(canvas, differentPlan, 'reused-request');

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'IDEMPOTENCY_CONFLICT' },
    });
    expect(nodes(testHost).get('one')?.props.fillColor).toBe('red');
  });

  it('reverts only AI-owned color fields and preserves later human text', async () => {
    const testHost = host();
    const canvas = runtime(testHost);
    nodes(testHost).set(
      'one',
      node('one', { props: { fillColor: 'red', text: 'AI title' } })
    );
    const plan = await prepare(canvas, [
      {
        type: 'update',
        target: { id: 'one' },
        patch: { props: { fillColor: 'blue' } },
      },
    ]);
    const applied = receipt(await apply(canvas, plan, 'color-change'));
    const humanNode = nodes(testHost).get('one')!;
    nodes(testHost).set('one', {
      ...humanNode,
      props: { ...humanNode.props, text: 'Human title' },
    });

    const reverted = await canvas.execute(
      'canvas_operation',
      {
        action: 'revert',
        operationId: applied.operationId,
        requestId: 'undo-color',
      },
      { canWrite: true }
    );

    expect(reverted).toMatchObject({
      ok: true,
      data: { execution: 'reverted', updatedIds: ['one'] },
    });
    expect(nodes(testHost).get('one')?.props).toMatchObject({
      fillColor: 'red',
      text: 'Human title',
    });
  });

  it('aggregates three batches and two repairs in chronological order, resolving forward references', async () => {
    let uuid = 1000;
    vi.spyOn(crypto, 'randomUUID').mockImplementation(
      () =>
        String(--uuid).padStart(12, '0') as ReturnType<typeof crypto.randomUUID>
    );
    const testHost = host();
    const canvas = runtime(testHost);
    const parentOperationId = 'parent-operation';
    const batches: CanvasOperation[][] = [
      [
        { type: 'create', node: node('child', { parentId: 'group' }) },
        { type: 'create', node: node('group', { kind: 'group', props: {} }) },
        { type: 'create', node: connector('link', 'child', 'group') },
      ],
      [{ type: 'create', node: node('batch-two') }],
      [{ type: 'create', node: node('batch-three') }],
      [{ type: 'create', node: node('repair-one') }],
      [{ type: 'create', node: node('repair-two') }],
    ];
    const receipts: CanvasReceipt[] = [];
    for (const [index, operations] of batches.entries()) {
      const plan = await prepare(canvas, operations, { parentOperationId });
      receipts.push(
        receipt(
          await apply(canvas, plan, `batch-${index}`, index > 2 ? index - 2 : 0)
        )
      );
    }

    const status = await canvas.execute('canvas_operation', {
      action: 'status',
      operationId: parentOperationId,
    });

    expect(nodes(testHost).get('child')?.parentId).toBe('group');
    expect(nodes(testHost).get('link')).toMatchObject({
      sourceId: 'child',
      targetId: 'group',
    });
    expect(status).toMatchObject({
      ok: true,
      data: { createdIds: receipts.flatMap(item => item.createdIds) },
    });
  });

  it('undoes and redoes connector creation without changing endpoint identities', async () => {
    const testHost = host();
    const canvas = runtime(testHost);
    const plan = await prepare(canvas, [
      { type: 'create', node: node('source') },
      { type: 'create', node: node('target') },
      { type: 'create', node: connector('edge', 'source', 'target') },
    ]);
    const applied = receipt(await apply(canvas, plan, 'connector-apply'));
    const reverted = await canvas.execute(
      'canvas_operation',
      {
        action: 'revert',
        operationId: applied.operationId,
        requestId: 'connector-undo',
      },
      { canWrite: true }
    );
    expect(reverted).toMatchObject({
      ok: true,
      data: { execution: 'reverted' },
    });
    const redone = await canvas.execute(
      'canvas_operation',
      {
        action: 'redo',
        operationId: applied.operationId,
        requestId: 'connector-redo',
      },
      { canWrite: true }
    );

    expect(redone).toMatchObject({ ok: true, data: { execution: 'applied' } });
    if (!redone.ok) throw new Error(redone.error.message);
    await expect(
      canvas.execute('canvas_operation', {
        action: 'status',
        operationId: redone.data.operationId,
      })
    ).resolves.toMatchObject({
      ok: true,
      data: { execution: 'applied' },
    });
    expect(nodes(testHost).get('edge')).toMatchObject({
      id: 'edge',
      sourceId: 'source',
      targetId: 'target',
    });
  });

  it('allows viewport movement but rejects a stale plan after any content change', async () => {
    const testHost = host();
    const canvas = runtime(testHost);
    const viewportPlan = await prepare(canvas, [
      { type: 'create', node: node('viewport-safe') },
    ]);
    testHost.viewportChanges += 1;
    expect(
      receipt(await apply(canvas, viewportPlan, 'viewport-only')).execution
    ).toBe('applied');

    const stalePlan = await prepare(canvas, [
      { type: 'create', node: node('must-not-apply') },
    ]);
    nodes(testHost).set('human-edit', node('human-edit'));
    const stale = await apply(canvas, stalePlan, 'content-changed');

    expect(stale).toMatchObject({ ok: false, error: { code: 'STALE_PLAN' } });
    expect(nodes(testHost).has('must-not-apply')).toBe(false);
  });

  it('does not write content or a journal marker after the execution lease expires', async () => {
    const testHost = host();
    const canvas = runtime(testHost);
    const plan = await prepare(canvas, [
      { type: 'create', node: node('expired-write') },
    ]);

    const response = await canvas.execute(
      'canvas_apply',
      { planId: plan.planId, requestId: 'expired-request' },
      { canWrite: true, deadline: Date.now() - 1 }
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_CONFLICT', mutationState: 'cancelled' },
    });
    expect([...nodes(testHost).keys()]).toEqual([]);
    expect(testHost.store.spaceDoc.getMap(JOURNAL_KEY).size).toBe(0);
  });

  it('keeps validate and layout plans memory-only without write authorization', async () => {
    const testHost = host();
    const canvas = runtime(testHost);
    const updates = vi.fn();
    testHost.store.spaceDoc.on('update', updates);

    const validated = await canvas.execute(
      'canvas_validate',
      {
        destination,
        baseContentRevision: canvas.getContentRevision(),
        requestedScope: scope,
        operations: [{ type: 'create', node: node('readonly-validate') }],
      },
      { canWrite: false }
    );
    const laidOut = await canvas.execute(
      'canvas_layout',
      {
        destination,
        baseContentRevision: canvas.getContentRevision(),
        requestedScope: scope,
        nodes: [node('readonly-layout')],
        options: { mode: 'row' },
      },
      { canWrite: false }
    );

    expect(validated.ok).toBe(true);
    expect(laidOut.ok).toBe(true);
    expect(updates).not.toHaveBeenCalled();
    expect(
      testHost.store.spaceDoc.getMap('affine:canvas-ai:prepared-plans:v1').size
    ).toBe(0);
  });

  it('returns a deferred new-document navigation intent before the bridge ACK', async () => {
    const testHost = host();
    const authorizeTarget = vi.fn(async () => ({
      canRead: true,
      canWrite: true,
      canCreateDoc: true,
    }));
    const openDocument = vi.fn();
    const canvas = new CanvasRuntime({
      host: testHost as unknown as EditorHost,
      workspaceId: 'workspace',
      docId: 'doc',
      authorizeTarget,
      openDocument,
      deferNavigation: true,
    });

    const response = await canvas.execute('canvas_focus', {
      destination: {
        type: 'new_document',
        workspaceId: 'workspace',
        title: 'Nuevo lienzo',
        reservedDocumentId: 'target-doc',
      },
      scope: { ids: [] },
    });

    expect(response).toMatchObject({
      ok: true,
      data: { navigation: { docId: 'target-doc' } },
    });
    expect(authorizeTarget).toHaveBeenCalledWith({
      docId: 'target-doc',
      create: false,
      signal: undefined,
    });
    expect(openDocument).not.toHaveBeenCalled();
  });

  it('mirrors a new-document lifecycle receipt and reuses its provision identity', async () => {
    const sourceHost = host();
    const targetHost = host();
    const createDocument = vi.fn(async (_input: { operationId: string }) => ({
      host: targetHost as unknown as EditorHost,
    }));
    const canvas = new CanvasRuntime({
      host: sourceHost as unknown as EditorHost,
      workspaceId: 'workspace',
      docId: 'doc',
      createDocument,
      authorizeTarget: async () => ({
        canRead: true,
        canWrite: true,
        canCreateDoc: true,
      }),
    });
    const newDestination = {
      type: 'new_document' as const,
      workspaceId: 'workspace',
      title: 'Lienzo destino',
      reservedDocumentId: 'target-doc',
    };
    const validated = await canvas.execute(
      'canvas_validate',
      {
        destination: newDestination,
        baseContentRevision: canvas.getContentRevision(),
        requestedScope: scope,
        operations: [{ type: 'create', node: node('target-shape') }],
      },
      { canWrite: true, canCreateDoc: true, taskId: 'new-doc-task' }
    );
    if (!validated.ok) throw new Error(validated.error.message);

    const first = await canvas.execute(
      'canvas_apply',
      { planId: validated.data.plan.planId, requestId: 'new-doc-apply' },
      { canWrite: true, canCreateDoc: true, taskId: 'new-doc-task' }
    );
    expect(first).toMatchObject({
      ok: true,
      data: {
        execution: 'applied',
        destination: newDestination,
        createdIds: ['target-shape'],
      },
    });
    if (!first.ok) throw new Error(first.error.message);
    expect(nodes(targetHost).has('target-shape')).toBe(true);
    expect(createDocument).toHaveBeenCalledTimes(1);

    const retry = await canvas.execute(
      'canvas_apply',
      { planId: validated.data.plan.planId, requestId: 'new-doc-apply' },
      { canWrite: true, canCreateDoc: true, taskId: 'new-doc-task' }
    );
    expect(retry).toMatchObject({
      ok: true,
      data: { operationId: first.data.operationId },
    });
    expect(createDocument).toHaveBeenCalledTimes(1);

    const reverted = await canvas.execute(
      'canvas_operation',
      {
        action: 'revert',
        operationId: first.data.operationId,
        requestId: 'new-doc-revert',
      },
      { canWrite: true, canCreateDoc: true, taskId: 'new-doc-task' }
    );
    expect(reverted).toMatchObject({
      ok: true,
      data: { execution: 'reverted', destination: newDestination },
    });
    expect(nodes(targetHost).has('target-shape')).toBe(false);
    const lifecycleIds = createDocument.mock.calls.map(
      ([request]) => request.operationId
    );
    expect(new Set(lifecycleIds).size).toBe(1);
  });

  it('does not provision or journal a new document after lease expiry', async () => {
    const sourceHost = host();
    const createDocument = vi.fn();
    const canvas = new CanvasRuntime({
      host: sourceHost as unknown as EditorHost,
      workspaceId: 'workspace',
      docId: 'doc',
      createDocument,
      authorizeTarget: async () => ({
        canRead: true,
        canWrite: true,
        canCreateDoc: true,
      }),
    });
    const validated = await canvas.execute(
      'canvas_validate',
      {
        destination: {
          type: 'new_document',
          workspaceId: 'workspace',
          title: 'Nunca creado',
          reservedDocumentId: 'expired-target',
        },
        baseContentRevision: canvas.getContentRevision(),
        requestedScope: scope,
        operations: [{ type: 'create', node: node('never-created') }],
      },
      { canWrite: true, canCreateDoc: true }
    );
    if (!validated.ok) throw new Error(validated.error.message);

    const result = await canvas.execute(
      'canvas_apply',
      { planId: validated.data.plan.planId, requestId: 'expired-new-doc' },
      {
        canWrite: true,
        canCreateDoc: true,
        deadline: Date.now() - 1,
      }
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_CONFLICT', mutationState: 'cancelled' },
    });
    expect(createDocument).not.toHaveBeenCalled();
    expect(sourceHost.store.spaceDoc.getMap(JOURNAL_KEY).size).toBe(0);
  });

  it('infers and limits repairs from prior mutations in the same trusted task', async () => {
    const testHost = host();
    const canvas = runtime(testHost);
    const taskContext = { canWrite: true, taskId: 'repair-task' } as const;
    const prepareForTask = async (operations: readonly CanvasOperation[]) => {
      const response = await canvas.execute(
        'canvas_validate',
        {
          destination,
          baseContentRevision: canvas.getContentRevision(),
          requestedScope: scope,
          operations,
        },
        taskContext
      );
      if (!response.ok) throw new Error(response.error.message);
      return response.data.plan;
    };
    const applyForTask = async (plan: CanvasPlan, requestId: string) =>
      canvas.execute(
        'canvas_apply',
        { planId: plan.planId, requestId },
        taskContext
      );

    expect(
      await applyForTask(
        await prepareForTask([{ type: 'create', node: node('repair-target') }]),
        'repair-create'
      )
    ).toMatchObject({ ok: true, data: { execution: 'applied' } });
    expect(
      await applyForTask(
        await prepareForTask([
          {
            type: 'update',
            target: { id: 'repair-target' },
            patch: { props: { fillColor: 'blue' } },
          },
        ]),
        'repair-one'
      )
    ).toMatchObject({ ok: true, data: { execution: 'applied' } });
    expect(
      await applyForTask(
        await prepareForTask([{ type: 'create', node: node('continuation') }]),
        'repair-continuation'
      )
    ).toMatchObject({ ok: true, data: { execution: 'applied' } });
    expect(
      await applyForTask(
        await prepareForTask([
          {
            type: 'update',
            target: { id: 'repair-target' },
            patch: { props: { fillColor: 'green' } },
          },
        ]),
        'repair-two'
      )
    ).toMatchObject({ ok: true, data: { execution: 'applied' } });
    const third = await applyForTask(
      await prepareForTask([
        { type: 'delete', target: { id: 'repair-target' } },
      ]),
      'repair-three'
    );

    expect(third).toMatchObject({
      ok: false,
      error: { code: 'BUDGET_EXCEEDED' },
    });
    expect(nodes(testHost).get('repair-target')?.props.fillColor).toBe('green');
  });

  it('checks asset and font readiness before writing content or an application marker', async () => {
    adapterState.failFontReadiness = true;
    const testHost = host();
    const canvas = runtime(testHost);
    const plan = await prepare(canvas, [
      {
        type: 'create',
        node: node('font-node', { props: { fontFamily: 'Missing Font' } }),
      },
    ]);

    const fontResult = await apply(canvas, plan, 'missing-font');

    expect(fontResult).toMatchObject({
      ok: false,
      error: { code: 'FONT_UNAVAILABLE' },
    });
    const assetPlan = await prepare(canvas, [
      {
        type: 'create',
        node: node('asset-frame', { kind: 'frame', props: {} }),
      },
      {
        type: 'create',
        node: node('asset-node', {
          kind: 'block:affine:image',
          parentId: 'asset-frame',
          props: {},
        }),
      },
    ]);
    const assetResult = await apply(canvas, assetPlan, 'missing-asset');

    expect(assetResult).toMatchObject({
      ok: false,
      error: { code: 'ASSET_MISSING' },
    });
    expect(nodes(testHost).size).toBe(0);
    expect(
      [...testHost.store.spaceDoc.getMap<string>(JOURNAL_KEY).values()].some(
        value =>
          ['missing-font', 'missing-asset'].includes(
            JSON.parse(value).receipt?.requestId
          )
      )
    ).toBe(false);
  });

  it('records a delete cascade and restores the connector with its original identities', async () => {
    adapterState.cascadeDeletes = true;
    const testHost = host();
    const canvas = runtime(testHost);
    const seed = await prepare(canvas, [
      { type: 'create', node: node('source') },
      { type: 'create', node: node('target') },
      { type: 'create', node: connector('edge', 'source', 'target') },
    ]);
    receipt(await apply(canvas, seed, 'seed-cascade'));
    const deletion = await prepare(canvas, [
      { type: 'delete', target: { id: 'source' } },
    ]);
    const deleted = receipt(await apply(canvas, deletion, 'delete-cascade'));

    expect(deleted.deletedIds).toEqual(['source', 'edge']);
    const reverted = await canvas.execute(
      'canvas_operation',
      {
        action: 'revert',
        operationId: deleted.operationId,
        requestId: 'undo-cascade',
      },
      { canWrite: true }
    );
    expect(reverted).toMatchObject({
      ok: true,
      data: { execution: 'reverted' },
    });
    expect(nodes(testHost).get('edge')).toMatchObject({
      sourceId: 'source',
      targetId: 'target',
    });
  });
});

describe('Canvas receipt transport bounds', () => {
  it('keeps a 5,000-object receipt below the delegated response limit', async () => {
    const { compactCanvasReceiptForTransport } = await import('./runtime');
    const ids = Array.from({ length: 5000 }, (_, index) => `native-${index}`);
    const receipt = compactCanvasReceiptForTransport({
      operationId: 'native-parent',
      requestId: 'request',
      planId: 'plan',
      execution: 'applied',
      verification: 'passed',
      persistence: 'synced',
      beforeRevision: 'before',
      afterRevision: 'after',
      contentRevision: 'after',
      createdIds: ids,
      updatedIds: ids,
      deletedIds: ids,
      idMap: Object.fromEntries(ids.map(id => [id, id])),
      warnings: [],
      revert: { available: true },
    });
    expect(receipt.truncated).toMatchObject({
      value: true,
      counts: { created: 5000, idMap: 5000 },
    });
    expect(
      new TextEncoder().encode(JSON.stringify(receipt)).byteLength
    ).toBeLessThanOrEqual(480 * 1024);
    expect(receipt.createdIds).toHaveLength(200);
  });
});
