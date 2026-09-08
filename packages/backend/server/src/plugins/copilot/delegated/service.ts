import { randomUUID } from 'node:crypto';

import type {
  DelegatedEditorLeaseInput,
  DelegatedToolIdentity,
  DelegatedToolName,
  DelegatedToolResponse,
} from '@affine/realtime';
import { Injectable } from '@nestjs/common';

import { Cache, metrics, Mutex, OnEvent } from '../../../base';
import { PermissionAccess } from '../../../core/permission';
import { RealtimePublisher, realtimeUserRoom } from '../../../core/realtime';
import type { CopilotChatOptions } from '../providers/types';

type EditorLease = DelegatedEditorLeaseInput & {
  userId: string;
  connectionId: string;
  expiresAt: number;
};

type PendingRequest = {
  identity: DelegatedToolIdentity;
  userId: string;
  connectionId: string;
  tool: DelegatedToolName;
  resolve: (response: DelegatedToolResponse) => void;
};

declare global {
  interface Events {
    'copilot.delegated.editor.upserted': EditorLease;
    'copilot.delegated.editor.released': {
      userId: string;
      clientId: string;
      editorStateId: string;
    };
    'copilot.delegated.tool.responded': {
      userId: string;
      response: DelegatedToolResponse;
    };
  }
}

const LEASE_TTL_MS = 30_000;
const CANVAS_EDITOR_DISCOVERY_LIMIT = 20;
const TOOL_TIMEOUT_MS = 15_000;
const CANVAS_TIMEOUT_MS = 45_000;
// A canvas apply can be durable after its caller times out. Keep the claim
// longer than the transport deadline, so retry always reconciles through the
// operation journal instead of publishing a second mutation.
const CANVAS_CLAIM_TTL_MS = 5 * 60_000;
const CANVAS_TOOL_NAMES = new Set([
  'canvas_capabilities',
  'canvas_read',
  'canvas_validate',
  'canvas_layout',
  'canvas_render',
  'canvas_apply',
  'canvas_operation',
  'canvas_focus',
  'canvas_import',
  'canvas_export',
]);
const CANVAS_EXECUTION_STATES = new Set([
  'preparing',
  'ready',
  'applying',
  'applied',
  'cancelled',
  'failed',
  'partial',
  'conflict',
  'reverted',
]);
const CANVAS_PERSISTENCE_STATES = new Set([
  'memory',
  'local_durable',
  'sync_pending',
  'synced',
]);

type CanvasWriteClaim = {
  v: 1;
  fingerprint: string;
  createdAt: number;
};

type LocalCanvasWriteClaim = {
  fingerprint: string;
  execution: Promise<unknown>;
};

type CanvasTransportOrigin = 'chat' | 'mcp' | 'realtime';

export function isCanvasMutation(args: Record<string, unknown>) {
  return (
    args.tool === 'canvas_apply' ||
    args.tool === 'canvas_import' ||
    (args.tool === 'canvas_operation' && args.action !== 'status')
  );
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)])
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

@Injectable()
export class DelegatedEditorService {
  private readonly leases = new Map<string, EditorLease>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly canvasWriteClaims = new Map<string, LocalCanvasWriteClaim>();

  constructor(
    private readonly publisher: RealtimePublisher,
    private readonly ac: PermissionAccess,
    private readonly cache?: Cache,
    private readonly mutex?: Mutex
  ) {}

  canvasWritesEnabled() {
    const setting = process.env.AFFINE_CANVAS_AI_WRITES;
    return (
      setting === '1' || (setting !== '0' && (env.dev || env.namespaces.canary))
    );
  }

  canvasDesignEnabled() {
    return process.env.AFFINE_CANVAS_AI_DESIGN !== '0';
  }

  canvasImportEnabled() {
    return process.env.AFFINE_CANVAS_AI_IMPORT !== '0';
  }

  canvasExportEnabled() {
    return process.env.AFFINE_CANVAS_AI_EXPORT !== '0';
  }

  canvasMcpWritesEnabled() {
    return process.env.AFFINE_CANVAS_AI_MCP_WRITES !== '0';
  }

  /**
   * Central feature gate for both chat and MCP transports. The global writes
   * gate intentionally remains separate: it is evaluated with ACL/readonly
   * state immediately before dispatch.
   */
  canvasToolEnabled(
    tool: unknown,
    args: Record<string, unknown> = {},
    origin: CanvasTransportOrigin = 'chat'
  ) {
    if (tool === 'canvas_layout' && !this.canvasDesignEnabled()) return false;
    if (tool === 'canvas_import' && !this.canvasImportEnabled()) return false;
    if (tool === 'canvas_export' && !this.canvasExportEnabled()) return false;
    if (origin !== 'mcp' || this.canvasMcpWritesEnabled()) return true;
    // Discovery and capability manifests cannot name an operation action. Keep
    // the read-only status tool visible there; validated mutation actions are
    // rejected below.
    if (tool === 'canvas_operation' && args.action === undefined) return true;
    return !isCanvasMutation({ tool, ...args });
  }

  listAvailableEditors(userId: string, workspaceId: string) {
    return [...this.leases.values()]
      .filter(
        lease =>
          lease.userId === userId &&
          lease.workspaceId === workspaceId &&
          lease.expiresAt > Date.now() &&
          lease.mode === 'edgeless' &&
          lease.capabilities.includes('frontend_canvas')
      )
      .map(({ clientId, docId, readonly, focused, mode }) => ({
        clientId,
        docId,
        readonly,
        focused,
        mode,
      }));
  }

  /**
   * Returns only editor bindings that the requesting actor can still read.
   * This deliberately exposes no lease internals and does not select an
   * editor: callers must pass one returned clientId/docId pair explicitly.
   */
  async listCanvasEditors(userId: string, workspaceId: string) {
    const candidates = [...this.leases.values()]
      .filter(
        lease =>
          lease.userId === userId &&
          lease.workspaceId === workspaceId &&
          lease.expiresAt > Date.now() &&
          lease.mode === 'edgeless' &&
          lease.capabilities.includes('frontend_canvas')
      )
      .sort(
        (left, right) =>
          left.clientId.localeCompare(right.clientId) ||
          left.docId.localeCompare(right.docId)
      );

    const visible = await Promise.all(
      candidates.map(async lease => {
        try {
          const allowed = await this.ac
            .user(userId)
            .workspace(workspaceId)
            .doc(lease.docId)
            .can('Doc.Read');
          return allowed ? lease : null;
        } catch {
          // A failed ACL lookup must never disclose a live editor binding.
          return null;
        }
      })
    );
    const editors = visible
      .filter((lease): lease is EditorLease => lease !== null)
      .slice(0, CANVAS_EDITOR_DISCOVERY_LIMIT)
      .map(({ clientId, docId, expiresAt, mode }) => ({
        clientId,
        docId,
        expiresAt,
        mode,
      }));

    return {
      editors,
      truncated:
        visible.filter(lease => lease !== null).length > editors.length,
    };
  }

  leaseKey(userId: string, clientId: string) {
    return `${userId}:${clientId}`;
  }

  upsert(
    userId: string,
    connectionId: string,
    input: DelegatedEditorLeaseInput
  ) {
    const lease = {
      ...input,
      userId,
      connectionId,
      expiresAt: Date.now() + LEASE_TTL_MS,
    };
    this.leases.set(this.leaseKey(userId, input.clientId), lease);
    return lease;
  }

  release(userId: string, clientId: string, editorStateId: string) {
    const key = this.leaseKey(userId, clientId);
    const lease = this.leases.get(key);
    if (lease?.editorStateId === editorStateId) {
      this.leases.delete(key);
    }
  }

  getLease(options: CopilotChatOptions, tool?: DelegatedToolName) {
    if (!options?.user || !options.session || !options.workspace) return null;
    const now = Date.now();
    let selected: EditorLease | null = null;
    let matchingCanvasEditors = 0;
    for (const [key, lease] of this.leases) {
      if (lease.expiresAt <= now) {
        this.leases.delete(key);
        continue;
      }
      if (
        lease.userId === options.user &&
        lease.sessionId === options.session &&
        lease.workspaceId === options.workspace &&
        lease.focused &&
        (tool !== 'frontend_canvas' || lease.mode === 'edgeless') &&
        (!tool || lease.capabilities.includes(tool))
      ) {
        if (tool === 'frontend_canvas') matchingCanvasEditors++;
        if (!selected || lease.expiresAt > selected.expiresAt) selected = lease;
      }
    }
    return matchingCanvasEditors > 1 ? null : selected;
  }

  async executeCanvas(
    userId: string,
    workspaceId: string,
    clientId: string,
    docId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    execution?: { runId?: string; toolCallId?: string }
  ) {
    return this.executeCanvasForTransport(
      userId,
      workspaceId,
      clientId,
      docId,
      args,
      'realtime',
      signal,
      execution
    );
  }

  async executeCanvasFromMcp(
    userId: string,
    workspaceId: string,
    clientId: string,
    docId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    execution?: { runId?: string; toolCallId?: string },
    mcpCredentialCanWrite = true
  ) {
    return this.executeCanvasForTransport(
      userId,
      workspaceId,
      clientId,
      docId,
      args,
      'mcp',
      signal,
      execution,
      mcpCredentialCanWrite
    );
  }

  private async executeCanvasForTransport(
    userId: string,
    workspaceId: string,
    clientId: string,
    docId: string,
    args: Record<string, unknown>,
    origin: CanvasTransportOrigin,
    signal?: AbortSignal,
    execution?: { runId?: string; toolCallId?: string },
    mcpCredentialCanWrite = true
  ) {
    const lease = this.leases.get(this.leaseKey(userId, clientId));
    if (
      !lease ||
      lease.workspaceId !== workspaceId ||
      lease.docId !== docId ||
      lease.expiresAt <= Date.now() ||
      lease.mode !== 'edgeless' ||
      !lease.capabilities.includes('frontend_canvas')
    ) {
      return {
        error: {
          code: 'EDITOR_UNAVAILABLE',
          message: 'The explicitly selected Edgeless editor is unavailable.',
          retryable: true,
        },
      };
    }
    return this.executeOnLease(
      lease,
      'frontend_canvas',
      args,
      signal,
      execution,
      origin,
      mcpCredentialCanWrite
    );
  }

  /**
   * Authorizes a target document for the canvas host without issuing a canvas
   * command. The lease binds the caller to the source document, while target
   * permissions are always evaluated independently so a new-document plan or
   * an undo cannot inherit source-document access.
   */
  async authorizeCanvasTarget(
    userId: string,
    workspaceId: string,
    clientId: string,
    sourceDocId: string,
    targetDocId: string,
    create: boolean
  ) {
    const lease = this.leases.get(this.leaseKey(userId, clientId));
    if (
      !lease ||
      lease.workspaceId !== workspaceId ||
      lease.docId !== sourceDocId ||
      lease.expiresAt <= Date.now() ||
      lease.mode !== 'edgeless' ||
      !lease.capabilities.includes('frontend_canvas')
    ) {
      return {
        error: {
          code: 'EDITOR_UNAVAILABLE',
          message: 'The explicitly selected Edgeless editor is unavailable.',
          retryable: true,
        },
      };
    }

    const workspace = this.ac.user(userId).workspace(workspaceId);
    const sourceReadable = await workspace.doc(sourceDocId).can('Doc.Read');
    if (!sourceReadable) {
      return {
        error: {
          code: 'PERMISSION_DENIED',
          message: 'Access to the source document is denied.',
          retryable: false,
        },
      };
    }
    const target = workspace.doc(targetDocId);
    const [canRead, canWrite] = await Promise.all([
      target.can('Doc.Read'),
      target.can('Doc.Update'),
    ]);
    const canCreateDoc = create
      ? await workspace.can('Workspace.CreateDoc')
      : false;
    const current = this.leases.get(this.leaseKey(userId, clientId));
    if (
      !current ||
      current.connectionId !== lease.connectionId ||
      current.docId !== sourceDocId ||
      current.workspaceId !== workspaceId ||
      current.expiresAt <= Date.now()
    ) {
      return {
        error: {
          code: 'EDITOR_UNAVAILABLE',
          message: 'The editor binding changed during authorization.',
          retryable: true,
        },
      };
    }
    return { canRead, canWrite, canCreateDoc };
  }

  async execute(
    options: CopilotChatOptions,
    tool: DelegatedToolName,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    execution?: { runId?: string; toolCallId?: string }
  ) {
    const lease = this.getLease(options, tool);
    if (!lease) {
      return {
        error: {
          code:
            tool === 'frontend_canvas'
              ? 'EDITOR_UNAVAILABLE'
              : 'FRONTEND_UNAVAILABLE',
          message: 'No focused editor is available for this session.',
          retryable: true,
        },
      };
    }

    return this.executeOnLease(lease, tool, args, signal, execution, 'chat');
  }

  private async executeOnLease(
    lease: EditorLease,
    tool: DelegatedToolName,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    execution?: { runId?: string; toolCallId?: string },
    origin: CanvasTransportOrigin = 'chat',
    mcpCredentialCanWrite = true
  ) {
    const startedAt = performance.now();
    const result = await this.executeOnLeaseInner(
      lease,
      tool,
      args,
      signal,
      execution,
      origin,
      mcpCredentialCanWrite
    );
    if (tool === 'frontend_canvas') {
      this.recordCanvasToolMetric(args, result, performance.now() - startedAt);
    }
    return result;
  }

  private async executeOnLeaseInner(
    lease: EditorLease,
    tool: DelegatedToolName,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    execution?: { runId?: string; toolCallId?: string },
    origin: CanvasTransportOrigin = 'chat',
    mcpCredentialCanWrite = true
  ) {
    let canvasAuthorization:
      | { canWrite: boolean; canCreateDoc: boolean }
      | undefined;
    if (signal?.aborted) {
      return {
        error: {
          code: tool === 'frontend_canvas' ? 'OPERATION_CONFLICT' : 'ABORTED',
          message: 'The request was cancelled before dispatch.',
          retryable: false,
        },
      };
    }
    if (tool === 'frontend_canvas') {
      if (!this.canvasToolEnabled(args.tool, args, origin)) {
        return {
          error: {
            code: 'UNSUPPORTED_CAPABILITY',
            message:
              'This canvas feature is disabled for the current transport.',
            retryable: false,
          },
        };
      }
      const mutation = isCanvasMutation(args);
      const writesEnabled =
        this.canvasWritesEnabled() &&
        !(origin === 'mcp' && !this.canvasMcpWritesEnabled()) &&
        !(origin === 'mcp' && !mcpCredentialCanWrite);
      if (mutation && (!writesEnabled || lease.readonly)) {
        return {
          error: {
            code: 'PERMISSION_DENIED',
            message: lease.readonly
              ? 'The document is read-only.'
              : origin === 'mcp' && !mcpCredentialCanWrite
                ? 'This MCP credential is read-only.'
                : 'Canvas AI writes are disabled for this server.',
            retryable: false,
          },
        };
      }
      const allowed = await this.ac
        .user(lease.userId)
        .workspace(lease.workspaceId)
        .doc(lease.docId)
        .can(mutation ? 'Doc.Update' : 'Doc.Read');
      if (!allowed) {
        return {
          error: {
            code: 'PERMISSION_DENIED',
            message: 'Access to this document is denied.',
            retryable: false,
          },
        };
      }
      const workspace = this.ac.user(lease.userId).workspace(lease.workspaceId);
      const [canWrite, canCreateDoc] = await Promise.all([
        mutation
          ? Promise.resolve(true)
          : workspace.doc(lease.docId).can('Doc.Update'),
        workspace.can('Workspace.CreateDoc'),
      ]);
      canvasAuthorization = {
        canWrite: writesEnabled && !lease.readonly && canWrite,
        canCreateDoc: writesEnabled && canCreateDoc,
      };
      // Permission checks can yield: never dispatch to a released/rebound lease.
      const current = this.leases.get(
        this.leaseKey(lease.userId, lease.clientId)
      );
      if (
        !current ||
        current.connectionId !== lease.connectionId ||
        current.docId !== lease.docId ||
        current.sessionId !== lease.sessionId ||
        current.expiresAt <= Date.now() ||
        signal?.aborted
      ) {
        return {
          error: {
            code: 'EDITOR_UNAVAILABLE',
            message: 'The editor binding changed before dispatch.',
            retryable: true,
          },
        };
      }
    }

    if (tool === 'frontend_canvas' && args.tool === 'canvas_apply') {
      return this.executeClaimedCanvasWrite(
        lease,
        args,
        signal,
        execution,
        canvasAuthorization
      );
    }

    if (tool === 'frontend_canvas' && isCanvasMutation(args)) {
      return this.executeSerializedCanvasMutation(
        lease,
        args,
        signal,
        execution,
        canvasAuthorization
      );
    }

    const result = await this.dispatchOnLease(
      lease,
      tool,
      args,
      signal,
      execution,
      canvasAuthorization
    );
    return tool === 'frontend_canvas' && args.tool === 'canvas_capabilities'
      ? this.filterCanvasCapabilities(result, origin, mcpCredentialCanWrite)
      : result;
  }

  private filterCanvasCapabilities(
    result: unknown,
    origin: CanvasTransportOrigin,
    mcpCredentialCanWrite: boolean
  ) {
    if (!isRecord(result) || result.ok !== true || !isRecord(result.data)) {
      return result;
    }
    const tools = result.data.tools;
    if (!Array.isArray(tools)) return result;
    const readOnlyMcp = origin === 'mcp' && !mcpCredentialCanWrite;
    const nodeKinds = Array.isArray(result.data.nodeKinds)
      ? result.data.nodeKinds.map(node =>
          isRecord(node) && readOnlyMcp
            ? {
                ...node,
                operations: Array.isArray(node.operations)
                  ? node.operations.filter(
                      operation =>
                        operation === 'read' || operation === 'export'
                    )
                  : node.operations,
              }
            : node
        )
      : result.data.nodeKinds;
    const formats = Array.isArray(result.data.formats)
      ? result.data.formats.map(format =>
          isRecord(format) && readOnlyMcp
            ? { ...format, import: 'unavailable' }
            : format
        )
      : result.data.formats;
    return {
      ...result,
      data: {
        ...result.data,
        tools: tools.filter(
          item =>
            typeof item === 'string' &&
            this.canvasToolEnabled(item, { tool: item }, origin) &&
            !(readOnlyMcp && ['canvas_apply', 'canvas_import'].includes(item))
        ),
        ...(readOnlyMcp
          ? {
              authorization: {
                ...(isRecord(result.data.authorization)
                  ? result.data.authorization
                  : {}),
                canWrite: false,
                canCreateDoc: false,
              },
              ...(nodeKinds === undefined ? {} : { nodeKinds }),
              ...(formats === undefined ? {} : { formats }),
            }
          : {}),
      },
    };
  }

  private canvasClaimKey(lease: EditorLease, requestId: string) {
    return `copilot:canvas:claim:${lease.userId}:${lease.workspaceId}:${lease.docId}:${requestId}`;
  }

  private canvasDocumentLockKey(lease: EditorLease) {
    // Serialization is document-wide. The idempotency key remains actor-scoped
    // because two users may legitimately use the same client-generated id.
    return `copilot:canvas:write:${lease.workspaceId}:${lease.docId}`;
  }

  private canvasClaimFingerprint(args: Record<string, unknown>) {
    return JSON.stringify(stableValue({ tool: args.tool, args }));
  }

  private operationConflict(message: string) {
    return {
      error: {
        code: 'OPERATION_CONFLICT',
        message,
        retryable: false,
      },
    };
  }

  private recordCanvasToolMetric(
    args: Record<string, unknown>,
    result: unknown,
    durationMs: number
  ) {
    const tool =
      typeof args.tool === 'string' && CANVAS_TOOL_NAMES.has(args.tool)
        ? args.tool
        : 'unknown';
    const error =
      isRecord(result) && isRecord(result.error) ? result.error : undefined;
    const data =
      isRecord(result) && result.ok === true && isRecord(result.data)
        ? result.data
        : undefined;
    const execution =
      typeof data?.execution === 'string' &&
      CANVAS_EXECUTION_STATES.has(data.execution)
        ? data.execution
        : 'none';
    const persistence =
      typeof data?.persistence === 'string' &&
      CANVAS_PERSISTENCE_STATES.has(data.persistence)
        ? data.persistence
        : 'none';
    const code = typeof error?.code === 'string' ? error.code : '';
    const outcome = error
      ? code === 'PERMISSION_DENIED' || code === 'CANVAS_ACCESS_DENIED'
        ? 'permission_denied'
        : code === 'EDITOR_UNAVAILABLE' || code === 'FRONTEND_UNAVAILABLE'
          ? 'unavailable'
          : code === 'OPERATION_CONFLICT'
            ? 'uncertain'
            : 'error'
      : execution !== 'none'
        ? execution
        : 'success';
    const attributes = { tool, outcome, execution, persistence };
    metrics.ai.counter('canvas_tool_calls').add(1, attributes);
    metrics.ai.histogram('canvas_tool_latency_ms').record(durationMs, {
      tool,
      outcome,
    });
  }

  private async executeClaimedCanvasWrite(
    lease: EditorLease,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    execution: { runId?: string; toolCallId?: string } | undefined,
    canvasAuthorization:
      | { canWrite: boolean; canCreateDoc: boolean }
      | undefined
  ): Promise<unknown> {
    const requestId = typeof args.requestId === 'string' ? args.requestId : '';
    if (!requestId) {
      return this.operationConflict(
        'canvas_apply requires a stable requestId.'
      );
    }
    const key = this.canvasClaimKey(lease, requestId);
    const fingerprint = this.canvasClaimFingerprint(args);
    const local = this.canvasWriteClaims.get(key);
    if (local) {
      return local.fingerprint === fingerprint
        ? local.execution
        : this.operationConflict(
            'This requestId is already claimed by a different canvas payload.'
          );
    }

    // Register before the first await so two clients on this server share the
    // same request/receipt instead of racing through the distributed claim.
    const claimed = this.claimAndDispatchCanvasWrite(
      key,
      fingerprint,
      lease,
      args,
      signal,
      execution,
      canvasAuthorization
    );
    this.canvasWriteClaims.set(key, { fingerprint, execution: claimed });
    try {
      return await claimed;
    } finally {
      this.canvasWriteClaims.delete(key);
    }
  }

  private async claimAndDispatchCanvasWrite(
    key: string,
    fingerprint: string,
    lease: EditorLease,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    execution: { runId?: string; toolCallId?: string } | undefined,
    canvasAuthorization:
      | { canWrite: boolean; canCreateDoc: boolean }
      | undefined
  ): Promise<unknown> {
    const lock = await this.mutex?.acquire(this.canvasDocumentLockKey(lease));
    if (this.mutex && !lock) {
      return this.operationConflict(
        'Another canvas write is still being reconciled for this document. Query canvas_operation before retrying.'
      );
    }

    let retainDocumentLock = false;
    try {
      const prior = await this.cache?.get<CanvasWriteClaim>(key);
      if (prior) {
        return prior.fingerprint === fingerprint
          ? this.operationConflict(
              'This canvas request was already claimed. Query canvas_operation using the original requestId before retrying.'
            )
          : this.operationConflict(
              'This requestId is already claimed by a different canvas payload.'
            );
      }
      if (this.cache) {
        const acquired = await this.cache.setnx<CanvasWriteClaim>(
          key,
          { v: 1, fingerprint, createdAt: Date.now() },
          { ttl: CANVAS_CLAIM_TTL_MS }
        );
        if (!acquired) {
          const raced = await this.cache.get<CanvasWriteClaim>(key);
          return raced?.fingerprint === fingerprint
            ? this.operationConflict(
                'This canvas request was already claimed. Query canvas_operation using the original requestId before retrying.'
              )
            : this.operationConflict(
                'Canvas request ownership could not be established safely. Query canvas_operation before retrying.'
              );
        }
      }
      const result = await this.dispatchOnLease(
        lease,
        'frontend_canvas',
        args,
        signal,
        execution,
        canvasAuthorization
      );
      // A timeout or cancellation has an unknown commit state. Let Redis' lock
      // expiry, rather than this process, determine when another write may run.
      retainDocumentLock = this.isUncertainCanvasResult(result);
      return result;
    } finally {
      if (lock && !retainDocumentLock) await lock.release();
    }
  }

  /**
   * Every mutation that is not an idempotent apply shares the same
   * document-wide Redis mutex as apply. Operation status intentionally skips
   * this path so a client can reconcile an uncertain write while its lock is
   * retained. The canvas runtime owns operation-level idempotency through its
   * durable journal; this lock only prevents overlapping CRDT mutations.
   */
  private async executeSerializedCanvasMutation(
    lease: EditorLease,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    execution: { runId?: string; toolCallId?: string } | undefined,
    canvasAuthorization:
      | { canWrite: boolean; canCreateDoc: boolean }
      | undefined
  ): Promise<unknown> {
    const lock = await this.mutex?.acquire(this.canvasDocumentLockKey(lease));
    if (this.mutex && !lock) {
      return this.operationConflict(
        'Another canvas write is still being reconciled for this document. Query canvas_operation before retrying.'
      );
    }

    let retainDocumentLock = false;
    try {
      const result = await this.dispatchOnLease(
        lease,
        'frontend_canvas',
        args,
        signal,
        execution,
        canvasAuthorization
      );
      // A client timeout/disconnect leaves the browser commit state unknown.
      // Retaining the distributed lock forces a journal reconciliation before
      // another write can overlap it.
      retainDocumentLock = this.isUncertainCanvasResult(result);
      return result;
    } finally {
      if (lock && !retainDocumentLock) await lock.release();
    }
  }

  private isUncertainCanvasResult(result: unknown) {
    return Boolean(
      result &&
      typeof result === 'object' &&
      'error' in result &&
      (result as { error?: { code?: string } }).error?.code ===
        'OPERATION_CONFLICT'
    );
  }

  private async dispatchOnLease(
    lease: EditorLease,
    tool: DelegatedToolName,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    execution?: { runId?: string; toolCallId?: string },
    canvasAuthorization?: { canWrite: boolean; canCreateDoc: boolean }
  ) {
    const identity = {
      requestId: randomUUID(),
      runId: execution?.runId ?? randomUUID(),
      toolCallId: execution?.toolCallId ?? randomUUID(),
      sessionId: lease.sessionId,
      workspaceId: lease.workspaceId,
      docId: lease.docId,
      clientId: lease.clientId,
      editorStateId: lease.editorStateId,
    };
    const timeoutMs =
      tool === 'frontend_canvas' ? CANVAS_TIMEOUT_MS : TOOL_TIMEOUT_MS;
    const deadlineAt = Date.now() + timeoutMs;
    const response = new Promise<DelegatedToolResponse>(resolve => {
      this.pending.set(identity.requestId, {
        identity,
        userId: lease.userId,
        connectionId: lease.connectionId,
        tool,
        resolve,
      });
    });
    this.publisher.publish(
      'copilot.delegated.tool.requested',
      { clientId: lease.clientId },
      {
        type: 'request',
        ...identity,
        tool,
        args,
        deadlineAt,
        ...(canvasAuthorization ? { canvasAuthorization } : {}),
      },
      { room: realtimeUserRoom(lease.userId, `copilot:${lease.clientId}`) }
    );

    let reason: 'aborted' | 'timeout' | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const interrupted = new Promise<DelegatedToolResponse>(resolve => {
      timeout = setTimeout(() => {
        reason = 'timeout';
        resolve({
          ...identity,
          error: {
            code:
              tool === 'frontend_canvas'
                ? 'OPERATION_CONFLICT'
                : 'FRONTEND_TIMEOUT',
            message:
              tool === 'frontend_canvas'
                ? 'The editor did not acknowledge the request. Query canvas_operation using the original requestId before retrying; a commit may have occurred.'
                : 'The focused editor did not respond before the deadline.',
            retryable: tool !== 'frontend_canvas',
          },
        });
      }, timeoutMs);
      timeout.unref?.();
      abort = () => {
        reason = 'aborted';
        resolve({
          ...identity,
          error: {
            code: tool === 'frontend_canvas' ? 'OPERATION_CONFLICT' : 'ABORTED',
            message:
              tool === 'frontend_canvas'
                ? 'The request was interrupted. Query canvas_operation with the original requestId to determine whether it was applied.'
                : 'The delegated read was cancelled.',
            retryable: false,
          },
        });
      };
      if (signal?.aborted) {
        abort();
      } else {
        signal?.addEventListener('abort', abort, { once: true });
      }
    });

    const result = await Promise.race([response, interrupted]);
    this.pending.delete(identity.requestId);
    if (timeout) clearTimeout(timeout);
    if (abort) signal?.removeEventListener('abort', abort);
    if (reason) {
      this.publisher.publish(
        'copilot.delegated.tool.requested',
        { clientId: lease.clientId },
        { type: 'cancel', ...identity, reason },
        { room: realtimeUserRoom(lease.userId, `copilot:${lease.clientId}`) }
      );
    }
    if (result.error) return { error: result.error };
    if (tool === 'frontend_canvas')
      return {
        ...(result.result as Record<string, unknown>),
        binding: {
          workspaceId: lease.workspaceId,
          docId: lease.docId,
          clientId: lease.clientId,
        },
      };
    if (
      tool === 'frontend_get_editor_state' ||
      !result.result ||
      typeof result.result !== 'object' ||
      Array.isArray(result.result)
    ) {
      return result.result;
    }
    return {
      ...result.result,
      source: {
        type: 'document',
        workspace_id: lease.workspaceId,
        doc_id: lease.docId,
        revision: lease.editorStateId,
      },
    };
  }

  receive(userId: string, response: DelegatedToolResponse) {
    const request = this.pending.get(response.requestId);
    if (
      !request ||
      request.userId !== userId ||
      !this.sameIdentity(request.identity, response) ||
      !this.validResult(request.identity, response)
    ) {
      return false;
    }
    this.pending.delete(response.requestId);
    request.resolve(response);
    return true;
  }

  @OnEvent('copilot.delegated.editor.upserted', { suppressError: true })
  onRemoteUpsert(lease: Events['copilot.delegated.editor.upserted']) {
    this.leases.set(this.leaseKey(lease.userId, lease.clientId), lease);
  }

  @OnEvent('copilot.delegated.editor.released', { suppressError: true })
  onRemoteRelease(event: Events['copilot.delegated.editor.released']) {
    this.release(event.userId, event.clientId, event.editorStateId);
  }

  @OnEvent('copilot.delegated.tool.responded', { suppressError: true })
  onRemoteResponse(event: Events['copilot.delegated.tool.responded']) {
    this.receive(event.userId, event.response);
  }

  @OnEvent('realtime.connection.disconnected', { suppressError: true })
  onDisconnect({ connectionId }: Events['realtime.connection.disconnected']) {
    for (const [key, lease] of this.leases) {
      if (lease.connectionId === connectionId) {
        this.leases.delete(key);
      }
    }
    for (const [requestId, request] of this.pending) {
      if (request.connectionId !== connectionId) continue;
      this.pending.delete(requestId);
      request.resolve({
        ...request.identity,
        error: {
          code:
            request.tool === 'frontend_canvas'
              ? 'OPERATION_CONFLICT'
              : 'FRONTEND_DISCONNECTED',
          message:
            request.tool === 'frontend_canvas'
              ? 'The editor disconnected. Query canvas_operation with the original requestId; do not assume the operation was rolled back.'
              : 'The focused editor disconnected during the read.',
          retryable: request.tool !== 'frontend_canvas',
        },
      });
      this.publisher.publish(
        'copilot.delegated.tool.requested',
        { clientId: request.identity.clientId },
        { type: 'cancel', ...request.identity, reason: 'disconnect' },
        {
          room: realtimeUserRoom(
            request.userId,
            `copilot:${request.identity.clientId}`
          ),
        }
      );
    }
  }

  private sameIdentity(
    expected: DelegatedToolIdentity,
    actual: DelegatedToolIdentity
  ) {
    return (
      expected.requestId === actual.requestId &&
      expected.runId === actual.runId &&
      expected.toolCallId === actual.toolCallId &&
      expected.sessionId === actual.sessionId &&
      expected.workspaceId === actual.workspaceId &&
      expected.docId === actual.docId &&
      expected.clientId === actual.clientId &&
      expected.editorStateId === actual.editorStateId
    );
  }

  private validResult(
    identity: DelegatedToolIdentity,
    response: DelegatedToolResponse
  ) {
    if (response.error) return true;
    return Boolean(
      response.result &&
      typeof response.result === 'object' &&
      'editor_state_id' in response.result &&
      response.result.editor_state_id === identity.editorStateId
    );
  }
}
