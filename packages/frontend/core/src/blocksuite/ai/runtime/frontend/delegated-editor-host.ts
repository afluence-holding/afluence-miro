import type { NbstoreService } from '@affine/core/modules/storage';
import type {
  DelegatedToolCancel,
  DelegatedToolName,
  DelegatedToolRequest,
} from '@affine/realtime';
import type {
  CanvasToolArgsMap,
  CanvasToolName,
} from '@affine/realtime/canvas';
import type { EditorHost } from '@blocksuite/affine/std';
import { GfxControllerIdentifier } from '@blocksuite/affine/std/gfx';
import type { Subscription } from 'rxjs';

import type { CanvasRuntime, CanvasRuntimeOptions } from '../canvas';
import {
  CANVAS_ACTION_EVENT,
  type CanvasActionEventDetail,
} from './canvas-actions';
import {
  getLiveEditorMode,
  getLiveSelectionIds,
  lightEditorContext,
  readEditorState,
  readNodes,
  readSelection,
  snapshotDocument,
} from './live-projection';

type Realtime = Pick<NbstoreService['realtime'], 'request' | 'subscribe'>;

type HostOptions = {
  realtime: Realtime;
  host: EditorHost;
  sessionId: string;
  workspaceId: string;
  docId: string;
  persist?: CanvasRuntimeOptions['persist'];
  createDocument?: CanvasRuntimeOptions['createDocument'];
  openDocument?: CanvasRuntimeOptions['openDocument'];
  createArtifact?: CanvasRuntimeOptions['createArtifact'];
  resolveArtifact?: CanvasRuntimeOptions['resolveArtifact'];
};

const capabilities: DelegatedToolName[] = [
  'frontend_get_editor_state',
  'frontend_read_selection',
  'frontend_read_nodes',
  'frontend_snapshot_document',
  'frontend_canvas',
];

const STATE_UPSERT_DELAY_MS = 150;
const LEASE_RENEWAL_MS = 10_000;

export class DelegatedEditorHost {
  readonly clientId = crypto.randomUUID();
  private editorStateId = crypto.randomUUID();
  private subscription?: Subscription;
  private heartbeat?: ReturnType<typeof setTimeout>;
  private stateUpsert?: ReturnType<typeof setTimeout>;
  private blockSubscription?: { unsubscribe(): void };
  private selectionSubscription?: { unsubscribe(): void };
  private viewportSubscriptions: Array<{ unsubscribe(): void }> = [];
  private upsertInFlight?: Promise<void>;
  private upsertRequested = false;
  private disposed = false;
  private canvasRuntime?: Promise<CanvasRuntime>;
  private selectionSignature = '';
  private metadataSignature = '';
  private publishedEditorStateId?: string;
  private readonly inFlight = new Map<
    string,
    {
      identity: ReturnType<DelegatedEditorHost['identity']>;
      abort: AbortController;
    }
  >();
  private readonly focusChanged = () => {
    void this.requestUpsert().catch(console.error);
  };
  private readonly canvasAction = (event: Event) => {
    const detail = (event as CustomEvent<CanvasActionEventDetail>).detail;
    if (
      !detail ||
      detail.claimed ||
      this.disposed ||
      detail.action.binding.workspaceId !== this.options.workspaceId ||
      detail.action.binding.docId !== this.options.docId ||
      getLiveEditorMode(this.options.host) !== 'edgeless'
    )
      return;
    detail.claimed = true;
    detail.accept(
      this.options.realtime.request('copilot.canvas.execute', {
        workspaceId: this.options.workspaceId,
        docId: this.options.docId,
        clientId: this.clientId,
        tool: detail.action.tool,
        args: detail.action.args,
      })
    );
  };

  constructor(private readonly options: HostOptions) {}

  context() {
    return JSON.stringify({
      workspace_id: this.options.workspaceId,
      doc_id: this.options.docId,
      session_id: this.options.sessionId,
      ...lightEditorContext(this.options.host, this.editorStateId),
    });
  }

  async start() {
    this.disposed = false;
    document.addEventListener(CANVAS_ACTION_EVENT, this.canvasAction);
    this.subscription = this.options.realtime
      .subscribe('copilot.delegated.tool.requested', {
        clientId: this.clientId,
      })
      .subscribe(event => {
        if (event.type === 'request') {
          void this.respond(event).catch(console.error);
        } else if (event.type === 'cancel') {
          this.cancel(event);
        }
      });
    const changed = () => {
      this.editorStateId = crypto.randomUUID();
      this.scheduleStateUpsert();
    };
    this.blockSubscription =
      this.options.host.store.slots.blockUpdated.subscribe(changed);
    this.selectionSignature = this.getSelectionSignature();
    this.metadataSignature = this.getMetadataSignature();
    this.selectionSubscription =
      this.options.host.selection.slots.changed.subscribe(() => {
        const signature = this.getSelectionSignature();
        if (signature === this.selectionSignature) return;
        this.selectionSignature = signature;
        changed();
      });
    const viewport = this.options.host.std.get(
      GfxControllerIdentifier
    ).viewport;
    const viewportChanged = () => {
      if (getLiveEditorMode(this.options.host) === 'edgeless') changed();
    };
    this.viewportSubscriptions = [
      viewport.viewportUpdated.subscribe(viewportChanged),
      viewport.sizeUpdated.subscribe(viewportChanged),
    ];
    window.addEventListener('focus', this.focusChanged);
    window.addEventListener('blur', this.focusChanged);
    document.addEventListener('visibilitychange', this.focusChanged);
    await this.sync();
  }

  dispose() {
    this.disposed = true;
    document.removeEventListener(CANVAS_ACTION_EVENT, this.canvasAction);
    this.subscription?.unsubscribe();
    this.blockSubscription?.unsubscribe();
    this.selectionSubscription?.unsubscribe();
    this.viewportSubscriptions.forEach(subscription =>
      subscription.unsubscribe()
    );
    this.viewportSubscriptions = [];
    window.removeEventListener('focus', this.focusChanged);
    window.removeEventListener('blur', this.focusChanged);
    document.removeEventListener('visibilitychange', this.focusChanged);
    for (const request of this.inFlight.values()) request.abort.abort();
    this.inFlight.clear();
    void this.canvasRuntime
      ?.then(runtime => runtime.dispose())
      .catch(console.error);
    if (this.heartbeat) clearTimeout(this.heartbeat);
    if (this.stateUpsert) clearTimeout(this.stateUpsert);
    const release = () =>
      this.options.realtime.request('copilot.delegated.editor.release', {
        clientId: this.clientId,
        editorStateId: this.publishedEditorStateId ?? this.editorStateId,
      });
    void (this.upsertInFlight ?? Promise.resolve())
      .catch(() => {})
      .then(release)
      .catch(console.error);
  }

  async sync() {
    while (!this.disposed) {
      this.refreshMetadataState();
      if (this.stateUpsert) {
        clearTimeout(this.stateUpsert);
        this.stateUpsert = undefined;
      }
      if (this.upsertInFlight) {
        await this.upsertInFlight;
        continue;
      }
      if (this.publishedEditorStateId === this.editorStateId) return;
      await this.requestUpsert();
    }
  }

  private getSelectionSignature() {
    return JSON.stringify([
      getLiveEditorMode(this.options.host),
      getLiveSelectionIds(this.options.host),
    ]);
  }

  private getMetadataSignature() {
    return JSON.stringify([
      getLiveEditorMode(this.options.host),
      this.options.host.store.readonly$.value,
    ]);
  }

  private refreshMetadataState(scheduleUpsert = false) {
    const signature = this.getMetadataSignature();
    const changed =
      !!this.metadataSignature && signature !== this.metadataSignature;
    if (changed) {
      this.editorStateId = crypto.randomUUID();
      if (scheduleUpsert) this.scheduleStateUpsert();
    }
    this.metadataSignature = signature;
    return changed;
  }

  private scheduleStateUpsert() {
    if (this.stateUpsert || this.disposed) return;
    this.stateUpsert = setTimeout(() => {
      this.stateUpsert = undefined;
      void this.requestUpsert().catch(console.error);
    }, STATE_UPSERT_DELAY_MS);
  }

  private scheduleHeartbeat() {
    if (this.heartbeat) clearTimeout(this.heartbeat);
    if (this.disposed) return;
    this.heartbeat = setTimeout(() => {
      this.heartbeat = undefined;
      void this.requestUpsert().catch(console.error);
    }, LEASE_RENEWAL_MS);
  }

  private requestUpsert() {
    if (this.disposed) return Promise.resolve();
    this.refreshMetadataState();
    this.upsertRequested = true;
    if (this.upsertInFlight) return this.upsertInFlight;
    this.upsertInFlight = (async () => {
      while (this.upsertRequested && !this.disposed) {
        this.upsertRequested = false;
        if (this.stateUpsert) {
          clearTimeout(this.stateUpsert);
          this.stateUpsert = undefined;
        }
        const editorStateId = this.editorStateId;
        try {
          await this.options.realtime.request(
            'copilot.delegated.editor.upsert',
            {
              clientId: this.clientId,
              sessionId: this.options.sessionId,
              workspaceId: this.options.workspaceId,
              docId: this.options.docId,
              editorStateId,
              mode: getLiveEditorMode(this.options.host),
              readonly: this.options.host.store.readonly$.value,
              focused:
                document.visibilityState === 'visible' && document.hasFocus(),
              capabilities,
            }
          );
          this.publishedEditorStateId = editorStateId;
        } finally {
          this.scheduleHeartbeat();
        }
      }
    })().finally(() => {
      this.upsertInFlight = undefined;
      if (this.upsertRequested && !this.disposed && !this.stateUpsert) {
        this.stateUpsert = setTimeout(() => {
          this.stateUpsert = undefined;
          void this.requestUpsert().catch(console.error);
        }, STATE_UPSERT_DELAY_MS);
      }
    });
    return this.upsertInFlight;
  }

  private async respond(request: DelegatedToolRequest) {
    if (
      request.sessionId !== this.options.sessionId ||
      request.workspaceId !== this.options.workspaceId ||
      request.docId !== this.options.docId ||
      request.clientId !== this.clientId
    ) {
      await this.sendError(request, 'EDITOR_CONTEXT_CHANGED');
      return;
    }
    this.refreshMetadataState(true);
    if (request.deadlineAt <= Date.now()) {
      await this.sendError(request, 'FRONTEND_TIMEOUT');
      return;
    }
    if (
      request.tool !== 'frontend_canvas' &&
      request.editorStateId !== this.editorStateId
    ) {
      await this.sendError(request, 'EDITOR_STATE_CHANGED');
      return;
    }
    const identity = this.identity(request);
    const abort = new AbortController();
    this.inFlight.set(request.requestId, { identity, abort });
    try {
      const result = await this.execute(request, abort.signal);
      if (abort.signal.aborted) return;
      this.refreshMetadataState(true);
      if (
        request.tool !== 'frontend_canvas' &&
        request.editorStateId !== this.editorStateId
      ) {
        await this.sendError(request, 'EDITOR_STATE_CHANGED');
        return;
      }
      // Canvas plans validate a content revision and return their own receipt.
      // A legitimate commit, selection or viewport change must not invalidate
      // its transport acknowledgement (legacy read tools retain that check).
      const resultError =
        request.tool === 'frontend_canvas'
          ? undefined
          : this.resultError(result);
      if (resultError) {
        await this.options.realtime.request('copilot.delegated.tool.respond', {
          ...this.identity(request),
          error: resultError,
        });
        return;
      }
      await this.options.realtime.request('copilot.delegated.tool.respond', {
        ...this.identity(request),
        result:
          request.tool === 'frontend_canvas'
            ? {
                ...result,
                editor_state_id: request.editorStateId,
                editor_state_after_id: this.editorStateId,
              }
            : result,
      });
      // Navigating can unmount this host and abort in-flight requests. The
      // focus receipt must reach the server before handing off to the new doc.
      if (
        request.tool === 'frontend_canvas' &&
        request.args.tool === 'canvas_focus'
      ) {
        const envelope = result as Record<string, unknown>;
        const data =
          envelope.ok === true &&
          envelope.data &&
          typeof envelope.data === 'object'
            ? (envelope.data as Record<string, unknown>)
            : undefined;
        const navigation = data?.navigation;
        if (
          navigation &&
          typeof navigation === 'object' &&
          'docId' in navigation &&
          typeof navigation.docId === 'string'
        ) {
          await this.options.openDocument?.({ docId: navigation.docId });
        }
      }
    } catch {
      if (abort.signal.aborted) return;
      await this.sendError(
        request,
        request.tool === 'frontend_canvas'
          ? 'OPERATION_CONFLICT'
          : 'FRONTEND_READ_FAILED'
      );
    } finally {
      this.inFlight.delete(request.requestId);
    }
  }

  private cancel(event: DelegatedToolCancel) {
    const request = this.inFlight.get(event.requestId);
    if (request && this.sameIdentity(request.identity, event)) {
      request.abort.abort();
      this.inFlight.delete(event.requestId);
    }
  }

  private async execute(request: DelegatedToolRequest, signal: AbortSignal) {
    switch (request.tool) {
      case 'frontend_get_editor_state':
        return readEditorState(this.options.host, this.editorStateId);
      case 'frontend_read_selection':
        return readSelection(
          this.options.host,
          this.editorStateId,
          request.args
        );
      case 'frontend_read_nodes':
        return readNodes(this.options.host, this.editorStateId, request.args);
      case 'frontend_snapshot_document':
        return snapshotDocument(
          this.options.host,
          this.editorStateId,
          request.args
        );
      case 'frontend_canvas': {
        if (getLiveEditorMode(this.options.host) !== 'edgeless') {
          return {
            ok: false,
            error: {
              code: 'EDITOR_UNAVAILABLE',
              message: 'Open the document in Edgeless mode.',
              retryable: true,
            },
          };
        }
        const { tool, ...args } = request.args;
        this.canvasRuntime ??= import('../canvas').then(
          ({ CanvasRuntime }) =>
            new CanvasRuntime({
              host: this.options.host,
              workspaceId: this.options.workspaceId,
              docId: this.options.docId,
              persist: this.options.persist,
              createDocument: this.options.createDocument,
              openDocument: this.options.openDocument,
              deferNavigation: true,
              createArtifact: this.options.createArtifact,
              resolveArtifact: this.options.resolveArtifact,
              authorizeTarget: async ({ docId, create, signal }) => {
                signal?.throwIfAborted();
                const result = await this.options.realtime.request(
                  'copilot.canvas.authorize',
                  {
                    workspaceId: this.options.workspaceId,
                    docId: this.options.docId,
                    clientId: this.clientId,
                    targetDocId: docId,
                    create,
                  }
                );
                signal?.throwIfAborted();
                if (result.error)
                  throw new Error(
                    `${result.error.code}: ${result.error.message}`
                  );
                return result;
              },
            })
        );
        const runtime = await this.canvasRuntime;
        if (this.disposed || signal.aborted) {
          return {
            ok: false,
            error: {
              code: 'OPERATION_CONFLICT',
              message: 'The editor request was cancelled before execution.',
              retryable: false,
            },
          };
        }
        return runtime.execute(
          tool as CanvasToolName,
          args as unknown as CanvasToolArgsMap[CanvasToolName],
          {
            signal,
            deadline: request.deadlineAt,
            taskId: request.runId,
            canWrite: request.canvasAuthorization?.canWrite ?? false,
            canCreateDoc: request.canvasAuthorization?.canCreateDoc ?? false,
          }
        );
      }
    }
  }

  private identity(request: DelegatedToolRequest) {
    const {
      requestId,
      runId,
      toolCallId,
      sessionId,
      workspaceId,
      docId,
      clientId,
      editorStateId,
    } = request;
    return {
      requestId,
      runId,
      toolCallId,
      sessionId,
      workspaceId,
      docId,
      clientId,
      editorStateId,
    };
  }

  private sameIdentity(
    expected: ReturnType<DelegatedEditorHost['identity']>,
    actual: ReturnType<DelegatedEditorHost['identity']>
  ) {
    return Object.entries(expected).every(
      ([key, value]) => actual[key as keyof typeof actual] === value
    );
  }

  private sendError(request: DelegatedToolRequest, code: string) {
    const canvas = request.tool === 'frontend_canvas';
    const canvasCode =
      code === 'OPERATION_CONFLICT'
        ? code
        : code === 'FRONTEND_TIMEOUT'
          ? 'BUDGET_EXCEEDED'
          : 'EDITOR_UNAVAILABLE';
    return this.options.realtime.request('copilot.delegated.tool.respond', {
      ...this.identity(request),
      error: {
        code: canvas ? canvasCode : code,
        message: canvas
          ? canvasCode === 'OPERATION_CONFLICT'
            ? 'The canvas request failed without a confirmed outcome. Query its original requestId before retrying.'
            : 'The requested canvas editor is unavailable or the request expired before execution.'
          : 'The focused editor changed before the read completed.',
        retryable: canvas ? canvasCode === 'EDITOR_UNAVAILABLE' : true,
      },
    });
  }

  private resultError(result: unknown) {
    if (!result || typeof result !== 'object' || !('error' in result)) {
      return null;
    }
    const error = result.error;
    if (!error || typeof error !== 'object' || !('code' in error)) return null;
    return {
      code: String(error.code),
      message: 'The requested live editor view is not available.',
      retryable: false,
    };
  }
}
