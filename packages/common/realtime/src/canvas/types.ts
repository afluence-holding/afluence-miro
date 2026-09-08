/**
 * Shared, transport-neutral contract for the Edgeless AI canvas bridge.
 *
 * Tool identifiers deliberately use underscores because some AI providers only
 * accept identifier-like names. Product-facing documentation may call the same
 * tools `canvas.*`.
 */
export const CANVAS_CONTRACT_VERSION = 1 as const;
export const CANVAS_MAX_READ_OBJECTS = 200;
export const CANVAS_MAX_WRITE_BATCH = 100;
/** Layout may inspect a larger graph, but apply remains capped at 100 writes. */
export const CANVAS_MAX_LAYOUT_OBJECTS = 500;
export const CANVAS_MAX_REPAIRS = 2;

export type CanvasContractVersion = typeof CANVAS_CONTRACT_VERSION;
export type CanvasId = string;
export type CanvasRevision = string;
export type CanvasJsonPrimitive = boolean | number | string | null;
export type CanvasJsonValue =
  | CanvasJsonPrimitive
  | readonly CanvasJsonValue[]
  | { readonly [key: string]: CanvasJsonValue };
export type CanvasProps = Readonly<Record<string, CanvasJsonValue>>;

export interface CanvasBounds {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export type CanvasBuiltInNodeKind =
  | 'shape'
  | 'text'
  | 'brush'
  | 'highlighter'
  | 'note'
  | 'frame'
  | 'group'
  | 'connector'
  | 'mindmap';
export type CanvasBlockNodeKind = `block:${string}`;
export type CanvasNodeKind = CanvasBuiltInNodeKind | CanvasBlockNodeKind;
export type CanvasLayoutPolicy = 'auto' | 'fixed' | 'preserve';

export interface CanvasNode {
  /** Stable model ID. Locally created objects may additionally use a ref. */
  readonly id: CanvasId;
  readonly ref?: string;
  readonly kind: CanvasNodeKind;
  readonly bounds: CanvasBounds;
  readonly props: CanvasProps;
  readonly parentId?: CanvasId;
  /** Connector endpoint IDs. They are only meaningful for `connector`. */
  readonly sourceId?: CanvasId;
  readonly targetId?: CanvasId;
  readonly layout?: CanvasLayoutPolicy;
  /** Authoring hints; these are not arbitrary native block properties. */
  readonly design?: {
    readonly role?: 'title' | 'section' | 'body' | 'metadata' | 'decision';
    readonly order?: number;
    readonly lane?: string;
  };
}

export interface CanvasNodeReference {
  readonly id?: CanvasId;
  readonly ref?: string;
}

export interface CanvasScope {
  readonly ids?: readonly CanvasId[];
  readonly bounds?: CanvasBounds;
  readonly includeIncidentConnectors?: boolean;
  readonly includeAutoResizeContainers?: boolean;
}

export interface CanvasDestinationExisting {
  readonly type: 'existing';
  readonly documentId: string;
}

export interface CanvasDestinationNewDocument {
  readonly type: 'new_document';
  readonly workspaceId: string;
  readonly title: string;
  readonly reservedDocumentId?: string;
}

export type CanvasDestination =
  | CanvasDestinationExisting
  | CanvasDestinationNewDocument;

export type CanvasDiagramGrammar =
  | 'flow'
  | 'architecture'
  | 'workshop'
  | 'mindmap'
  | 'timeline'
  | 'matrix'
  | 'board'
  | 'presentation';
export type CanvasInterchangeFormat =
  | 'native'
  | 'asset'
  | 'recipe'
  | 'excalidraw'
  | 'mermaid'
  | 'markdown'
  | 'freemind'
  | 'opml'
  | 'png'
  | 'svg'
  | 'pdf';
export type CanvasLayoutMode = 'flow' | 'row' | 'column' | 'grid';
export type CanvasDensity = 'compact' | 'normal' | 'ample';
export type CanvasReadingDirection = 'left-to-right' | 'top-to-bottom';

export interface CanvasLayoutOptions {
  readonly mode: CanvasLayoutMode;
  readonly grammar?: CanvasDiagramGrammar;
  readonly density?: CanvasDensity;
  readonly direction?: CanvasReadingDirection;
  /** Exact gap between adjacent outer edges, overriding the density token. */
  readonly siblingGap?: number;
  /** Exact gap between graph levels, overriding the density token. */
  readonly levelGap?: number;
  readonly columns?: number;
  readonly origin?: Readonly<Pick<CanvasBounds, 'x' | 'y'>>;
}

export type CanvasOperation =
  | CanvasCreateOperation
  | CanvasUpdateOperation
  | CanvasDeleteOperation;

export interface CanvasCreateOperation {
  readonly type: 'create';
  readonly node: CanvasNode;
}

export interface CanvasUpdateOperation {
  readonly type: 'update';
  readonly target: CanvasNodeReference;
  /** Only explicitly listed fields may be changed by an executor. */
  readonly patch: Readonly<
    Partial<
      Pick<
        CanvasNode,
        'bounds' | 'props' | 'parentId' | 'sourceId' | 'targetId' | 'layout'
      >
    >
  >;
}

export interface CanvasDeleteOperation {
  readonly type: 'delete';
  readonly target: CanvasNodeReference;
}

export type CanvasDiagnosticSeverity = 'error' | 'warning' | 'info';
export interface CanvasDiagnostic {
  readonly code: CanvasErrorCode;
  readonly severity: CanvasDiagnosticSeverity;
  readonly message: string;
  readonly affectedIds?: readonly CanvasId[];
  readonly path?: string;
  readonly recoverable?: boolean;
}

export interface CanvasPlan {
  readonly schemaVersion: CanvasContractVersion;
  readonly planId: string;
  readonly status: 'ready' | 'invalid';
  readonly baseContentRevision: CanvasRevision;
  readonly capabilitiesVersion: string;
  readonly requestedScope: CanvasScope;
  readonly effectiveScope: CanvasScope;
  readonly destination: CanvasDestination;
  readonly taskId?: string;
  readonly parentOperationId?: string;
  readonly grammar?: CanvasDiagramGrammar;
  readonly layout?: CanvasLayoutOptions;
  readonly operations: readonly CanvasOperation[];
  readonly diagnostics: readonly CanvasDiagnostic[];
  readonly expiresAt?: string;
}

export type CanvasExecutionState =
  | 'preparing'
  | 'ready'
  | 'applying'
  | 'applied'
  | 'cancelled'
  | 'failed'
  | 'partial'
  | 'conflict'
  | 'reverted';
export type CanvasPersistenceState =
  | 'memory'
  | 'local_durable'
  | 'sync_pending'
  | 'synced';
export type CanvasVerificationState = 'pending' | 'passed' | 'needs_attention';
export type CanvasVerificationCheck = 'structure' | 'geometry' | 'visual';

export interface CanvasReceipt {
  readonly destination?: CanvasDestination;
  readonly operationId: string;
  readonly taskId?: string;
  readonly parentOperationId?: string;
  readonly requestId: string;
  readonly planId: string;
  readonly execution: CanvasExecutionState;
  readonly verification: CanvasVerificationState;
  readonly persistence: CanvasPersistenceState;
  readonly verificationChecks?: readonly CanvasVerificationCheck[];
  readonly beforeRevision: CanvasRevision;
  readonly afterRevision?: CanvasRevision;
  /** Current content revision at the point this receipt is read. */
  readonly contentRevision: CanvasRevision;
  readonly createdIds: readonly CanvasId[];
  readonly updatedIds: readonly CanvasId[];
  readonly deletedIds: readonly CanvasId[];
  readonly idMap: Readonly<Record<string, CanvasId>>;
  /** Durable batch state for long-running native imports. */
  readonly progress?: Readonly<{
    completed: number;
    total: number;
    canResume: boolean;
  }>;
  /** Bounded transport projection; the operation journal retains every ID. */
  readonly truncated?: Readonly<{
    readonly value: true;
    readonly counts: Readonly<{
      created: number;
      updated: number;
      deleted: number;
      idMap: number;
    }>;
    readonly continuation: Readonly<{
      tool: 'canvas_read';
      cursor: '0';
      limit: 200;
    }>;
  }>;
  readonly warnings: readonly CanvasDiagnostic[];
  readonly revert: Readonly<{ available: boolean; reason?: string }>;
}

/** Public error vocabulary is fixed by the PRD. */
export const CANVAS_ERROR_CODES = [
  'INVALID_PLAN',
  'UNSUPPORTED_CAPABILITY',
  'AMBIGUOUS_TARGET',
  'PERMISSION_DENIED',
  'ELEMENT_LOCKED',
  'STALE_PLAN',
  'EDITOR_UNAVAILABLE',
  'CONSTRAINT_CONFLICT',
  'ASSET_MISSING',
  'FONT_UNAVAILABLE',
  'FORMAT_LOSS',
  'PARTIAL_APPLICATION',
  'SYNC_PENDING',
  'OPERATION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'RENDER_UNAVAILABLE',
  'BUDGET_EXCEEDED',
] as const;
export type CanvasErrorCode = (typeof CANVAS_ERROR_CODES)[number];

export interface CanvasError {
  readonly code: CanvasErrorCode;
  readonly message: string;
  readonly affectedScope?: CanvasScope;
  readonly affectedIds?: readonly CanvasId[];
  readonly mutationState?: CanvasExecutionState;
  readonly recoverableAction?: string;
}

export type CanvasToolName = keyof CanvasToolArgsMap;

export interface CanvasCapabilitiesArgs {
  readonly destination: CanvasDestination;
}
export interface CanvasReadArgs {
  readonly destination: CanvasDestination;
  readonly scope: CanvasScope;
  readonly fields?: readonly string[];
  readonly cursor?: string;
  readonly limit?: number;
}
export interface CanvasValidateArgs {
  readonly destination: CanvasDestination;
  readonly baseContentRevision: CanvasRevision;
  readonly requestedScope: CanvasScope;
  readonly operations: readonly CanvasOperation[];
  readonly taskId?: string;
  readonly parentOperationId?: string;
}
export interface CanvasLayoutArgs {
  readonly destination: CanvasDestination;
  readonly baseContentRevision: CanvasRevision;
  readonly requestedScope: CanvasScope;
  readonly nodes: readonly CanvasNode[];
  readonly options: CanvasLayoutOptions;
  readonly taskId?: string;
  readonly parentOperationId?: string;
}
export interface CanvasApplyArgs {
  readonly planId: string;
  readonly requestId: string;
}
export interface CanvasRenderArgs {
  readonly destination: CanvasDestination;
  readonly scope?: CanvasScope;
  readonly planId?: string;
  readonly contentRevision?: CanvasRevision;
  readonly scale?: number;
}
export interface CanvasOperationArgs {
  /** Supply one of operationId or requestId; requestId recovers a lost ACK. */
  readonly operationId?: string;
  readonly action: 'status' | 'cancel' | 'revert' | 'redo' | 'resume';
  readonly requestId?: string;
}
export interface CanvasFocusArgs {
  readonly destination: CanvasDestination;
  readonly scope: CanvasScope;
  readonly mode?: 'view' | 'select';
}
export interface CanvasImportArgs {
  readonly destination: CanvasDestination;
  readonly format: CanvasInterchangeFormat;
  readonly content: CanvasJsonValue;
  readonly requestedScope?: CanvasScope;
  readonly placement?: CanvasBounds;
  readonly taskId?: string;
  readonly parentOperationId?: string;
}
export interface CanvasExportArgs {
  readonly destination: CanvasDestination;
  readonly scope: CanvasScope;
  readonly format: CanvasInterchangeFormat;
  readonly includeAssets?: boolean;
}

export interface CanvasToolArgsMap {
  readonly canvas_capabilities: CanvasCapabilitiesArgs;
  readonly canvas_read: CanvasReadArgs;
  readonly canvas_validate: CanvasValidateArgs;
  readonly canvas_layout: CanvasLayoutArgs;
  readonly canvas_apply: CanvasApplyArgs;
  readonly canvas_render: CanvasRenderArgs;
  readonly canvas_operation: CanvasOperationArgs;
  readonly canvas_focus: CanvasFocusArgs;
  readonly canvas_import: CanvasImportArgs;
  readonly canvas_export: CanvasExportArgs;
}

export interface CanvasCapabilityManifest {
  readonly authoring?: CanvasJsonValue;
  readonly schemaVersion: CanvasContractVersion;
  readonly capabilitiesVersion: string;
  readonly tools: readonly CanvasToolName[];
  readonly nodeKinds: readonly {
    readonly kind: CanvasNodeKind;
    readonly status:
      | 'planned'
      | 'experimental'
      | 'supported'
      | 'not_applicable';
    readonly reason?: string;
    readonly schemaVersion?: number;
    readonly editableProperties?: readonly string[];
    readonly operations?: readonly string[];
    readonly requiresAsset?: boolean;
  }[];
  readonly authorization?: {
    readonly canWrite: boolean;
    readonly canCreateDoc: boolean;
  };
  readonly formats?: readonly {
    readonly format: CanvasInterchangeFormat;
    readonly import: 'supported' | 'subset' | 'unavailable';
    readonly export: 'supported' | 'subset' | 'unavailable';
    readonly note: string;
  }[];
  readonly design?: {
    readonly grammars: readonly CanvasDiagramGrammar[];
    readonly densities: readonly CanvasDensity[];
    readonly textSizes: {
      readonly title: number;
      readonly section: number;
      readonly body: number;
      readonly metadata: number;
    };
    readonly units: 'world';
    readonly preserveReadingOrder: true;
  };
  readonly renderer?: {
    readonly live: boolean;
    readonly preparedPlan: boolean;
    readonly visualVerification: 'model-dependent';
    readonly inlineImageMaxBytes: number;
  };
  readonly limits: Readonly<{
    readObjects: number;
    layoutObjects?: number;
    writeBatch: number;
    repairs: number;
  }>;
}

export interface CanvasReadResult {
  readonly nodes: readonly CanvasNode[];
  readonly contentRevision: CanvasRevision;
  readonly nextCursor?: string;
}
export interface CanvasPreparedPlanResult {
  readonly plan: CanvasPlan;
  readonly fidelity?: CanvasFidelityReport;
  readonly diagnostics?: readonly CanvasDiagnostic[];
  readonly sourceIdMap?: Readonly<Record<string, string>>;
}
export interface CanvasRenderResult {
  readonly kind: 'plan_preview' | 'document';
  readonly contentRevision?: CanvasRevision;
  readonly planId?: string;
  readonly scope: CanvasScope;
  readonly artifact?: Readonly<{
    url?: string;
    mimeType: string;
    /** Inline image evidence only; runtimes cap this at 512 KiB. */
    dataUrl?: string;
    handle?: string;
    checksum?: string;
    fileName?: string;
  }>;
  readonly visualVerificationAvailable: boolean;
}
export interface CanvasFocusResult {
  readonly focusedScope: CanvasScope;
}
export interface CanvasExportResult {
  readonly contentRevision: CanvasRevision;
  readonly format: CanvasInterchangeFormat;
  readonly checksum?: string;
  readonly losses: readonly CanvasDiagnostic[];
  readonly artifact?: Readonly<{
    url: string;
    mimeType: string;
    handle?: string;
    checksum?: string;
    fileName?: string;
  }>;
}

/**
 * A portable, inert authoring recipe. It describes canvas content and never
 * carries executable instructions or an editor/document identity.
 */
export interface CanvasAuthoringRecipe {
  readonly schemaVersion: CanvasContractVersion;
  readonly recipeVersion: 1;
  readonly grammar?: CanvasDiagramGrammar;
  readonly nodes: readonly CanvasNode[];
}

export type CanvasFidelityOutcome =
  | 'preserved'
  | 'converted'
  | 'flattened'
  | 'unsupported';

export interface CanvasFidelityEntry {
  readonly outcome: CanvasFidelityOutcome;
  readonly feature: string;
  readonly affectedIds?: readonly CanvasId[];
  readonly reason?: string;
}

export interface CanvasFidelityReport {
  readonly format: CanvasInterchangeFormat;
  readonly entries: readonly CanvasFidelityEntry[];
}

export interface CanvasInterchangeInput {
  readonly format: CanvasInterchangeFormat;
  readonly content: CanvasJsonValue;
  readonly maxObjects?: number;
}

export interface CanvasInterchangeOutput {
  readonly format: CanvasInterchangeFormat;
  readonly nodes: readonly CanvasNode[];
  /** Serialized output for export, when the format has a pure codec. */
  readonly content?: CanvasJsonValue;
  readonly recipe?: CanvasAuthoringRecipe;
  readonly fidelity: CanvasFidelityReport;
  readonly diagnostics: readonly CanvasDiagnostic[];
}

export interface CanvasToolResultMap {
  readonly canvas_capabilities: CanvasCapabilityManifest;
  readonly canvas_read: CanvasReadResult;
  readonly canvas_validate: CanvasPreparedPlanResult;
  readonly canvas_layout: CanvasPreparedPlanResult;
  readonly canvas_apply: CanvasReceipt;
  readonly canvas_render: CanvasRenderResult;
  readonly canvas_operation: CanvasReceipt;
  readonly canvas_focus: CanvasFocusResult;
  readonly canvas_import: CanvasPreparedPlanResult;
  readonly canvas_export: CanvasExportResult;
}

export type CanvasToolResponse<T extends CanvasToolName> =
  | { readonly ok: true; readonly data: CanvasToolResultMap[T] }
  | { readonly ok: false; readonly error: CanvasError };

export interface CanvasLayoutInput {
  readonly nodes: readonly CanvasNode[];
  readonly options: CanvasLayoutOptions;
  /** IDs eligible for movement. All other nodes are treated as fixed. */
  readonly scope?: CanvasScope;
}

export interface CanvasLayoutResult {
  readonly nodes: readonly CanvasNode[];
  readonly diagnostics: readonly CanvasDiagnostic[];
  readonly options: Readonly<Required<CanvasLayoutOptions>>;
}
