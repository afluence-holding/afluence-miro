import {
  CANVAS_CONTRACT_VERSION,
  CANVAS_MAX_LAYOUT_OBJECTS,
  CANVAS_MAX_READ_OBJECTS,
  CANVAS_MAX_REPAIRS,
  CANVAS_MAX_WRITE_BATCH,
  type CanvasApplyArgs,
  type CanvasBounds,
  type CanvasCapabilityManifest,
  type CanvasDiagnostic,
  type CanvasError,
  type CanvasErrorCode,
  type CanvasExportArgs,
  type CanvasNode,
  type CanvasOperationArgs,
  type CanvasPersistenceState,
  type CanvasPlan,
  type CanvasReceipt,
  type CanvasScope,
  type CanvasToolArgsMap,
  type CanvasToolName,
  type CanvasToolResponse,
  type CanvasToolResultMap,
  exportCanvasInterchange,
  importCanvasInterchange,
  validateCanvasToolArgs,
} from '@affine/realtime/canvas';
import type { EditorHost } from '@blocksuite/affine/std';
import type { DocSnapshot } from '@blocksuite/affine/store';
import { FontLoaderService } from '@blocksuite/affine-shared/services';
import { Bound } from '@blocksuite/global/gfx';

import { CANVAS_AUTHORING_GUIDE } from './authoring-guide';
import { composeCanvas, isSpatialCanvasNode } from './composition';
import {
  auditCanvasVisual,
  prepareDesign,
  routeCanvasConnectors,
} from './design';
import {
  canvasXmlParser,
  placeImportedCanvas,
  readInterchangeInput,
} from './interchange-input';
import { assertEditableProps, NativeCanvasAdapter } from './native-adapter';
import { prepareNativeBlockAssets } from './native-blocks';
import {
  canvasChecksum,
  exportNativeCanvas,
  insertNativeCanvasEntry,
  NativeCanvasFormatError,
  type NativeCanvasInsertEntry,
  packNativeCanvasBundle,
  prepareNativeCanvasInsert,
  readNativeCanvas,
} from './native-interchange';
import { NATIVE_PRIMITIVE_REGISTRY } from './native-primitives';
import { boundedCanvasPreview, canvasToPdf } from './presentation-export';

const CAPABILITIES_VERSION = 'edgeless-ai-canvas/1';
const JOURNAL_KEY = 'affine:canvas-ai:operation-journal:v1';
const PREPARED_PLAN_KEY = 'affine:canvas-ai:prepared-plans:v1';
const NATIVE_FONT_FAMILIES = new Set([
  'Inter',
  'blocksuite:surface:BebasNeue',
  'blocksuite:surface:Inter',
  'blocksuite:surface:Kalam',
  'blocksuite:surface:Lora',
  'blocksuite:surface:OrelegaOne',
  'blocksuite:surface:Poppins',
  'blocksuite:surface:Satoshi',
]);

type JsonObject = Record<string, unknown>;

export interface CanvasRuntimeExecutionContext {
  readonly signal?: AbortSignal;
  /** Trusted absolute wall-clock deadline supplied by the delegated lease. */
  readonly deadline?: number;
  readonly taskId?: string;
  readonly parentOperationId?: string;
  readonly repairIndex?: number;
  /** Trusted authorization supplied by the delegated editor bridge. */
  readonly canWrite?: boolean;
  readonly canCreateDoc?: boolean;
}

export interface CanvasRuntimeOptions {
  readonly host: EditorHost;
  readonly workspaceId: string;
  readonly docId: string;
  readonly actorUserId?: string;
  readonly persist?: (input: {
    workspaceId: string;
    docId: string;
    operationId: string;
    contentRevision: string;
    signal?: AbortSignal;
  }) => Promise<CanvasPersistenceState | void>;
  readonly createArtifact?: (input: {
    workspaceId: string;
    docId: string;
    blob: Blob;
    fileName: string;
    mimeType: string;
    signal?: AbortSignal;
  }) => Promise<{
    url: string;
    handle?: string;
    mimeType?: string;
    fileName?: string;
  }>;
  readonly resolveArtifact?: (input: {
    handle: string;
    signal?: AbortSignal;
  }) => Promise<Blob>;
  readonly authorizeTarget?: (input: {
    docId: string;
    create: boolean;
    signal?: AbortSignal;
  }) => Promise<{
    canRead: boolean;
    canWrite: boolean;
    canCreateDoc: boolean;
  }>;
  readonly createDocument?: (input: {
    workspaceId: string;
    docId: string;
    title: string;
    operationId: string;
    signal?: AbortSignal;
    deadline?: number;
  }) => Promise<{ host: EditorHost; dispose?: () => void }>;
  readonly openDocument?: (input: {
    docId: string;
    signal?: AbortSignal;
  }) => Promise<void> | void;
  /** Return a navigation intent so the delegated bridge can ACK first. */
  readonly deferNavigation?: boolean;
}

type StoredChange =
  | { type: 'create'; id: string; after: CanvasNode }
  | { type: 'delete'; id: string; before: CanvasNode }
  | {
      type: 'update';
      id: string;
      before: Partial<CanvasNode>;
      after: Partial<CanvasNode>;
      fields: readonly string[];
      unsetBefore?: readonly string[];
      unsetAfter?: readonly string[];
    };

function nodeDependencies(node: Partial<CanvasNode>) {
  return [node.parentId, node.sourceId, node.targetId].filter(
    (id): id is string => typeof id === 'string'
  );
}

function dependencyOrderedChanges<T extends StoredChange>(
  changes: readonly T[],
  nodeOf: (change: T) => Partial<CanvasNode>
) {
  const byId = new Map(changes.map(change => [change.id, change]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: T[] = [];
  const visit = (change: T) => {
    if (visited.has(change.id)) return;
    if (visiting.has(change.id)) return;
    visiting.add(change.id);
    for (const dependency of nodeDependencies(nodeOf(change))) {
      const dependencyChange = byId.get(dependency);
      if (dependencyChange) visit(dependencyChange);
    }
    visiting.delete(change.id);
    visited.add(change.id);
    ordered.push(change);
  };
  changes.forEach(visit);
  return ordered;
}

interface StoredOperation {
  readonly digest: string;
  readonly receipt: CanvasReceipt;
  readonly changes: readonly StoredChange[];
  readonly originalOperationId?: string;
  readonly ordinal?: number;
  readonly repair?: boolean;
  readonly targetDocumentId?: string;
  readonly targetDocumentTitle?: string;
  readonly lifecycleOperationId?: string;
  readonly nativeCreated?: readonly StoredNativeCreated[];
  readonly nativeImport?: StoredNativeImport;
  readonly nativeJob?: NativeImportJob;
}

interface StoredNativeCreated {
  readonly id: string;
  readonly type: NativeCanvasInsertEntry['type'];
  readonly snapshot: unknown;
}

interface NativeImportJob {
  readonly operationId: string;
  readonly plan: CanvasPlan;
  readonly digest: string;
  readonly nextIndex: number;
  readonly total: number;
  /** Revision written with the preceding batch; resume rejects foreign edits. */
  readonly contentRevision: string;
  /** Every native ID whose insert entry is in a committed batch. */
  readonly committedIds: readonly string[];
  readonly canResume: boolean;
  readonly requestId: string;
}

interface StoredNativeImport {
  readonly kind: 'native-import';
  readonly snapshot: DocSnapshot;
  readonly placement?: CanvasBounds;
  readonly idMap: Readonly<Record<string, string>>;
  readonly artifactHandle?: string;
}

interface StoredPlan {
  readonly kind: 'plan';
  readonly digest: string;
  readonly plan: CanvasPlan;
  readonly native?: StoredNativeImport;
}

class RuntimeFailure extends Error {
  constructor(
    readonly code: CanvasErrorCode,
    message: string,
    readonly details: Partial<CanvasError> = {}
  ) {
    super(message);
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as JsonObject)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableValue(child)])
    );
  }
  return value;
}

export function stableStringify(value: unknown) {
  return JSON.stringify(stableValue(value));
}

function hashString(value: string) {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x85ebca6b) >>> 0;
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

function immutable<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as JsonObject)) immutable(child);
  }
  return value;
}

function randomId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function finiteBounds(bounds: CanvasBounds) {
  return (
    [bounds.x, bounds.y, bounds.w, bounds.h].every(Number.isFinite) &&
    bounds.w > 0 &&
    bounds.h > 0
  );
}

function intersects(a: CanvasBounds, b: CanvasBounds) {
  return (
    a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y
  );
}

function commonBounds(nodes: readonly CanvasNode[]): CanvasBounds {
  if (!nodes.length) return { x: 0, y: 0, w: 1, h: 1 };
  const minX = Math.min(...nodes.map(node => node.bounds.x));
  const minY = Math.min(...nodes.map(node => node.bounds.y));
  const maxX = Math.max(...nodes.map(node => node.bounds.x + node.bounds.w));
  const maxY = Math.max(...nodes.map(node => node.bounds.y + node.bounds.h));
  return {
    x: minX,
    y: minY,
    w: Math.max(1, maxX - minX),
    h: Math.max(1, maxY - minY),
  };
}

function patchFields(patch: Partial<Omit<CanvasNode, 'id' | 'kind'>>) {
  const fields: string[] = [];
  for (const key of Object.keys(patch)) {
    if (key === 'props' && patch.props) {
      fields.push(...Object.keys(patch.props).map(prop => `props.${prop}`));
    } else {
      fields.push(key);
    }
  }
  return fields;
}

function pickNodeFields(node: CanvasNode, fields: readonly string[]) {
  const result: Partial<CanvasNode> = {};
  for (const field of fields) {
    if (field.startsWith('props.')) {
      const key = field.slice('props.'.length);
      const props = (result.props ?? {}) as Record<string, unknown>;
      props[key] = node.props[key];
      (result as JsonObject).props = props;
      continue;
    }
    if (field in node) {
      (result as JsonObject)[field] = node[field as keyof CanvasNode];
    }
  }
  return result;
}

function nodeHasField(node: CanvasNode, field: string) {
  return field.startsWith('props.')
    ? Object.hasOwn(node.props, field.slice('props.'.length))
    : Object.hasOwn(node, field);
}

function restoreUnsetFields(
  patch: Partial<CanvasNode>,
  unset: readonly string[] | undefined
) {
  if (!unset?.length) return patch;
  const restored = structuredClone(patch) as JsonObject;
  for (const field of unset) {
    if (field.startsWith('props.')) {
      const key = field.slice('props.'.length);
      const props = (restored.props ??= {}) as JsonObject;
      props[key] = undefined;
    } else {
      restored[field] = undefined;
    }
  }
  return restored as Partial<CanvasNode>;
}

function equal(a: unknown, b: unknown) {
  return stableStringify(a) === stableStringify(b);
}

function normalizeTableForVerification(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const table = value as JsonObject;
  const normalizeAxis = (axis: unknown) =>
    Array.isArray(axis)
      ? axis.map((item, index) =>
          item && typeof item === 'object' && !Array.isArray(item)
            ? { order: `${index}`, ...(item as JsonObject) }
            : item
        )
      : axis;
  const cells =
    table.cells &&
    typeof table.cells === 'object' &&
    !Array.isArray(table.cells)
      ? Object.fromEntries(
          Object.entries(table.cells as JsonObject).map(([key, cell]) => {
            if (typeof cell === 'string') {
              return [key, { text: cell, richText: [{ insert: cell }] }];
            }
            if (!cell || typeof cell !== 'object' || Array.isArray(cell))
              return [key, cell];
            const semantic = cell as JsonObject;
            const richText = Array.isArray(semantic.richText)
              ? semantic.richText
              : undefined;
            const text =
              typeof semantic.text === 'string'
                ? semantic.text
                : richText
                  ? richText
                      .map(delta =>
                        delta && typeof delta === 'object'
                          ? ((delta as JsonObject).insert ?? '')
                          : ''
                      )
                      .join('')
                  : undefined;
            return [
              key,
              {
                ...semantic,
                ...(text === undefined ? {} : { text }),
                ...(richText === undefined
                  ? text === undefined
                    ? {}
                    : { richText: [{ insert: text }] }
                  : { richText }),
              },
            ];
          })
        )
      : table.cells;
  return {
    ...table,
    rows: normalizeAxis(table.rows),
    columns: normalizeAxis(table.columns),
    cells,
  };
}

function verificationEqual(a: unknown, b: unknown) {
  const normalize = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return value;
    const selected = value as JsonObject;
    const props = selected.props;
    if (!props || typeof props !== 'object' || Array.isArray(props))
      return value;
    const propsObject = props as JsonObject;
    if (!Object.hasOwn(propsObject, 'table')) return value;
    return {
      ...selected,
      props: {
        ...propsObject,
        table: normalizeTableForVerification(propsObject.table),
      },
    };
  };
  return equal(normalize(a), normalize(b));
}

type CanvasCreateOperation = Extract<
  CanvasPlan['operations'][number],
  { type: 'create' }
>;

function orderedCreates(operations: CanvasPlan['operations']) {
  const creates = operations.filter(
    (operation): operation is CanvasCreateOperation =>
      operation.type === 'create'
  );
  const byAlias = new Map<string, CanvasCreateOperation>();
  for (const operation of creates) {
    byAlias.set(operation.node.id, operation);
    if (operation.node.ref) byAlias.set(operation.node.ref, operation);
  }
  const ordered: CanvasCreateOperation[] = [];
  const visiting = new Set<CanvasCreateOperation>();
  const visited = new Set<CanvasCreateOperation>();
  const visit = (operation: CanvasCreateOperation) => {
    if (visited.has(operation)) return;
    if (visiting.has(operation)) {
      throw new RuntimeFailure(
        'INVALID_PLAN',
        `Canvas create hierarchy contains a cycle at ${operation.node.id}.`
      );
    }
    visiting.add(operation);
    const parent = operation.node.parentId
      ? byAlias.get(operation.node.parentId)
      : undefined;
    if (parent) visit(parent);
    visiting.delete(operation);
    visited.add(operation);
    ordered.push(operation);
  };
  creates.forEach(visit);
  return ordered;
}

function localParentDescriptor(node: CanvasNode) {
  const flavour = node.kind.startsWith('block:')
    ? node.kind.slice('block:'.length)
    : node.kind === 'note'
      ? 'affine:note'
      : node.kind === 'frame'
        ? 'affine:frame'
        : undefined;
  return { kind: node.kind, ...(flavour ? { flavour } : {}) };
}

function canvasError(failure: RuntimeFailure): CanvasError {
  return {
    code: failure.code,
    message: failure.message,
    ...failure.details,
  };
}

function abortIfNeeded(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new RuntimeFailure(
      'OPERATION_CONFLICT',
      'Canvas operation was cancelled before commit.',
      {
        mutationState: 'cancelled',
      }
    );
  }
}

function deadlineIfNeeded(deadline?: number) {
  if (deadline !== undefined && Date.now() >= deadline) {
    throw new RuntimeFailure(
      'OPERATION_CONFLICT',
      'The authorized canvas execution lease expired before commit.',
      { mutationState: 'cancelled' }
    );
  }
}

const MAX_RECEIPT_TRANSPORT_BYTES = 480 * 1024;
const MAX_RECEIPT_ITEMS = 200;

/**
 * Receipts in the operation journal remain complete. This projection only
 * bounds a delegated tool response below the realtime 512 KiB ceiling.
 */
export function compactCanvasReceiptForTransport(
  receipt: CanvasReceipt
): CanvasReceipt {
  const mapEntries = Object.entries(receipt.idMap);
  const counts = {
    created: receipt.createdIds.length,
    updated: receipt.updatedIds.length,
    deleted: receipt.deletedIds.length,
    idMap: mapEntries.length,
  };
  if (
    counts.created <= MAX_RECEIPT_ITEMS &&
    counts.updated <= MAX_RECEIPT_ITEMS &&
    counts.deleted <= MAX_RECEIPT_ITEMS &&
    counts.idMap <= MAX_RECEIPT_ITEMS
  )
    return receipt;
  let take = MAX_RECEIPT_ITEMS;
  while (take > 0) {
    const projected: CanvasReceipt = {
      ...receipt,
      createdIds: receipt.createdIds.slice(0, take),
      updatedIds: receipt.updatedIds.slice(0, take),
      deletedIds: receipt.deletedIds.slice(0, take),
      idMap: Object.fromEntries(mapEntries.slice(0, take)),
      truncated: {
        value: true,
        counts,
        continuation: { tool: 'canvas_read', cursor: '0', limit: 200 },
      },
    };
    if (
      new TextEncoder().encode(JSON.stringify(projected)).byteLength <=
      MAX_RECEIPT_TRANSPORT_BYTES
    )
      return projected;
    take--;
  }
  // The fixed receipt metadata itself exceeded the delegated response budget.
  // Do not emit a misleading partial payload.
  throw new RuntimeFailure(
    'BUDGET_EXCEEDED',
    'Canvas receipt metadata exceeds the transport limit.'
  );
}

function blobDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error('Could not read render image.'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

export class CanvasRuntime {
  private readonly adapter: NativeCanvasAdapter;
  private readonly plans = new Map<
    string,
    { plan: CanvasPlan; digest: string; native?: StoredNativeImport }
  >();
  private readonly objectUrls = new Set<string>();
  private disposed = false;

  constructor(readonly options: CanvasRuntimeOptions) {
    this.adapter = new NativeCanvasAdapter(options.host);
  }

  dispose() {
    this.disposed = true;
    this.plans.clear();
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls.clear();
  }

  getContentRevision() {
    const store = this.options.host.store as EditorHost['store'] & {
      getTransformer?: () => {
        docToSnapshot: (store: EditorHost['store']) => unknown;
      };
    };
    if (store.getTransformer) {
      const snapshot = store.getTransformer().docToSnapshot(store);
      if (snapshot) {
        const serialized = stableStringify(snapshot);
        return `canvas:v2:${hashString(serialized)}:${serialized.length}`;
      }
      throw new Error(
        'The native document serializer could not compute a content revision.'
      );
    }
    // Minimal executor tests use a Y.Doc-backed adapter without BlockSuite's
    // transformer. Production editor hosts always take the lossless path.
    const nodes: unknown[] = this.adapter.allNodes.map((node: CanvasNode) =>
      stableValue(node)
    );
    nodes.sort((a: unknown, b: unknown) =>
      stableStringify(a).localeCompare(stableStringify(b))
    );
    return `canvas:v1:${hashString(stableStringify(nodes))}:${nodes.length}`;
  }

  async execute<T extends CanvasToolName>(
    tool: T,
    args: CanvasToolArgsMap[T],
    context: CanvasRuntimeExecutionContext = {}
  ): Promise<CanvasToolResponse<T>> {
    try {
      if (this.disposed) {
        throw new RuntimeFailure(
          'EDITOR_UNAVAILABLE',
          'Canvas runtime has been disposed.'
        );
      }
      abortIfNeeded(context.signal);
      deadlineIfNeeded(context.deadline);
      const validated = validateCanvasToolArgs(tool, args);
      if (!validated.ok) {
        return { ok: false, error: validated.error };
      }
      const value = await this.dispatch(tool, validated.value, context);
      const data =
        (tool === 'canvas_apply' || tool === 'canvas_operation') &&
        value &&
        typeof value === 'object' &&
        'operationId' in value
          ? compactCanvasReceiptForTransport(value as CanvasReceipt)
          : value;
      return { ok: true, data } as CanvasToolResponse<T>;
    } catch (error) {
      const failure =
        error instanceof RuntimeFailure
          ? error
          : error instanceof NativeCanvasFormatError
            ? new RuntimeFailure(error.code, error.message)
            : new RuntimeFailure(
                'INVALID_PLAN',
                error instanceof Error
                  ? error.message
                  : 'Canvas operation failed.'
              );
      return {
        ok: false,
        error: canvasError(failure),
      } as CanvasToolResponse<T>;
    }
  }

  private async dispatch<T extends CanvasToolName>(
    tool: T,
    args: CanvasToolArgsMap[T],
    context: CanvasRuntimeExecutionContext
  ): Promise<CanvasToolResultMap[T]> {
    let result: CanvasToolResultMap[CanvasToolName];
    switch (tool) {
      case 'canvas_capabilities':
        result = this.capabilities(
          args as CanvasToolArgsMap['canvas_capabilities'],
          context
        );
        break;
      case 'canvas_read':
        result = this.read(args as CanvasToolArgsMap['canvas_read']);
        break;
      case 'canvas_validate':
        result = this.validate(
          args as CanvasToolArgsMap['canvas_validate'],
          context
        );
        break;
      case 'canvas_layout':
        result = await this.layout(
          args as CanvasToolArgsMap['canvas_layout'],
          context
        );
        break;
      case 'canvas_apply':
        result = await this.apply(args as CanvasApplyArgs, context);
        break;
      case 'canvas_operation':
        result = await this.operation(args as CanvasOperationArgs, context);
        break;
      case 'canvas_focus':
        result = await this.focus(
          args as CanvasToolArgsMap['canvas_focus'],
          context
        );
        break;
      case 'canvas_render':
        result = await this.render(
          args as CanvasToolArgsMap['canvas_render'],
          context
        );
        break;
      case 'canvas_import':
        result = await this.import(
          args as CanvasToolArgsMap['canvas_import'],
          context
        );
        break;
      case 'canvas_export':
        result = await this.export(args as CanvasExportArgs, context);
        break;
      default:
        throw new RuntimeFailure(
          'UNSUPPORTED_CAPABILITY',
          `Unknown canvas tool: ${tool}`
        );
    }
    return result as CanvasToolResultMap[T];
  }

  private capabilities(
    args: CanvasToolArgsMap['canvas_capabilities'],
    context: CanvasRuntimeExecutionContext
  ): CanvasCapabilityManifest {
    const destinationWritable =
      args.destination.type === 'existing'
        ? args.destination.documentId === this.options.docId
        : args.destination.workspaceId === this.options.workspaceId &&
          context.canCreateDoc !== false &&
          !!this.options.createDocument;
    const writable = this.canWrite(context) && destinationWritable;
    return {
      schemaVersion: CANVAS_CONTRACT_VERSION,
      capabilitiesVersion: CAPABILITIES_VERSION,
      tools: [
        'canvas_capabilities',
        'canvas_read',
        'canvas_validate',
        'canvas_layout',
        ...(writable
          ? (['canvas_apply', 'canvas_operation', 'canvas_import'] as const)
          : []),
        'canvas_render',
        'canvas_focus',
        'canvas_export',
      ] as CanvasToolName[],
      nodeKinds: [
        ...(
          [
            'shape',
            'text',
            'brush',
            'highlighter',
            'mindmap',
            'note',
            'frame',
            'connector',
            'group',
          ] as const
        ).map(kind => ({
          kind,
          status: 'supported' as const,
          editableProperties:
            NATIVE_PRIMITIVE_REGISTRY.find(entry => entry.kind === kind)
              ?.editableProps ??
            (kind === 'note'
              ? ['text', 'background', 'edgeless', 'lockedBySelf']
              : ['title', 'background', 'lockedBySelf']),
          operations: [
            'read',
            ...(writable
              ? ['create', 'update', 'delete', 'transform', 'duplicate']
              : []),
            'export',
          ],
        })),
        ...this.adapter.blockCapabilities.map(capability => ({
          kind: capability.kind,
          editableProperties: capability.props,
          schemaVersion: this.options.host.store.schema?.flavourSchemaMap.get(
            capability.flavour
          )?.version,
          requiresAsset: capability.requiresAsset,
          operations: capability.structural
            ? ['read', 'export']
            : [
                'read',
                ...(writable ? ['create', 'update', 'delete'] : []),
                'export',
              ],
          status: capability.registered
            ? capability.status === 'unsupported'
              ? ('not_applicable' as const)
              : capability.status
            : ('planned' as const),
          ...(!capability.registered
            ? { reason: 'Schema is not active in this editor.' }
            : capability.structural
              ? {
                  reason:
                    'The document lifecycle manages its single page root and surface.',
                }
              : {}),
        })),
      ],
      limits: {
        layoutObjects: CANVAS_MAX_LAYOUT_OBJECTS,
        readObjects: CANVAS_MAX_READ_OBJECTS,
        writeBatch: CANVAS_MAX_WRITE_BATCH,
        repairs: CANVAS_MAX_REPAIRS,
      },
      authorization: {
        canWrite: writable,
        canCreateDoc:
          context.canCreateDoc === true && !!this.options.createDocument,
      },
      authoring: CANVAS_AUTHORING_GUIDE,
      formats: [
        {
          format: 'asset',
          import:
            writable &&
            this.options.createArtifact &&
            this.options.resolveArtifact
              ? 'supported'
              : 'unavailable',
          export: 'unavailable',
          note: 'Authenticated chat attachment handle: verified PNG/JPEG/WebP becomes a native image; other files become native attachments. Preserves binary bytes and aspect ratio.',
        },
        {
          format: 'native',
          import: writable ? 'supported' : 'unavailable',
          export: 'supported',
          note: 'Native .bs.zip, original block snapshots and referenced assets; validates versions and remaps IDs.',
        },
        {
          format: 'recipe',
          import: writable ? 'supported' : 'unavailable',
          export: 'supported',
          note: 'Versioned semantic JSON authoring recipe; preserve native rich documents with .bs.zip.',
        },
        ...(
          ['excalidraw', 'mermaid', 'markdown', 'freemind', 'opml'] as const
        ).map(format => ({
          format,
          import: writable ? ('subset' as const) : ('unavailable' as const),
          export: 'subset' as const,
          note: 'Only declared compatible objects; unsupported features produce an explicit fidelity report or error.',
        })),
        {
          format: 'png',
          import: 'unavailable',
          export: 'supported',
          note: 'Raster presentation image of the requested scope.',
        },
        {
          format: 'pdf',
          import: 'unavailable',
          export: 'supported',
          note: 'Raster presentation PDF; native .bs.zip remains the editable backup.',
        },
      ],
      design: {
        grammars: [
          'flow',
          'architecture',
          'workshop',
          'mindmap',
          'timeline',
          'matrix',
          'board',
          'presentation',
        ],
        densities: ['compact', 'normal', 'ample'],
        textSizes: { title: 36, section: 28, body: 20, metadata: 16 },
        units: 'world',
        preserveReadingOrder: true,
      },
      renderer: {
        live: true,
        preparedPlan: true,
        visualVerification: 'model-dependent',
        inlineImageMaxBytes: 300 * 1024,
      },
    };
  }

  private read(args: CanvasToolArgsMap['canvas_read']) {
    this.assertDestination(args.destination);
    const limit = Math.min(args.limit ?? 100, CANVAS_MAX_READ_OBJECTS);
    const start = args.cursor === undefined ? 0 : Number(args.cursor);
    if (
      (args.cursor !== undefined && !/^(0|[1-9]\d*)$/.test(args.cursor)) ||
      !Number.isSafeInteger(start) ||
      start < 0
    ) {
      throw new RuntimeFailure(
        'INVALID_PLAN',
        'Read cursor is invalid. Omit cursor on the first read; otherwise use the exact nextCursor returned by canvas_read.'
      );
    }
    const matches = this.nodesInScope(args.scope);
    const nodes = matches.slice(start, start + limit);
    return {
      nodes,
      contentRevision: this.getContentRevision(),
      ...(start + nodes.length < matches.length
        ? { nextCursor: String(start + nodes.length) }
        : {}),
    };
  }

  private validate(
    args: CanvasToolArgsMap['canvas_validate'],
    context: CanvasRuntimeExecutionContext
  ) {
    const destination = this.preparedDestination(args.destination, context);
    if (args.operations.length > CANVAS_MAX_WRITE_BATCH) {
      throw new RuntimeFailure(
        'BUDGET_EXCEEDED',
        `A plan may contain at most ${CANVAS_MAX_WRITE_BATCH} mutations.`
      );
    }
    const revision = this.getContentRevision();
    if (args.baseContentRevision !== revision) {
      throw new RuntimeFailure(
        'STALE_PLAN',
        'The canvas changed after it was read. Read it again before validating.'
      );
    }
    const diagnostics = this.validateOperations(
      args.operations,
      args.requestedScope
    );
    const effectiveScope = this.effectiveScope(
      args.requestedScope,
      args.operations
    );
    const plan = this.storePlan(
      {
        schemaVersion: CANVAS_CONTRACT_VERSION,
        planId: randomId('plan'),
        status: diagnostics.some(item => item.severity === 'error')
          ? 'invalid'
          : 'ready',
        baseContentRevision: revision,
        capabilitiesVersion: CAPABILITIES_VERSION,
        requestedScope: args.requestedScope,
        effectiveScope,
        destination,
        taskId: context.taskId ?? args.taskId,
        parentOperationId: context.parentOperationId ?? args.parentOperationId,
        operations: args.operations,
        diagnostics,
      },
      undefined,
      context
    );
    return { plan };
  }

  private async layout(
    args: CanvasToolArgsMap['canvas_layout'],
    context: CanvasRuntimeExecutionContext
  ) {
    const destination = this.preparedDestination(args.destination, context);
    const revision = this.getContentRevision();
    if (revision !== args.baseContentRevision) {
      throw new RuntimeFailure(
        'STALE_PLAN',
        'The canvas changed after it was read. Read it again before layout.'
      );
    }
    const design = await prepareDesign(
      args.nodes,
      { layout: args.options, density: args.options.density, autoFit: true },
      {
        host: this.options.host,
        scope: args.requestedScope,
        signal: context.signal,
      }
    );
    const laidOut = composeCanvas(
      design.nodes,
      args.options,
      args.requestedScope
    );
    const inputIds = new Set(args.nodes.map(node => node.id));
    const outside = this.adapter.allNodes.filter(
      node => !inputIds.has(node.id)
    );
    const routed = routeCanvasConnectors([...laidOut.nodes, ...outside]);
    const audit = auditCanvasVisual(routed, {
      scope: { ...args.requestedScope, ids: args.nodes.map(node => node.id) },
    });
    const operations: CanvasPlan['operations'][number][] = [];
    for (const node of laidOut.nodes) {
      const existing = this.adapter.getNode(node.id);
      if (existing) {
        if (isSpatialCanvasNode(node) && !equal(existing.bounds, node.bounds))
          operations.push({
            type: 'update',
            target: { id: node.id },
            patch: { bounds: node.bounds },
          });
      } else operations.push({ type: 'create', node });
    }
    if (operations.length > CANVAS_MAX_WRITE_BATCH) {
      throw new RuntimeFailure(
        'BUDGET_EXCEEDED',
        `Layout contains more than ${CANVAS_MAX_WRITE_BATCH} mutations.`
      );
    }
    const validation = this.validateOperations(operations, args.requestedScope);
    const plan = this.storePlan(
      {
        schemaVersion: CANVAS_CONTRACT_VERSION,
        planId: randomId('plan'),
        status: [
          ...design.diagnostics,
          ...laidOut.diagnostics,
          ...validation,
          ...audit.diagnostics,
        ].some(item => item.severity === 'error')
          ? 'invalid'
          : 'ready',
        baseContentRevision: revision,
        capabilitiesVersion: CAPABILITIES_VERSION,
        requestedScope: args.requestedScope,
        effectiveScope: this.effectiveScope(args.requestedScope, operations),
        destination,
        taskId: context.taskId ?? args.taskId,
        parentOperationId: context.parentOperationId ?? args.parentOperationId,
        layout: args.options,
        grammar: args.options.grammar,
        operations,
        diagnostics: [
          ...design.diagnostics,
          ...laidOut.diagnostics,
          ...validation,
          ...audit.diagnostics,
        ],
      },
      undefined,
      context
    );
    return { plan };
  }

  private validateOperations(
    operations: CanvasPlan['operations'],
    requestedScope: CanvasScope
  ): CanvasDiagnostic[] {
    const diagnostics: CanvasDiagnostic[] = [];
    const refs = new Map<string, CanvasNode>();
    const existingNodes = this.adapter.allNodes;
    const existingIds = new Set(existingNodes.map(node => node.id));
    const withinRequestedScope = (node: CanvasNode) =>
      (!requestedScope.ids || requestedScope.ids.includes(node.id)) &&
      (!requestedScope.bounds ||
        intersects(node.bounds, requestedScope.bounds));
    for (const operation of operations) {
      if (operation.type !== 'create') continue;
      for (const alias of [operation.node.id, operation.node.ref]) {
        if (!alias) continue;
        if (refs.has(alias)) {
          diagnostics.push({
            code: 'INVALID_PLAN',
            severity: 'error',
            message: `Duplicate local reference ${alias}.`,
          });
        } else {
          refs.set(alias, operation.node);
        }
      }
    }
    const resolves = (id?: string) =>
      !id || existingIds.has(id) || refs.has(id);
    for (const [index, operation] of operations.entries()) {
      try {
        if (operation.type === 'create') {
          if (!finiteBounds(operation.node.bounds))
            throw new Error('Bounds must be finite and have positive size');
          if (existingIds.has(operation.node.id))
            throw new Error(`ID ${operation.node.id} already exists`);
          if (operation.node.kind.startsWith('block:')) {
            const localParent = operation.node.parentId
              ? refs.get(operation.node.parentId)
              : undefined;
            const validation = this.adapter.validateNativeBlock(
              operation.node,
              localParent ? undefined : operation.node.parentId,
              localParent ? localParentDescriptor(localParent) : undefined
            );
            if (!validation.ok) throw new Error(validation.errors.join(' '));
          } else {
            assertEditableProps(operation.node.kind, operation.node.props);
            if (
              operation.node.kind === 'brush' ||
              operation.node.kind === 'highlighter' ||
              operation.node.kind === 'mindmap'
            ) {
              const validation = this.adapter.validateNativePrimitive(
                operation.node
              );
              if (!validation.ok) throw new Error(validation.errors.join(' '));
            }
          }
          if (!resolves(operation.node.parentId))
            throw new Error(`Parent ${operation.node.parentId} does not exist`);
          if (!resolves(operation.node.sourceId))
            throw new Error(`Source ${operation.node.sourceId} does not exist`);
          if (!resolves(operation.node.targetId))
            throw new Error(`Target ${operation.node.targetId} does not exist`);
          if (
            operation.node.parentId &&
            !operation.node.kind.startsWith('block:')
          ) {
            const parent =
              this.adapter.getNode(operation.node.parentId) ??
              refs.get(operation.node.parentId);
            if (parent && parent.kind !== 'group' && parent.kind !== 'frame') {
              throw new Error(
                `Parent ${operation.node.parentId} is not a group or frame`
              );
            }
          }
          if (
            requestedScope.bounds &&
            !intersects(operation.node.bounds, requestedScope.bounds)
          ) {
            throw new Error('Created node is outside the requested bounds');
          }
        } else {
          const id = operation.target.id;
          if (!id && !operation.target.ref)
            throw new Error('Target must contain id or ref');
          if (operation.target.ref && !refs.has(operation.target.ref)) {
            throw new Error(
              `Target ref ${operation.target.ref} does not exist`
            );
          }
          if (id && !existingIds.has(id) && !refs.has(id))
            throw new Error(`Target ${id} does not exist`);
          if (
            id &&
            requestedScope.ids?.length &&
            !requestedScope.ids.includes(id)
          ) {
            throw new Error(`Target ${id} is outside requested scope`);
          }
          const model = id ? this.adapter.getModel(id) : undefined;
          const projected = id ? this.adapter.getNode(id) : undefined;
          if (model?.isLocked() || projected?.props.lockedBySelf === true) {
            if (!id)
              throw new Error('A locked operation target must have an id');
            diagnostics.push({
              code: 'ELEMENT_LOCKED',
              severity: 'error',
              message: `Element ${id} is locked.`,
              affectedIds: [id],
              path: `operations[${index}]`,
            });
            continue;
          }
          if (operation.type === 'update') {
            if (
              operation.patch.bounds &&
              !finiteBounds(operation.patch.bounds)
            ) {
              throw new Error('Bounds must be finite and have positive size');
            }
            const current = id
              ? (this.adapter.getNode(id) ?? refs.get(id))
              : operation.target.ref
                ? refs.get(operation.target.ref)
                : undefined;
            if (operation.patch.props && current) {
              if (
                current?.kind === 'mindmap' &&
                Object.hasOwn(operation.patch.props, 'tree')
              ) {
                throw new Error(
                  'Editing an existing mindmap tree is not supported by the native adapter.'
                );
              }
              if (current.kind.startsWith('block:')) {
                const capability = this.adapter.blockCapabilities.find(
                  item => item.kind === current.kind
                );
                const invalid = Object.keys(operation.patch.props).filter(
                  key => !capability?.props.includes(key)
                );
                if (invalid.length)
                  throw new Error(
                    `Properties not editable for ${current.kind}: ${invalid.join(', ')}`
                  );
              } else {
                assertEditableProps(current.kind, operation.patch.props);
              }
            }
            if (!resolves(operation.patch.parentId))
              throw new Error(
                `Parent ${operation.patch.parentId} does not exist`
              );
            if (!resolves(operation.patch.sourceId))
              throw new Error(
                `Source ${operation.patch.sourceId} does not exist`
              );
            if (!resolves(operation.patch.targetId))
              throw new Error(
                `Target ${operation.patch.targetId} does not exist`
              );
            if (
              current?.kind.startsWith('block:') &&
              (operation.patch.props ||
                operation.patch.bounds ||
                operation.patch.parentId)
            ) {
              const nextParentId = operation.patch.parentId ?? current.parentId;
              const localParent = nextParentId
                ? refs.get(nextParentId)
                : undefined;
              const validation = this.adapter.validateNativeBlock(
                {
                  ...current,
                  bounds: operation.patch.bounds ?? current.bounds,
                  parentId: nextParentId,
                  props: {
                    ...current.props,
                    ...operation.patch.props,
                    ...(operation.patch.bounds
                      ? {
                          xywh: new Bound(
                            operation.patch.bounds.x,
                            operation.patch.bounds.y,
                            operation.patch.bounds.w,
                            operation.patch.bounds.h
                          ).serialize(),
                        }
                      : {}),
                  },
                },
                localParent ? undefined : nextParentId,
                localParent ? localParentDescriptor(localParent) : undefined
              );
              if (!validation.ok) throw new Error(validation.errors.join(' '));
            } else if (operation.patch.parentId) {
              const parent =
                this.adapter.getNode(operation.patch.parentId) ??
                refs.get(operation.patch.parentId);
              if (
                parent &&
                parent.kind !== 'group' &&
                parent.kind !== 'frame'
              ) {
                throw new Error(
                  `Parent ${operation.patch.parentId} is not a group or frame`
                );
              }
            }
          } else if (id) {
            const outside = existingNodes
              .filter(
                node =>
                  node.parentId === id ||
                  (node.kind === 'connector' &&
                    (node.sourceId === id || node.targetId === id))
              )
              .filter(node => !withinRequestedScope(node));
            if (outside.length) {
              throw new Error(
                `Deleting ${id} would mutate related objects outside the requested scope: ${outside
                  .map(node => node.id)
                  .join(', ')}`
              );
            }
          }
        }
      } catch (error) {
        diagnostics.push({
          code: 'INVALID_PLAN',
          severity: 'error',
          message: error instanceof Error ? error.message : 'Invalid operation',
          path: `operations[${index}]`,
        });
      }
    }
    return diagnostics;
  }

  private effectiveScope(
    requested: CanvasScope,
    operations: CanvasPlan['operations']
  ): CanvasScope {
    const ids = new Set(requested.ids ?? []);
    for (const operation of operations) {
      if (operation.type !== 'create' && operation.target.id)
        ids.add(operation.target.id);
    }
    if (requested.includeIncidentConnectors) {
      for (const node of this.adapter.allNodes) {
        if (
          node.kind === 'connector' &&
          ((node.sourceId && ids.has(node.sourceId)) ||
            (node.targetId && ids.has(node.targetId)))
        ) {
          ids.add(node.id);
        }
      }
    }
    if (requested.includeAutoResizeContainers) {
      for (const id of ids) {
        const parentId = this.adapter.getNode(id)?.parentId;
        if (parentId) ids.add(parentId);
      }
    }
    return { ...requested, ...(ids.size ? { ids: [...ids] } : {}) };
  }

  private storePlan(
    plan: CanvasPlan,
    native?: StoredNativeImport,
    context?: CanvasRuntimeExecutionContext
  ) {
    abortIfNeeded(context?.signal);
    deadlineIfNeeded(context?.deadline);
    const frozen = immutable(structuredClone(plan));
    const frozenNative = native
      ? immutable(structuredClone(native))
      : undefined;
    const digest = hashString(
      stableStringify({ plan: frozen, native: frozenNative })
    );
    this.plans.set(frozen.planId, {
      plan: frozen,
      digest,
      native: frozenNative,
    });
    // Validation and layout are useful in readonly sessions. Keep their plans
    // process-local instead of writing executor metadata into a document the
    // caller is not authorized to change.
    if (!context || this.canWrite(context)) {
      this.options.host.store.spaceDoc.transact(() => {
        this.preparedPlans.set(
          frozen.planId,
          JSON.stringify({
            kind: 'plan',
            plan: frozen,
            digest,
            native: frozenNative,
          } satisfies StoredPlan)
        );
      }, this.options.host.store.spaceDoc.clientID);
    }
    return frozen;
  }

  private readPreparedPlan(planId: string) {
    const cached = this.plans.get(planId);
    if (cached) return cached;
    const value = this.preparedPlans.get(planId);
    if (!value) return undefined;
    try {
      const stored = JSON.parse(value) as StoredPlan;
      if (stored.kind !== 'plan' || stored.plan.planId !== planId)
        return undefined;
      const plan = immutable(stored.plan);
      const native = stored.native ? immutable(stored.native) : undefined;
      const prepared = { plan, digest: stored.digest, native };
      this.plans.set(planId, prepared);
      return prepared;
    } catch {
      return undefined;
    }
  }

  private nextOrdinal(parentOperationId?: string) {
    if (!parentOperationId) return 0;
    return (
      this.readJournalChildren(parentOperationId).reduce(
        (maximum, child) => Math.max(maximum, child.ordinal ?? -1),
        -1
      ) + 1
    );
  }

  private verifyAndDiff(
    plan: CanvasPlan,
    beforeNodes: ReadonlyMap<string, CanvasNode>,
    idMap: Readonly<Record<string, string>>
  ) {
    const afterNodes = new Map(
      this.adapter.allNodes.map(node => [node.id, node])
    );
    const createdIds = [...afterNodes.keys()].filter(
      id => !beforeNodes.has(id)
    );
    const deletedIds = [...beforeNodes.keys()].filter(
      id => !afterNodes.has(id)
    );
    const explicitlyUpdatedIds = new Set(
      plan.operations
        .filter(operation => operation.type === 'update')
        .map(
          operation =>
            (operation.target.ref && idMap[operation.target.ref]) ||
            (operation.target.id && idMap[operation.target.id]) ||
            operation.target.id
        )
        .filter((id): id is string => !!id)
    );
    const updatedIds = [...afterNodes.keys()].filter(
      id =>
        explicitlyUpdatedIds.has(id) &&
        beforeNodes.has(id) &&
        !equal(beforeNodes.get(id), afterNodes.get(id))
    );
    const changes: StoredChange[] = [];
    for (const id of createdIds) {
      const after = afterNodes.get(id);
      if (after) changes.push({ type: 'create', id, after });
    }
    for (const id of updatedIds) {
      const before = beforeNodes.get(id);
      const after = afterNodes.get(id);
      if (!before || !after) continue;
      const paths = [
        ...['bounds', 'parentId', 'sourceId', 'targetId'].filter(
          field =>
            !equal(
              pickNodeFields(before, [field]),
              pickNodeFields(after, [field])
            )
        ),
        ...[
          ...new Set([
            ...Object.keys(before.props),
            ...Object.keys(after.props),
          ]),
        ]
          .filter(key => !equal(before.props[key], after.props[key]))
          .map(key => `props.${key}`),
      ];
      changes.push({
        type: 'update' as const,
        id,
        fields: paths,
        before: pickNodeFields(before, paths),
        after: pickNodeFields(after, paths),
        unsetBefore: paths.filter(path => !nodeHasField(before, path)),
        unsetAfter: paths.filter(path => !nodeHasField(after, path)),
      });
    }
    for (const id of deletedIds) {
      const before = beforeNodes.get(id);
      if (before) changes.push({ type: 'delete', id, before });
    }
    const mismatches = new Set<string>();
    const resolve = (id?: string, ref?: string) =>
      (ref && idMap[ref]) || (id && idMap[id]) || id;
    for (const operation of plan.operations) {
      if (operation.type === 'create') {
        const id = resolve(operation.node.id, operation.node.ref);
        const actual = id ? afterNodes.get(id) : undefined;
        if (!actual) {
          if (id) mismatches.add(id);
          continue;
        }
        const expected = this.resolveNodeReferences(
          operation.node,
          idMap as Record<string, string>
        );
        const fields = [
          // A connector attached to native elements derives its geometry from
          // its endpoints. The requested bounds are only meaningful for a
          // connector with one or two free endpoints.
          ...(!isSpatialCanvasNode(expected) ||
          (expected.kind === 'connector' &&
            expected.sourceId &&
            expected.targetId)
            ? []
            : ['bounds']),
          ...Object.keys(expected.props).map(key => `props.${key}`),
          ...(expected.parentId ? ['parentId'] : []),
          ...(expected.sourceId ? ['sourceId'] : []),
          ...(expected.targetId ? ['targetId'] : []),
        ];
        if (
          !verificationEqual(
            pickNodeFields(actual, fields),
            pickNodeFields(expected, fields)
          )
        )
          mismatches.add(actual.id);
      } else if (operation.type === 'delete') {
        const id = resolve(operation.target.id, operation.target.ref);
        if (id && afterNodes.has(id)) mismatches.add(id);
      } else {
        const id = resolve(operation.target.id, operation.target.ref);
        const actual = id ? afterNodes.get(id) : undefined;
        if (!id || !actual) {
          if (id) mismatches.add(id);
          continue;
        }
        const patch = this.resolvePatchReferences(
          operation.patch,
          idMap as Record<string, string>
        );
        const fields = patchFields(patch);
        if (!verificationEqual(pickNodeFields(actual, fields), patch))
          mismatches.add(id);
      }
    }
    return {
      changes,
      createdIds,
      updatedIds,
      deletedIds,
      mismatches: [...mismatches],
    };
  }

  private async apply(
    args: CanvasApplyArgs,
    context: CanvasRuntimeExecutionContext
  ): Promise<CanvasReceipt> {
    this.assertWrite(context);
    abortIfNeeded(context.signal);
    const prior = this.readJournalByRequestId(args.requestId);
    if (prior) {
      if (prior.receipt.planId !== args.planId) {
        throw new RuntimeFailure(
          'IDEMPOTENCY_CONFLICT',
          'requestId was already used for a different canvas plan.'
        );
      }
      return prior.targetDocumentId
        ? prior.receipt
        : { ...prior.receipt, contentRevision: this.getContentRevision() };
    }
    if (this.hasIncompleteRequest(args.requestId)) {
      throw new RuntimeFailure(
        'OPERATION_CONFLICT',
        'A prior attempt reached the canvas commit boundary without a recoverable receipt.',
        {
          mutationState: 'partial',
          recoverableAction:
            'Inspect the canvas and operation journal before retrying with a new requestId.',
        }
      );
    }
    const prepared = this.readPreparedPlan(args.planId);
    if (!prepared)
      throw new RuntimeFailure(
        'INVALID_PLAN',
        `Prepared plan ${args.planId} is unavailable or expired.`
      );
    const { plan, digest, native } = prepared;
    if (plan.status !== 'ready')
      throw new RuntimeFailure(
        'INVALID_PLAN',
        'Invalid plans cannot be applied.'
      );
    if (plan.destination.type === 'new_document') {
      return this.applyToNewDocument(plan, digest, native, args, context);
    }
    this.assertDestination(plan.destination, context);
    const taskId = context.taskId ?? plan.taskId;
    const parentOperationId =
      context.parentOperationId ??
      (context.taskId
        ? `parent_${hashString(context.taskId)}`
        : (plan.parentOperationId ??
          (taskId ? `parent_${hashString(taskId)}` : undefined)));
    const siblings = parentOperationId
      ? this.readJournalChildren(parentOperationId)
      : [];
    const repair =
      (context.repairIndex ?? 0) > 0 || this.isRepairPlan(plan, siblings);
    const repairCount = siblings.filter(child => child.repair).length;
    if (
      (context.repairIndex ?? 0) > CANVAS_MAX_REPAIRS ||
      (repair && repairCount >= CANVAS_MAX_REPAIRS)
    ) {
      throw new RuntimeFailure(
        'BUDGET_EXCEEDED',
        `A task may contain at most ${CANVAS_MAX_REPAIRS} repairs.`
      );
    }
    const ordinal = this.nextOrdinal(parentOperationId);
    if (this.getContentRevision() !== plan.baseContentRevision) {
      throw new RuntimeFailure(
        'STALE_PLAN',
        'The canvas changed after this plan was prepared.'
      );
    }
    const diagnostics = this.validateOperations(
      plan.operations,
      plan.requestedScope
    );
    const blocking = diagnostics.find(item => item.severity === 'error');
    if (blocking) {
      throw new RuntimeFailure(blocking.code, blocking.message, {
        affectedIds: blocking.affectedIds,
      });
    }
    await this.preflight(plan, context.signal);
    this.assertCommitReady(context);
    if (native) {
      return this.applyNativeImport(
        plan,
        digest,
        native,
        args,
        context,
        parentOperationId,
        ordinal,
        repair
      );
    }

    const creates = orderedCreates(plan.operations);
    const createByAlias = new Map<string, CanvasCreateOperation>();
    for (const operation of creates) {
      createByAlias.set(operation.node.id, operation);
      if (operation.node.ref) createByAlias.set(operation.node.ref, operation);
    }
    const localParentFor = (operation: CanvasCreateOperation) => {
      const parent = operation.node.parentId
        ? createByAlias.get(operation.node.parentId)?.node
        : undefined;
      return parent ? localParentDescriptor(parent) : undefined;
    };
    const beforeRevision = this.getContentRevision();
    const operationId = randomId('operation');
    const idMap: Record<string, string> = {};
    const beforeNodes = new Map(
      this.adapter.allNodes.map(node => [node.id, node])
    );
    const journal = this.journal;
    const resolveId = (id?: string, ref?: string) => {
      const resolved = (ref && idMap[ref]) || (id && idMap[id]) || id;
      if (!resolved)
        throw new RuntimeFailure(
          'INVALID_PLAN',
          'Operation target could not be resolved.'
        );
      return resolved;
    };

    let receipt: CanvasReceipt | undefined;
    let changes: StoredChange[] = [];
    let mutationCompleted = false;
    let mutationError: unknown;
    this.options.host.store.captureSync();
    try {
      this.options.host.store.spaceDoc.transact(() => {
        journal.set(
          operationId,
          JSON.stringify({
            phase: 'applying',
            requestId: args.requestId,
            digest,
            planId: plan.planId,
          })
        );
        try {
          for (const operation of creates.filter(
            item => item.node.kind !== 'connector'
          )) {
            const node = this.resolveNodeReferences(operation.node, idMap);
            const id = this.adapter.create(node, localParentFor(operation));
            idMap[operation.node.id] = id;
            if (operation.node.ref) idMap[operation.node.ref] = id;
          }
          for (const operation of creates.filter(
            item => item.node.kind === 'connector'
          )) {
            const node = this.resolveNodeReferences(operation.node, idMap);
            const id = this.adapter.create(node, localParentFor(operation));
            idMap[operation.node.id] = id;
            if (operation.node.ref) idMap[operation.node.ref] = id;
          }
          for (const operation of creates) {
            const id = resolveId(operation.node.id, operation.node.ref);
            const parentId = operation.node.parentId
              ? resolveId(operation.node.parentId)
              : undefined;
            if (
              parentId &&
              (!operation.node.kind.startsWith('block:') ||
                this.adapter.usesVisualParent(
                  operation.node,
                  parentId,
                  localParentFor(operation)
                ))
            ) {
              this.adapter.setParent(id, parentId);
            }
          }
          for (const operation of plan.operations) {
            if (operation.type !== 'update') continue;
            const id = resolveId(operation.target.id, operation.target.ref);
            this.adapter.update(
              id,
              this.resolvePatchReferences(operation.patch, idMap)
            );
          }
          for (const operation of plan.operations) {
            if (operation.type !== 'delete') continue;
            this.adapter.delete(
              resolveId(operation.target.id, operation.target.ref)
            );
          }
        } catch (error) {
          mutationError = error;
        }
        const verification = this.verifyAndDiff(plan, beforeNodes, idMap);
        changes = verification.changes;
        const afterRevision = this.getContentRevision();
        receipt = {
          destination: plan.destination,
          operationId,
          taskId,
          parentOperationId,
          requestId: args.requestId,
          planId: plan.planId,
          execution:
            mutationError || verification.mismatches.length
              ? 'partial'
              : 'applied',
          verification:
            mutationError || verification.mismatches.length
              ? 'needs_attention'
              : 'passed',
          persistence: 'memory',
          verificationChecks: mutationError
            ? ['structure']
            : ['structure', 'geometry'],
          beforeRevision,
          afterRevision,
          contentRevision: afterRevision,
          createdIds: verification.createdIds,
          updatedIds: verification.updatedIds,
          deletedIds: verification.deletedIds,
          idMap,
          warnings:
            mutationError || verification.mismatches.length
              ? [
                  {
                    code: 'PARTIAL_APPLICATION',
                    severity: 'warning',
                    message:
                      mutationError instanceof Error
                        ? mutationError.message
                        : 'Post-commit verification found a mismatch.',
                    affectedIds: verification.mismatches,
                  },
                ]
              : [],
          revert: { available: changes.length > 0 },
        };
        journal.set(
          operationId,
          JSON.stringify({
            digest,
            receipt,
            changes,
            ordinal,
            repair,
          } satisfies StoredOperation)
        );
      }, this.options.host.store.spaceDoc.clientID);
      mutationCompleted = !mutationError;
    } catch (error) {
      const verification = this.verifyAndDiff(plan, beforeNodes, idMap);
      changes = verification.changes;
      const afterRevision = this.getContentRevision();
      receipt = {
        destination: plan.destination,
        operationId,
        taskId,
        parentOperationId,
        requestId: args.requestId,
        planId: plan.planId,
        execution: 'partial',
        verification: 'needs_attention',
        persistence: 'memory',
        verificationChecks: ['structure'],
        beforeRevision,
        afterRevision,
        contentRevision: afterRevision,
        createdIds: verification.createdIds.filter(id =>
          Object.values(idMap).includes(id)
        ),
        updatedIds: verification.updatedIds,
        deletedIds: verification.deletedIds,
        idMap,
        warnings: [
          {
            code: 'PARTIAL_APPLICATION',
            severity: 'warning',
            message:
              error instanceof Error
                ? error.message
                : 'Mutation failed after commit started.',
            affectedIds: verification.mismatches,
          },
        ],
        revert: { available: changes.length > 0 },
      };
      this.writeJournal(operationId, {
        digest,
        receipt,
        changes,
        ordinal,
        repair,
      });
    }
    this.options.host.store.captureSync();
    if (!receipt)
      throw new RuntimeFailure(
        'PARTIAL_APPLICATION',
        'Canvas commit did not produce a receipt.'
      );
    // Gfx model observers flush when the outer Yjs transaction closes. The
    // journal entry above is deliberately committed with the mutations, then
    // refreshed from the observable native state here. Without this pass,
    // legitimate native normalization (frame membership, connector geometry,
    // reactive text) can be reported as a partial application.
    if (mutationCompleted || mutationError) {
      const verification = this.verifyAndDiff(plan, beforeNodes, idMap);
      changes = verification.changes;
      const afterRevision = this.getContentRevision();
      receipt = {
        ...receipt,
        execution:
          mutationError || verification.mismatches.length
            ? 'partial'
            : 'applied',
        verification:
          mutationError || verification.mismatches.length
            ? 'needs_attention'
            : 'passed',
        verificationChecks: mutationError
          ? ['structure']
          : ['structure', 'geometry'],
        afterRevision,
        contentRevision: afterRevision,
        createdIds: verification.createdIds,
        updatedIds: verification.updatedIds,
        deletedIds: verification.deletedIds,
        warnings:
          mutationError || verification.mismatches.length
            ? [
                {
                  code: 'PARTIAL_APPLICATION',
                  severity: 'warning',
                  message:
                    mutationError instanceof Error
                      ? mutationError.message
                      : 'Post-commit verification found a mismatch.',
                  affectedIds: verification.mismatches,
                },
              ]
            : [],
        revert: { available: changes.length > 0 },
      };
      this.writeJournal(operationId, {
        digest,
        receipt,
        changes,
        ordinal,
        repair,
      });
    }
    let persistence: CanvasPersistenceState = 'memory';
    if (this.options.persist) {
      try {
        persistence =
          (await this.options.persist({
            workspaceId: this.options.workspaceId,
            docId: this.options.docId,
            operationId,
            contentRevision: receipt.contentRevision,
            signal: context.signal,
          })) ?? 'local_durable';
      } catch {
        persistence = 'sync_pending';
      }
    }
    const persistedReceipt = {
      ...receipt,
      persistence,
      contentRevision: this.getContentRevision(),
    };
    this.assertCommitReady(context);
    this.writeJournal(operationId, {
      digest,
      receipt: persistedReceipt,
      changes,
      ordinal,
      repair,
    });
    return persistedReceipt;
  }

  private async applyNativeImport(
    plan: CanvasPlan,
    digest: string,
    native: StoredNativeImport,
    args: CanvasApplyArgs,
    context: CanvasRuntimeExecutionContext,
    parentOperationId: string | undefined,
    ordinal: number,
    repair: boolean
  ): Promise<CanvasReceipt> {
    const store = this.options.host.store;
    let bundle = { snapshot: native.snapshot, assets: new Map<string, Blob>() };
    if (native.artifactHandle) {
      const blob = await this.resolveNativeArtifact(
        { handle: native.artifactHandle },
        context.signal
      );
      bundle = await readNativeCanvas(blob, store, context.signal);
    }
    const prepared = await prepareNativeCanvasInsert(store, bundle, {
      allocateId: sourceId => {
        const id = native.idMap[sourceId];
        if (!id) {
          throw new RuntimeFailure(
            'INVALID_PLAN',
            `Native import allocation for ${sourceId} is unavailable.`
          );
        }
        return id;
      },
      placement: native.placement,
      signal: context.signal,
    });
    if (prepared.entries.length > CANVAS_MAX_WRITE_BATCH) {
      return this.applyBatchedNativeImport(
        plan,
        digest,
        native,
        args,
        context,
        parentOperationId,
        ordinal,
        repair,
        prepared
      );
    }
    for (const [id, blob] of prepared.assets) {
      this.assertCommitReady(context);
      const existing = await store.blobSync.get(id);
      this.assertCommitReady(context);
      if (!existing) await store.blobSync.set(id, blob);
    }
    this.assertCommitReady(context);
    const beforeRevision = this.getContentRevision();
    const operationId = randomId('operation');
    const taskId = context.taskId ?? plan.taskId;
    let nativeCreated: StoredNativeCreated[] = [];
    const importedBlockIds = new Set(
      prepared.entries
        .filter(
          (
            entry
          ): entry is Extract<NativeCanvasInsertEntry, { type: 'block' }> =>
            entry.type === 'block'
        )
        .map(entry => entry.id)
    );
    let mutationError: unknown;
    const exists = (entry: NativeCanvasInsertEntry) => {
      if (entry.type === 'block') {
        return store.spaceDoc.getMap('blocks').has(entry.id);
      }
      const surface = store.getModelById(entry.surfaceId) as {
        props?: { elements?: { getValue(): Map<string, unknown> } };
      } | null;
      return !!surface?.props?.elements?.getValue().has(entry.id);
    };
    store.captureSync();
    store.spaceDoc.transact(() => {
      this.journal.set(
        operationId,
        JSON.stringify({
          phase: 'applying',
          requestId: args.requestId,
          digest,
          planId: plan.planId,
        })
      );
      try {
        for (const entry of prepared.entries) {
          insertNativeCanvasEntry(store, entry);
          // One exact snapshot for a top-level block owns its whole subtree.
          // Recording every descendant separately would let a conflicting
          // parent preserve itself while an inverse deletes its children.
          if (
            entry.type === 'element' ||
            !importedBlockIds.has(entry.parentId)
          ) {
            nativeCreated.push({
              id: entry.id,
              type: entry.type,
              snapshot: structuredClone(entry.snapshot),
            });
          }
        }
      } catch (error) {
        mutationError = error;
      }
      const provisionalRevision = this.getContentRevision();
      const provisional: CanvasReceipt = {
        destination: plan.destination,
        operationId,
        taskId,
        parentOperationId,
        requestId: args.requestId,
        planId: plan.planId,
        execution: mutationError ? 'partial' : 'applied',
        verification: mutationError ? 'needs_attention' : 'passed',
        persistence: 'memory',
        verificationChecks: ['structure'],
        beforeRevision,
        afterRevision: provisionalRevision,
        contentRevision: provisionalRevision,
        createdIds: nativeCreated.map(change => change.id),
        updatedIds: [],
        deletedIds: [],
        idMap: prepared.idMap,
        warnings: mutationError
          ? [
              {
                code: 'PARTIAL_APPLICATION',
                severity: 'warning',
                message:
                  mutationError instanceof Error
                    ? mutationError.message
                    : 'Native import stopped after a partial commit.',
                affectedIds: nativeCreated.map(change => change.id),
              },
            ]
          : [],
        revert: { available: nativeCreated.length > 0 },
      };
      this.journal.set(
        operationId,
        JSON.stringify({
          digest,
          receipt: provisional,
          changes: [],
          ordinal,
          repair,
          nativeCreated,
          nativeImport: native,
        } satisfies StoredOperation)
      );
    }, store.spaceDoc.clientID);
    store.captureSync();

    const present = prepared.entries.filter(exists);
    const missing = prepared.entries
      .filter(entry => !exists(entry))
      .map(entry => entry.id);
    const afterRevision = this.getContentRevision();
    nativeCreated = nativeCreated
      .filter(change => present.some(entry => entry.id === change.id))
      .map(change => ({
        ...change,
        snapshot: this.adapter.nativeSnapshot(change.id) ?? change.snapshot,
      }));
    let persistence: CanvasPersistenceState = 'memory';
    if (this.options.persist) {
      try {
        persistence =
          (await this.options.persist({
            workspaceId: this.options.workspaceId,
            docId: this.options.docId,
            operationId,
            contentRevision: afterRevision,
            signal: context.signal,
          })) ?? 'local_durable';
      } catch {
        persistence = 'sync_pending';
      }
    }
    const failed = !!mutationError || missing.length > 0;
    const receipt: CanvasReceipt = {
      destination: plan.destination,
      operationId,
      taskId,
      parentOperationId,
      requestId: args.requestId,
      planId: plan.planId,
      execution: failed ? 'partial' : 'applied',
      verification: failed ? 'needs_attention' : 'passed',
      persistence,
      verificationChecks: ['structure'],
      beforeRevision,
      afterRevision,
      contentRevision: afterRevision,
      createdIds: present.map(entry => entry.id),
      updatedIds: [],
      deletedIds: [],
      idMap: prepared.idMap,
      warnings: failed
        ? [
            {
              code: 'PARTIAL_APPLICATION',
              severity: 'warning',
              message:
                mutationError instanceof Error
                  ? mutationError.message
                  : 'Native import post-commit verification found missing objects.',
              affectedIds: missing,
            },
          ]
        : [],
      revert: { available: nativeCreated.length > 0 },
    };
    this.assertCommitReady(context);
    this.writeJournal(operationId, {
      digest,
      receipt,
      changes: [],
      ordinal,
      repair,
      nativeCreated,
      nativeImport: native,
    });
    return receipt;
  }

  /**
   * Native bundles may carry up to 5,000 objects. Each batch commits its
   * receipt and the parent job state in one Yjs transaction, so a reload can
   * inspect/reconcile durable progress without replaying already inserted IDs.
   */
  private async applyBatchedNativeImport(
    plan: CanvasPlan,
    digest: string,
    native: StoredNativeImport,
    args: CanvasApplyArgs,
    context: CanvasRuntimeExecutionContext,
    parentOperationId: string | undefined,
    ordinal: number,
    repair: boolean,
    prepared: Awaited<ReturnType<typeof prepareNativeCanvasInsert>>,
    resume?: { stored: StoredOperation; job: NativeImportJob }
  ): Promise<CanvasReceipt> {
    const store = this.options.host.store;
    const operationId =
      resume?.job.operationId ??
      'native_import_' + hashString(plan.planId + ':' + args.requestId);
    const taskId = context.taskId ?? plan.taskId;
    const existing = resume?.stored ?? this.readJournal(operationId);
    const jobRequestId = resume?.job.requestId ?? args.requestId;
    if (existing?.nativeJob && !resume) {
      if (existing.digest !== digest) {
        throw new RuntimeFailure(
          'IDEMPOTENCY_CONFLICT',
          'Native import job identity conflicts with this plan.'
        );
      }
      return existing.receipt;
    }
    if (resume && this.getContentRevision() !== resume.job.contentRevision) {
      throw new RuntimeFailure(
        'STALE_PLAN',
        'Canvas content changed after the last native import batch; resume would overwrite an unreviewed state.'
      );
    }
    for (const [id, blob] of prepared.assets) {
      this.assertCommitReady(context);
      const present = await store.blobSync.get(id);
      this.assertCommitReady(context);
      if (!present) await store.blobSync.set(id, blob);
    }

    // A resumed job is one parent operation. Keep the original revision in
    // its receipt instead of replacing it with the resume boundary.
    const beforeRevision =
      resume?.stored.receipt.beforeRevision ?? this.getContentRevision();
    const importedBlockIds = new Set(
      prepared.entries
        .filter(
          (
            entry
          ): entry is Extract<NativeCanvasInsertEntry, { type: 'block' }> =>
            entry.type === 'block'
        )
        .map(entry => entry.id)
    );
    const created: StoredNativeCreated[] = [...(existing?.nativeCreated ?? [])];
    let nextIndex = resume?.job.nextIndex ?? 0;
    let receipt: CanvasReceipt | undefined;
    while (nextIndex < prepared.entries.length) {
      try {
        this.assertCommitReady(context);
      } catch (error) {
        // Prior batches already committed their parent checkpoint atomically.
        // A deadline/cancel observed at the next boundary reports that durable
        // progress instead of hiding it behind a transport exception.
        if (receipt) return receipt;
        throw error;
      }
      const batch = prepared.entries.slice(
        nextIndex,
        nextIndex + CANVAS_MAX_WRITE_BATCH
      );
      const childOperationId =
        operationId +
        ':batch:' +
        Math.floor(nextIndex / CANVAS_MAX_WRITE_BATCH);
      const batchCreated: StoredNativeCreated[] = [];
      let batchError: unknown;
      store.captureSync();
      store.spaceDoc.transact(() => {
        try {
          for (const entry of batch) {
            insertNativeCanvasEntry(store, entry);
            if (
              entry.type === 'element' ||
              !importedBlockIds.has(entry.parentId)
            ) {
              const change: StoredNativeCreated = {
                id: entry.id,
                type: entry.type,
                snapshot: structuredClone(entry.snapshot),
              };
              batchCreated.push(change);
              created.push(change);
            }
          }
        } catch (error) {
          batchError = error;
        }
        const afterRevision = this.getContentRevision();
        const complete =
          !batchError && nextIndex + batch.length === prepared.entries.length;
        receipt = {
          destination: plan.destination,
          operationId,
          taskId,
          parentOperationId,
          requestId: jobRequestId,
          planId: plan.planId,
          execution: complete ? 'applied' : 'partial',
          verification: complete ? 'passed' : 'needs_attention',
          persistence: this.options.persist ? 'sync_pending' : 'memory',
          verificationChecks: ['structure'],
          beforeRevision,
          afterRevision,
          contentRevision: afterRevision,
          createdIds: created.map(change => change.id),
          updatedIds: [],
          deletedIds: [],
          idMap: prepared.idMap,
          progress: {
            completed: batchError ? nextIndex : nextIndex + batch.length,
            total: prepared.entries.length,
            canResume: !batchError && !complete,
          },
          warnings: complete
            ? []
            : [
                {
                  code: 'PARTIAL_APPLICATION',
                  severity: 'warning',
                  message:
                    batchError instanceof Error
                      ? batchError.message
                      : 'Native import is resumable; remaining batches have not been applied.',
                  affectedIds: batchCreated.map(change => change.id),
                },
              ],
          revert: { available: created.length > 0 },
        };
        const childReceipt: CanvasReceipt = {
          ...receipt,
          operationId: childOperationId,
          parentOperationId: operationId,
          requestId:
            jobRequestId +
            ':batch:' +
            Math.floor(nextIndex / CANVAS_MAX_WRITE_BATCH),
          createdIds: batchCreated.map(change => change.id),
        };
        this.journal.set(
          childOperationId,
          JSON.stringify({
            digest,
            receipt: childReceipt,
            changes: [],
            ordinal: Math.floor(nextIndex / CANVAS_MAX_WRITE_BATCH),
            nativeCreated: batchCreated,
            nativeImport: native,
          } satisfies StoredOperation)
        );
        this.journal.set(
          operationId,
          JSON.stringify({
            digest,
            receipt,
            changes: [],
            ordinal,
            repair,
            nativeCreated: created,
            nativeImport: native,
            nativeJob: {
              operationId,
              plan,
              digest,
              nextIndex: batchError ? nextIndex : nextIndex + batch.length,
              total: prepared.entries.length,
              contentRevision: afterRevision,
              committedIds: prepared.entries
                .slice(0, batchError ? nextIndex : nextIndex + batch.length)
                .map(entry => entry.id),
              canResume:
                !batchError &&
                nextIndex + batch.length < prepared.entries.length,
              requestId: jobRequestId,
            },
          } satisfies StoredOperation)
        );
      }, store.spaceDoc.clientID);
      store.captureSync();
      // The atomic Yjs checkpoint above is recoverable even when external
      // persistence is unavailable. Persist after it, never before it.
      let persistence: CanvasPersistenceState = 'memory';
      if (this.options.persist && receipt) {
        try {
          persistence =
            (await this.options.persist({
              workspaceId: this.options.workspaceId,
              docId: this.options.docId,
              operationId,
              contentRevision: receipt.contentRevision,
              signal: context.signal,
            })) ?? 'local_durable';
        } catch {
          persistence = 'sync_pending';
        }
      }
      if (receipt && persistence !== receipt.persistence) {
        const persisted = {
          ...receipt,
          persistence,
          contentRevision: this.getContentRevision(),
        };
        try {
          this.assertCommitReady(context);
        } catch {
          // The already-committed checkpoint truthfully remains sync_pending;
          // an expired lease must not append metadata after its boundary.
          return receipt;
        }
        const checkpoint = this.readJournal(operationId);
        if (checkpoint)
          this.writeJournal(operationId, { ...checkpoint, receipt: persisted });
        receipt = persisted;
      }
      if (batchError) {
        if (!receipt) {
          throw new RuntimeFailure(
            'PARTIAL_APPLICATION',
            'Native import failed before recording its durable receipt.'
          );
        }
        return receipt;
      }
      nextIndex += batch.length;
      // Let cancellation, deadline and collaboration updates reach the next
      // durable boundary; no batch exceeds the public write budget.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    if (!receipt)
      throw new RuntimeFailure(
        'PARTIAL_APPLICATION',
        'Native import did not record a batch receipt.'
      );
    return receipt;
  }

  private async resumeNativeImport(
    stored: StoredOperation,
    requestId: string,
    context: CanvasRuntimeExecutionContext
  ): Promise<CanvasReceipt> {
    const job = stored.nativeJob;
    const native = stored.nativeImport;
    if (!job || !native) {
      throw new RuntimeFailure(
        'INVALID_PLAN',
        'This operation is not a resumable native import job.'
      );
    }
    if (stored.receipt.execution === 'applied') return stored.receipt;
    if (!job.canResume) {
      throw new RuntimeFailure(
        'OPERATION_CONFLICT',
        'The last native import batch partially failed. Revert its durable changes before creating a new plan.'
      );
    }
    if (this.getContentRevision() !== job.contentRevision) {
      throw new RuntimeFailure(
        'STALE_PLAN',
        'Canvas content changed after the last native import batch. Inspect and create a new plan instead of resuming.'
      );
    }
    let bundle = { snapshot: native.snapshot, assets: new Map<string, Blob>() };
    if (native.artifactHandle) {
      const blob = await this.resolveNativeArtifact(
        { handle: native.artifactHandle },
        context.signal
      );
      bundle = await readNativeCanvas(
        blob,
        this.options.host.store,
        context.signal
      );
    }
    const prepared = await prepareNativeCanvasInsert(
      this.options.host.store,
      bundle,
      {
        allocateId: sourceId => {
          const id = native.idMap[sourceId];
          if (!id)
            throw new RuntimeFailure(
              'INVALID_PLAN',
              'Native import allocation is unavailable.'
            );
          return id;
        },
        placement: native.placement,
        signal: context.signal,
        allowExistingIds: new Set(job.committedIds),
      }
    );
    return this.applyBatchedNativeImport(
      job.plan,
      job.digest,
      native,
      { planId: job.plan.planId, requestId },
      context,
      stored.receipt.parentOperationId,
      stored.ordinal ?? 0,
      stored.repair ?? false,
      prepared,
      { stored, job }
    );
  }

  private async operation(
    args: CanvasOperationArgs,
    context: CanvasRuntimeExecutionContext
  ): Promise<CanvasReceipt> {
    const requestedById = args.requestId
      ? this.readJournalByRequestId(args.requestId)
      : undefined;
    if (args.action === 'status' && requestedById) {
      if (requestedById.targetDocumentId) {
        await this.assertTargetAuthorization(
          requestedById.targetDocumentId,
          false,
          false,
          context
        );
      }
      return requestedById.targetDocumentId
        ? requestedById.receipt
        : {
            ...requestedById.receipt,
            contentRevision: this.getContentRevision(),
          };
    }
    const operationId = args.operationId;
    if (!operationId) {
      throw new RuntimeFailure(
        'INVALID_PLAN',
        'operationId or a known requestId is required.'
      );
    }
    const stored = this.readJournal(operationId);
    const children = stored ? [] : this.readJournalChildren(operationId);
    if (!stored && !children.length) {
      throw new RuntimeFailure(
        'INVALID_PLAN',
        `Canvas operation ${operationId} was not found.`
      );
    }
    if (args.action === 'status') {
      if (stored) {
        if (stored.targetDocumentId) {
          await this.assertTargetAuthorization(
            stored.targetDocumentId,
            false,
            false,
            context
          );
        }
        return stored.targetDocumentId
          ? stored.receipt
          : { ...stored.receipt, contentRevision: this.getContentRevision() };
      }
      return this.aggregateReceipts(
        operationId,
        children.map(child => child.receipt)
      );
    }
    // New-document jobs are mirrored in the source journal, but their
    // durable native state lives in the target document. Delegate before the
    // resume branch so the source lease never resumes against the wrong host.
    if (stored?.targetDocumentId) {
      return this.operationInDocument(stored, args, context);
    }
    if ((args.action as string) === 'resume') {
      this.assertWrite(context);
      if (!args.requestId) {
        throw new RuntimeFailure(
          'INVALID_PLAN',
          'resume requires a new requestId.'
        );
      }
      if (!stored?.nativeJob) {
        throw new RuntimeFailure(
          'INVALID_PLAN',
          'Only a durable native import job can resume.'
        );
      }
      return this.resumeNativeImport(stored, args.requestId, context);
    }
    if (args.action === 'cancel') {
      const receipt =
        stored?.receipt ??
        this.aggregateReceipts(
          operationId,
          children.map(child => child.receipt)
        );
      if (stored?.nativeJob && receipt.execution === 'partial') {
        const cancelled: CanvasReceipt = {
          ...receipt,
          execution: 'cancelled',
          contentRevision: this.getContentRevision(),
          progress: receipt.progress
            ? { ...receipt.progress, canResume: false }
            : undefined,
        };
        this.assertCommitReady(context);
        this.writeJournal(operationId, {
          ...stored,
          receipt: cancelled,
          nativeJob: { ...stored.nativeJob, canResume: false },
        });
        return cancelled;
      }
      if (receipt.execution === 'applied' || receipt.execution === 'partial') {
        throw new RuntimeFailure(
          'OPERATION_CONFLICT',
          'Committed canvas changes cannot be cancelled; use revert.'
        );
      }
      return {
        ...receipt,
        execution: 'cancelled' as const,
        contentRevision: this.getContentRevision(),
      };
    }
    this.assertWrite(context);
    if (!args.requestId) {
      throw new RuntimeFailure(
        'INVALID_PLAN',
        `${args.action} requires a new requestId.`
      );
    }
    const targets = stored ? [stored] : children.reverse();
    if (args.action === 'revert') {
      return this.revert(operationId, targets, args.requestId, context);
    }
    if (stored?.nativeImport) {
      const reversion = this.findLatestReversion(operationId);
      if (!reversion) {
        throw new RuntimeFailure(
          'OPERATION_CONFLICT',
          'Redo requires a successfully recorded native import revert operation.'
        );
      }
      return this.redoNativeImport(
        operationId,
        stored,
        args.requestId,
        context
      );
    }
    const reversion = stored?.originalOperationId
      ? stored
      : this.findLatestReversion(operationId);
    if (!reversion) {
      throw new RuntimeFailure(
        'OPERATION_CONFLICT',
        'Redo requires a successfully recorded revert operation.'
      );
    }
    return this.redo(operationId, [reversion], args.requestId, context);
  }

  private async revert(
    originalOperationId: string,
    targets: readonly StoredOperation[],
    requestId: string,
    context: CanvasRuntimeExecutionContext
  ) {
    const digest = hashString(`revert:${originalOperationId}`);
    const prior = this.readJournalByRequestId(requestId);
    if (prior) {
      if (prior.digest !== digest)
        throw new RuntimeFailure(
          'IDEMPOTENCY_CONFLICT',
          'requestId was used for another operation.'
        );
      return prior.receipt;
    }
    const beforeRevision = this.getContentRevision();
    const conflicts: string[] = [];
    const createdIds: string[] = [];
    const updatedIds: string[] = [];
    const deletedIds: string[] = [];
    const inverseChanges: StoredChange[] = [];
    const operationId = randomId('revert');
    const nativeImport =
      targets.length === 1 ? targets[0]?.nativeImport : undefined;
    this.options.host.store.captureSync();
    this.assertCommitReady(context);
    this.options.host.store.spaceDoc.transact(() => {
      for (const target of targets) {
        for (const change of target.nativeCreated ?? []) {
          const current = this.adapter.nativeSnapshot(change.id);
          if (current === undefined) continue;
          if (!equal(current, change.snapshot)) {
            conflicts.push(change.id);
            continue;
          }
          this.adapter.delete(change.id);
          deletedIds.push(change.id);
        }
        const createdChanges = target.changes.filter(
          (change): change is Extract<StoredChange, { type: 'create' }> =>
            change.type === 'create'
        );
        const deletedChanges = target.changes.filter(
          (change): change is Extract<StoredChange, { type: 'delete' }> =>
            change.type === 'delete'
        );
        const updatedChanges = target.changes.filter(
          (change): change is Extract<StoredChange, { type: 'update' }> =>
            change.type === 'update'
        );
        const orderedCreates = dependencyOrderedChanges(
          createdChanges,
          change => change.after
        );
        const orderedDeletes = dependencyOrderedChanges(
          deletedChanges,
          change => change.before
        );
        // Decide create conflicts before applying any inverse. Deleting a child
        // changes its container snapshot and must not make that same container
        // look like a concurrent edit later in this transaction.
        const createConflicts = new Set(
          orderedCreates
            .filter(change => {
              const current = this.adapter.getNode(change.id);
              return !!current && !equal(current, change.after);
            })
            .map(change => change.id)
        );
        const createdById = new Map(
          orderedCreates.map(change => [change.id, change])
        );
        let propagated = true;
        while (propagated) {
          propagated = false;
          for (const change of orderedCreates) {
            if (!createConflicts.has(change.id)) continue;
            for (const dependency of nodeDependencies(change.after)) {
              if (
                createdById.has(dependency) &&
                !createConflicts.has(dependency)
              ) {
                createConflicts.add(dependency);
                propagated = true;
              }
            }
          }
        }
        const orderedChanges: StoredChange[] = [
          // Applying plans creates first and deletes last. Its inverse therefore
          // restores deleted dependency trees first, restores fields, and then
          // removes created dependants before their parents/endpoints.
          ...orderedDeletes,
          ...updatedChanges.reverse(),
          ...orderedCreates.reverse(),
        ];
        const deletedById = new Map(
          orderedDeletes.map(change => [change.id, change])
        );
        for (const change of orderedChanges) {
          const current = this.adapter.getNode(change.id);
          if (change.type === 'create') {
            if (!current) continue;
            if (createConflicts.has(change.id)) {
              conflicts.push(change.id);
              continue;
            }
            this.adapter.delete(change.id);
            deletedIds.push(change.id);
            inverseChanges.push({
              type: 'delete',
              id: change.id,
              // The current node was verified against this snapshot before any
              // inverse mutations. A container's live children may already be
              // different here because its descendants are removed first.
              before: change.after,
            });
          } else if (change.type === 'update') {
            if (
              !current ||
              !equal(pickNodeFields(current, change.fields), change.after)
            ) {
              conflicts.push(change.id);
              continue;
            }
            this.adapter.update(
              change.id,
              restoreUnsetFields(change.before, change.unsetBefore)
            );
            const after = this.adapter.getNode(change.id);
            if (!after) {
              conflicts.push(change.id);
              continue;
            }
            updatedIds.push(change.id);
            inverseChanges.push({
              type: 'update',
              id: change.id,
              fields: change.fields,
              before: change.after,
              after: pickNodeFields(after, change.fields),
              unsetBefore: change.unsetAfter,
              unsetAfter: change.unsetBefore,
            });
          } else {
            if (current) {
              conflicts.push(change.id);
              continue;
            }
            const localParent = change.before.parentId
              ? deletedById.get(change.before.parentId)
              : undefined;
            const restoredId = this.adapter.create(
              change.before,
              localParent
                ? localParentDescriptor(localParent.before)
                : undefined
            );
            createdIds.push(restoredId);
            inverseChanges.push({
              type: 'create',
              id: restoredId,
              // BlockSuite hydrates nested block models after the enclosing
              // Y.Doc transaction. Use the immutable source snapshot here and
              // verify the materialized ID once the transaction closes.
              after: { ...change.before, id: restoredId } as CanvasNode,
            });
          }
        }
      }
      const provisionalRevision = this.getContentRevision();
      const provisionalReceipt: CanvasReceipt = {
        destination: targets[0]?.receipt.destination ?? {
          type: 'existing',
          documentId: this.options.docId,
        },
        operationId,
        taskId: context.taskId,
        parentOperationId: originalOperationId,
        requestId,
        planId: `inverse:${originalOperationId}`,
        execution: conflicts.length
          ? createdIds.length || updatedIds.length || deletedIds.length
            ? 'partial'
            : 'conflict'
          : 'reverted',
        verification: conflicts.length ? 'needs_attention' : 'passed',
        persistence: 'memory',
        verificationChecks: ['structure'],
        beforeRevision,
        afterRevision: provisionalRevision,
        contentRevision: provisionalRevision,
        createdIds,
        updatedIds,
        deletedIds,
        idMap: {},
        warnings: conflicts.length
          ? [
              {
                code: 'OPERATION_CONFLICT',
                severity: 'warning',
                message:
                  'Some fields changed after the AI operation and were preserved.',
                affectedIds: conflicts,
              },
            ]
          : [],
        revert: {
          available: inverseChanges.length > 0 || deletedIds.length > 0,
        },
      };
      this.journal.set(
        operationId,
        JSON.stringify({
          digest,
          receipt: provisionalReceipt,
          changes: inverseChanges,
          originalOperationId,
          nativeImport,
        } satisfies StoredOperation)
      );
    }, this.options.host.store.spaceDoc.clientID);
    this.options.host.store.captureSync();
    for (const id of createdIds) {
      if (!this.adapter.getNode(id) && !conflicts.includes(id)) {
        conflicts.push(id);
      }
    }
    for (const target of targets) {
      if (!target.nativeImport) continue;
      for (const id of target.receipt.createdIds) {
        if (
          this.adapter.nativeSnapshot(id) === undefined &&
          !deletedIds.includes(id)
        ) {
          deletedIds.push(id);
        }
      }
    }
    const afterRevision = this.getContentRevision();
    const receipt: CanvasReceipt = {
      destination: targets[0]?.receipt.destination ?? {
        type: 'existing',
        documentId: this.options.docId,
      },
      operationId,
      taskId: context.taskId,
      parentOperationId: originalOperationId,
      requestId,
      planId: `inverse:${originalOperationId}`,
      execution: conflicts.length
        ? createdIds.length || updatedIds.length || deletedIds.length
          ? 'partial'
          : 'conflict'
        : 'reverted',
      verification: conflicts.length ? 'needs_attention' : 'passed',
      persistence: 'memory',
      verificationChecks: ['structure'],
      beforeRevision,
      afterRevision,
      contentRevision: afterRevision,
      createdIds,
      updatedIds,
      deletedIds,
      idMap: {},
      warnings: conflicts.length
        ? [
            {
              code: 'OPERATION_CONFLICT',
              severity: 'warning',
              message:
                'Some fields changed after the AI operation and were preserved.',
              affectedIds: conflicts,
            },
          ]
        : [],
      revert: { available: inverseChanges.length > 0 || deletedIds.length > 0 },
    };
    this.writeJournal(operationId, {
      digest,
      receipt,
      changes: inverseChanges,
      originalOperationId,
      nativeImport,
    });
    return this.persistReceipt(
      operationId,
      digest,
      receipt,
      inverseChanges,
      context,
      originalOperationId,
      nativeImport ? { nativeImport } : undefined
    );
  }

  private async redo(
    originalOperationId: string,
    targets: readonly StoredOperation[],
    requestId: string,
    context: CanvasRuntimeExecutionContext
  ) {
    const receipt = await this.revert(
      originalOperationId,
      targets,
      requestId,
      context
    );
    if (receipt.execution !== 'reverted') return receipt;
    const applied: CanvasReceipt = { ...receipt, execution: 'applied' };
    const stored = this.readJournal(receipt.operationId);
    if (stored) {
      this.assertCommitReady(context);
      this.writeJournal(receipt.operationId, { ...stored, receipt: applied });
    }
    return applied;
  }

  private async redoNativeImport(
    originalOperationId: string,
    stored: StoredOperation,
    requestId: string,
    context: CanvasRuntimeExecutionContext
  ) {
    const digest = hashString(`redo-native:${originalOperationId}`);
    const prior = this.readJournalByRequestId(requestId);
    if (prior) {
      if (prior.digest !== digest) {
        throw new RuntimeFailure(
          'IDEMPOTENCY_CONFLICT',
          'requestId was used for another operation.'
        );
      }
      return prior.receipt;
    }
    const native = stored.nativeImport;
    const originalPlan = this.readPreparedPlan(stored.receipt.planId)?.plan;
    if (!native || !originalPlan) {
      throw new RuntimeFailure(
        'OPERATION_CONFLICT',
        'The native import plan is unavailable for redo.'
      );
    }
    const plan: CanvasPlan = {
      ...originalPlan,
      baseContentRevision: this.getContentRevision(),
    };
    try {
      const receipt = await this.applyNativeImport(
        plan,
        digest,
        native,
        { planId: plan.planId, requestId },
        context,
        originalOperationId,
        this.nextOrdinal(originalOperationId),
        false
      );
      const replay = this.readJournal(receipt.operationId);
      if (replay) {
        this.assertCommitReady(context);
        this.writeJournal(receipt.operationId, {
          ...replay,
          digest,
          originalOperationId,
        });
      }
      return receipt;
    } catch (error) {
      if (error instanceof RuntimeFailure) throw error;
      throw new RuntimeFailure(
        'OPERATION_CONFLICT',
        error instanceof Error
          ? error.message
          : 'Native import redo conflicts with current canvas content.'
      );
    }
  }

  private async focus(
    args: CanvasToolArgsMap['canvas_focus'],
    context: CanvasRuntimeExecutionContext
  ) {
    if (args.destination.type === 'new_document') {
      const docId = args.destination.reservedDocumentId;
      const openDocument = this.options.openDocument;
      if (!docId || (!openDocument && !this.options.deferNavigation)) {
        throw new RuntimeFailure(
          'EDITOR_UNAVAILABLE',
          'The target document cannot be opened from this runtime.'
        );
      }
      await this.assertTargetAuthorization(docId, false, false, context);
      abortIfNeeded(context.signal);
      deadlineIfNeeded(context.deadline);
      if (this.options.deferNavigation) {
        return { focusedScope: args.scope, navigation: { docId } };
      }
      if (!openDocument) {
        throw new RuntimeFailure(
          'EDITOR_UNAVAILABLE',
          'The target document cannot be opened from this runtime.'
        );
      }
      await openDocument({ docId, signal: context.signal });
      abortIfNeeded(context.signal);
      deadlineIfNeeded(context.deadline);
      return { focusedScope: args.scope };
    }
    this.assertDestination(args.destination, context);
    const nodes = this.nodesInScope(args.scope);
    if (!nodes.length && !args.scope.bounds) {
      throw new RuntimeFailure(
        'AMBIGUOUS_TARGET',
        'Focus scope did not resolve to any canvas objects.'
      );
    }
    const bounds = args.scope.bounds ?? commonBounds(nodes);
    this.adapter.gfx.viewport.setViewportByBound(
      Bound.from(bounds),
      [40, 40, 40, 40],
      true
    );
    if (args.mode === 'select') {
      this.adapter.gfx.selection.set({
        elements: nodes.map(node => node.id),
        editing: false,
      });
    }
    return {
      focusedScope: { ...args.scope, bounds, ids: nodes.map(node => node.id) },
    };
  }

  private async render(
    args: CanvasToolArgsMap['canvas_render'],
    context: CanvasRuntimeExecutionContext
  ) {
    if (args.planId) {
      const prepared = this.readPreparedPlan(args.planId);
      if (!prepared || prepared.plan.status !== 'ready')
        throw new RuntimeFailure(
          'INVALID_PLAN',
          'The prepared canvas plan is unavailable or invalid.'
        );
      if (!equal(prepared.plan.destination, args.destination))
        throw new RuntimeFailure(
          'INVALID_PLAN',
          'Preview destination does not match the prepared plan.'
        );
      if (prepared.plan.baseContentRevision !== this.getContentRevision())
        throw new RuntimeFailure(
          'STALE_PLAN',
          'The canvas changed after the plan was prepared.'
        );
      const { createCanvasPreviewDocument } =
        await import('./preview-document');
      const preview = await createCanvasPreviewDocument(
        this.options.host,
        prepared.plan.destination.type === 'new_document',
        context.signal
      );
      const child = new CanvasRuntime({
        host: preview.host,
        workspaceId: this.options.workspaceId,
        docId: preview.host.store.id,
        resolveArtifact: this.options.resolveArtifact,
      });
      try {
        child.storePlan(
          {
            ...prepared.plan,
            destination: {
              type: 'existing',
              documentId: preview.host.store.id,
            },
            baseContentRevision: child.getContentRevision(),
          },
          prepared.native,
          context
        );
        const receipt = await child.apply(
          { planId: prepared.plan.planId, requestId: randomId('preview') },
          {
            signal: context.signal,
            deadline: context.deadline,
            canWrite: true,
            taskId: context.taskId,
          }
        );
        if (receipt.execution !== 'applied')
          throw new RuntimeFailure(
            'RENDER_UNAVAILABLE',
            'Native plan preview did not materialize completely.'
          );
        const ids = args.scope?.ids?.map(id => receipt.idMap[id] ?? id) ?? [
          ...receipt.createdIds,
          ...receipt.updatedIds,
        ];
        const nodes = child.adapter.allNodes.filter(
          node => !ids.length || ids.includes(node.id)
        );
        const bounds = args.scope?.bounds ?? commonBounds(nodes);
        const canvas = await child.adapter.render(
          bounds,
          ids.length ? ids : undefined,
          args.scale ?? 1,
          context
        );
        abortIfNeeded(context.signal);
        deadlineIfNeeded(context.deadline);
        if (!canvas)
          throw new RuntimeFailure(
            'RENDER_UNAVAILABLE',
            'The native plan preview renderer is unavailable.'
          );
        const blob = await new Promise<Blob | null>(resolve =>
          canvas.toBlob(resolve, 'image/png')
        );
        if (!blob)
          throw new RuntimeFailure(
            'RENDER_UNAVAILABLE',
            'The native plan preview did not produce an image.'
          );
        const artifact = await this.artifact(
          blob,
          `canvas-preview-${args.planId}.png`,
          'image/png',
          context.signal
        );
        const inline = await boundedCanvasPreview(canvas);
        return {
          kind: 'plan_preview' as const,
          planId: args.planId,
          contentRevision: prepared.plan.baseContentRevision,
          scope: { ...args.scope, bounds },
          artifact: {
            ...artifact,
            ...(inline ? { dataUrl: await blobDataUrl(inline) } : {}),
          },
          visualVerificationAvailable: !!inline,
        };
      } finally {
        child.dispose();
        preview.dispose();
      }
    }
    this.assertDestination(args.destination, context);
    const revision = this.getContentRevision();
    if (args.contentRevision && args.contentRevision !== revision) {
      throw new RuntimeFailure(
        'STALE_PLAN',
        'Requested render revision is no longer current.'
      );
    }
    const scope = args.scope ?? {};
    const nodes = this.nodesInScope(scope);
    const bounds = scope.bounds ?? commonBounds(nodes);
    // Gfx block views are virtualized outside the live viewport. Render a
    // snapshot in an isolated, mounted preview so exporting an off-screen note
    // never reads a zero-sized DOM block or changes the user's document/view.
    const { createCanvasPreviewDocument } = await import('./preview-document');
    const preview = await createCanvasPreviewDocument(
      this.options.host,
      false,
      context.signal
    );
    let canvas: HTMLCanvasElement | undefined;
    try {
      const previewAdapter = new NativeCanvasAdapter(preview.host);
      previewAdapter.gfx.viewport.setViewportByBound(
        Bound.from(bounds),
        [24, 24, 24, 24],
        false
      );
      await preview.host.updateComplete.catch(() => undefined);
      await new Promise<void>(resolve =>
        requestAnimationFrame(() => resolve())
      );
      context.signal?.throwIfAborted();
      canvas = await previewAdapter.render(
        bounds,
        scope.ids,
        args.scale ?? 1,
        context
      );
    } finally {
      preview.dispose();
    }
    abortIfNeeded(context.signal);
    deadlineIfNeeded(context.deadline);
    if (!canvas)
      throw new RuntimeFailure(
        'RENDER_UNAVAILABLE',
        'The active editor does not have a CanvasRenderer.'
      );
    const blob = await new Promise<Blob | null>(resolve =>
      canvas.toBlob(resolve, 'image/png')
    );
    if (!blob)
      throw new RuntimeFailure(
        'RENDER_UNAVAILABLE',
        'Canvas renderer did not produce an image.'
      );
    const artifact = await this.artifact(
      blob,
      `canvas-${revision}.png`,
      'image/png',
      context.signal
    );
    const inline = await boundedCanvasPreview(canvas);
    const dataUrl = inline ? await blobDataUrl(inline) : undefined;
    return {
      kind: 'document' as const,
      contentRevision: revision,
      scope: { ...scope, bounds },
      artifact: { ...artifact, ...(dataUrl ? { dataUrl } : {}) },
      visualVerificationAvailable: !!dataUrl,
    };
  }

  private async import(
    args: CanvasToolArgsMap['canvas_import'],
    context: CanvasRuntimeExecutionContext
  ): Promise<CanvasToolResultMap['canvas_import']> {
    this.assertWrite(context);
    const destination = this.preparedDestination(args.destination, context);
    if (args.format === 'asset') {
      const value = args.content as unknown as JsonObject;
      if (!value || value.kind !== 'artifact_handle')
        throw new RuntimeFailure(
          'INVALID_PLAN',
          'Asset import requires an authenticated attachment handle.'
        );
      const blob = await this.resolveNativeArtifact(value, context.signal);
      const { createNativeAssetBundle } = await import('./asset-import');
      const bundle = await createNativeAssetBundle(this.options.host.store, {
        blob,
        name: typeof value.fileName === 'string' ? value.fileName : undefined,
        bounds: args.placement,
      });
      return this.importPreparedBundle(bundle, args, context);
    }
    if (args.format === 'native') {
      let bundle: Awaited<ReturnType<typeof readNativeCanvas>>;
      let artifactHandle: string | undefined;
      try {
        const content = args.content as unknown;
        artifactHandle =
          content &&
          typeof content === 'object' &&
          !Array.isArray(content) &&
          (content as JsonObject).kind === 'artifact_handle' &&
          typeof (content as JsonObject).handle === 'string'
            ? ((content as JsonObject).handle as string)
            : undefined;
        const input =
          content &&
          typeof content === 'object' &&
          !Array.isArray(content) &&
          (content as JsonObject).kind === 'artifact_handle'
            ? await this.resolveNativeArtifact(
                content as JsonObject,
                context.signal
              )
            : (content as DocSnapshot);
        bundle = await readNativeCanvas(
          input,
          this.options.host.store,
          context.signal
        );
      } catch (error) {
        if (error instanceof RuntimeFailure) throw error;
        const code =
          error && typeof error === 'object' && 'code' in error
            ? (error.code as CanvasErrorCode)
            : 'INVALID_PLAN';
        throw new RuntimeFailure(
          code,
          error instanceof Error
            ? error.message
            : 'Native canvas snapshot is invalid.'
        );
      }
      const allocations = new Map<string, string>();
      const prepared = await prepareNativeCanvasInsert(
        this.options.host.store,
        bundle,
        {
          allocateId: sourceId => {
            const existing = allocations.get(sourceId);
            if (existing) return existing;
            const id = `canvas_${crypto.randomUUID()}`;
            allocations.set(sourceId, id);
            return id;
          },
          placement: args.placement,
          signal: context.signal,
        }
      );
      const revision = this.getContentRevision();
      const requestedScope =
        args.requestedScope ??
        (args.placement ? { bounds: args.placement } : {});
      const plan = this.storePlan(
        {
          schemaVersion: CANVAS_CONTRACT_VERSION,
          planId: randomId('plan'),
          status: 'ready',
          baseContentRevision: revision,
          capabilitiesVersion: CAPABILITIES_VERSION,
          requestedScope,
          effectiveScope: {
            ...requestedScope,
            ids: prepared.entries.map(entry => entry.id),
          },
          destination,
          taskId: context.taskId ?? args.taskId,
          parentOperationId:
            context.parentOperationId ?? args.parentOperationId,
          operations: [],
          diagnostics: [],
        },
        {
          kind: 'native-import',
          snapshot: bundle.snapshot,
          placement: args.placement,
          idMap: prepared.idMap,
          artifactHandle,
        },
        context
      );
      return { plan };
    }
    const content = await readInterchangeInput(
      args.format,
      args.content,
      handle => this.resolveNativeArtifact({ handle }, context.signal)
    );
    abortIfNeeded(context.signal);
    deadlineIfNeeded(context.deadline);
    if (
      args.format === 'excalidraw' &&
      content &&
      typeof content === 'object' &&
      !Array.isArray(content) &&
      'elements' in content &&
      Array.isArray(content.elements) &&
      content.elements.some(
        element =>
          element &&
          typeof element === 'object' &&
          'type' in element &&
          element.type === 'image'
      )
    ) {
      const { createExcalidrawBundle } = await import('./asset-import');
      const bundle = await createExcalidrawBundle(
        this.options.host,
        content,
        context.signal
      );
      return this.importPreparedBundle(bundle, args, context);
    }
    const decoded = importCanvasInterchange(
      {
        format: args.format,
        content,
        maxObjects: CANVAS_MAX_WRITE_BATCH,
      },
      { xml: canvasXmlParser }
    );
    if (!decoded.ok)
      throw new RuntimeFailure(decoded.error.code, decoded.error.message);
    const placed = placeImportedCanvas(decoded.data.nodes, args.placement);
    const operations = placed.nodes.map((node: CanvasNode) => ({
      type: 'create' as const,
      node,
    }));
    const validated = this.validate(
      {
        destination,
        baseContentRevision: this.getContentRevision(),
        requestedScope:
          args.requestedScope ??
          (args.placement ? { bounds: args.placement } : {}),
        operations,
        taskId: args.taskId,
        parentOperationId: args.parentOperationId,
      },
      context
    );
    return {
      ...validated,
      fidelity: decoded.data.fidelity,
      diagnostics: decoded.data.diagnostics,
      sourceIdMap: placed.idMap,
    };
  }

  /** The compiled bundle is durable and authenticated before its plan is offered. */
  private async importPreparedBundle(
    bundle: Awaited<ReturnType<typeof readNativeCanvas>>,
    args: CanvasToolArgsMap['canvas_import'],
    context: CanvasRuntimeExecutionContext
  ): Promise<CanvasToolResultMap['canvas_import']> {
    if (!this.options.createArtifact || !this.options.resolveArtifact)
      throw new RuntimeFailure(
        'UNSUPPORTED_CAPABILITY',
        'Image and attachment imports require authenticated artifact storage.'
      );
    abortIfNeeded(context.signal);
    deadlineIfNeeded(context.deadline);
    const packed = await packNativeCanvasBundle(bundle, context.signal);
    const artifact = await this.artifact(
      packed.blob,
      'canvas-import.bs.zip',
      'application/zip',
      context.signal
    );
    if (!artifact.handle)
      throw new RuntimeFailure(
        'ASSET_MISSING',
        'Artifact storage did not return a durable import handle.'
      );
    const result = await this.import(
      {
        ...args,
        format: 'native',
        content: { kind: 'artifact_handle', handle: artifact.handle },
      },
      context
    );
    return {
      ...result,
      fidelity: {
        format: args.format,
        entries: [
          {
            feature: 'editable-native-blocks-and-local-assets',
            outcome: args.format === 'asset' ? 'preserved' : 'converted',
          },
        ],
      },
    };
  }

  private async export(
    args: CanvasExportArgs,
    context: CanvasRuntimeExecutionContext
  ) {
    this.assertDestination(args.destination, context);
    const revision = this.getContentRevision();
    if (args.format === 'excalidraw') {
      const nodes = this.nodesInScope(args.scope);
      if (nodes.some(node => node.kind === 'block:affine:image')) {
        const { exportExcalidrawWithAssets } = await import('./asset-import');
        const content = await exportExcalidrawWithAssets(
          this.options.host,
          nodes
        );
        const blob = new Blob([JSON.stringify(content)], {
          type: 'application/json',
        });
        const artifact = await this.artifact(
          blob,
          'canvas.excalidraw',
          'application/json',
          context.signal
        );
        return {
          format: args.format,
          contentRevision: revision,
          checksum: artifact.checksum,
          artifact,
          losses: [
            {
              code: 'FORMAT_LOSS' as const,
              severity: 'info' as const,
              message:
                'Se conservan imágenes locales y geometría compatible. Los estilos se convierten al subconjunto Excalidraw; usa .bs.zip para fidelidad nativa.',
            },
          ],
        };
      }
    }
    if (args.format === 'pdf') {
      const nodes = this.nodesInScope(args.scope);
      const bounds = args.scope.bounds ?? commonBounds(nodes);
      const { createCanvasPreviewDocument } =
        await import('./preview-document');
      const preview = await createCanvasPreviewDocument(
        this.options.host,
        false,
        context.signal
      );
      let canvas: HTMLCanvasElement | undefined;
      try {
        const previewAdapter = new NativeCanvasAdapter(preview.host);
        previewAdapter.gfx.viewport.setViewportByBound(
          Bound.from(bounds),
          [24, 24, 24, 24],
          false
        );
        await preview.host.updateComplete.catch(() => undefined);
        await new Promise<void>(resolve =>
          requestAnimationFrame(() => resolve())
        );
        context.signal?.throwIfAborted();
        canvas = await previewAdapter.render(
          bounds,
          args.scope.ids,
          1,
          context
        );
      } finally {
        preview.dispose();
      }
      abortIfNeeded(context.signal);
      deadlineIfNeeded(context.deadline);
      if (!canvas)
        throw new RuntimeFailure(
          'RENDER_UNAVAILABLE',
          'The native canvas renderer is unavailable for PDF export.'
        );
      const blob = await canvasToPdf(
        canvas,
        this.options.host.store.meta?.title ?? 'Canvas'
      );
      const artifact = await this.artifact(
        blob,
        `canvas-${revision}.pdf`,
        'application/pdf',
        context.signal
      );
      return {
        contentRevision: revision,
        format: args.format,
        checksum: artifact.checksum,
        losses: [
          {
            code: 'FORMAT_LOSS' as const,
            severity: 'info' as const,
            message:
              'PDF de presentación con imagen raster. El respaldo editable es el formato nativo .bs.zip.',
          },
        ],
        artifact,
      };
    }
    if (args.format === 'png') {
      const rendered = await this.render(
        {
          destination: args.destination,
          scope: args.scope,
          contentRevision: revision,
        },
        context
      );
      return {
        contentRevision: revision,
        format: args.format,
        checksum: rendered.artifact.checksum,
        losses: [],
        artifact: rendered.artifact,
      };
    }
    if (args.format === 'native') {
      const bundle = await exportNativeCanvas(
        this.options.host,
        args.scope,
        context.signal
      );
      const artifact = await this.artifact(
        bundle.blob,
        bundle.fileName,
        'application/zip',
        context.signal
      );
      return {
        contentRevision: revision,
        format: args.format,
        checksum: bundle.checksum,
        losses: [],
        artifact,
      };
    }
    const nodes = this.nodesInScope(args.scope);
    const encoded = exportCanvasInterchange({
      format: args.format,
      nodes,
      maxObjects: CANVAS_MAX_WRITE_BATCH,
    });
    if (!encoded.ok)
      throw new RuntimeFailure(encoded.error.code, encoded.error.message);
    const exported = encoded.data;
    const content = exported.content ?? exported.recipe;
    const payload =
      typeof content === 'string' ? content : stableStringify(content);
    const checksum = await canvasChecksum(new TextEncoder().encode(payload));
    const mimeType =
      args.format === 'svg'
        ? 'image/svg+xml'
        : args.format === 'markdown' || args.format === 'mermaid'
          ? 'text/plain;charset=utf-8'
          : args.format === 'freemind' || args.format === 'opml'
            ? 'application/xml'
            : 'application/json';
    const extension = args.format === 'recipe' ? 'json' : args.format;
    const blob = new Blob([payload], { type: mimeType });
    const artifact = await this.artifact(
      blob,
      `canvas-${checksum}.${extension}`,
      mimeType,
      context.signal
    );
    const fidelityLosses = exported.fidelity.entries
      .filter(entry => entry.outcome !== 'preserved')
      .map(entry => ({
        code: 'FORMAT_LOSS' as const,
        severity: 'warning' as const,
        message: `${entry.feature}: ${entry.outcome}`,
      }));
    return {
      contentRevision: revision,
      format: args.format,
      checksum,
      losses: [...exported.diagnostics, ...fidelityLosses],
      artifact,
    };
  }

  private nodesInScope(scope: CanvasScope) {
    const ids = scope.ids ? new Set(scope.ids) : undefined;
    const allNodes = this.adapter.allNodes;
    if (ids) {
      const existingIds = new Set(allNodes.map(node => node.id));
      const missing = [...ids].filter(id => !existingIds.has(id));
      if (missing.length) {
        throw new RuntimeFailure(
          'INVALID_PLAN',
          `Unknown scope IDs: ${missing.slice(0, 10).join(', ')}. Use exact IDs returned by canvas_read or a receipt. For the whole canvas use scope: {} and omit ids; "*" is not a wildcard.`
        );
      }
    }
    return allNodes.filter(node => {
      if (ids && !ids.has(node.id)) return false;
      return !scope.bounds || intersects(node.bounds, scope.bounds);
    });
  }

  private resolveNodeReferences(
    node: CanvasNode,
    idMap: Record<string, string>
  ): CanvasNode {
    return {
      ...node,
      ...(node.parentId
        ? { parentId: idMap[node.parentId] ?? node.parentId }
        : {}),
      ...(node.sourceId
        ? { sourceId: idMap[node.sourceId] ?? node.sourceId }
        : {}),
      ...(node.targetId
        ? { targetId: idMap[node.targetId] ?? node.targetId }
        : {}),
    };
  }

  private resolvePatchReferences(
    patch: Extract<
      CanvasPlan['operations'][number],
      { type: 'update' }
    >['patch'],
    idMap: Record<string, string>
  ) {
    return {
      ...patch,
      ...(patch.parentId
        ? { parentId: idMap[patch.parentId] ?? patch.parentId }
        : {}),
      ...(patch.sourceId
        ? { sourceId: idMap[patch.sourceId] ?? patch.sourceId }
        : {}),
      ...(patch.targetId
        ? { targetId: idMap[patch.targetId] ?? patch.targetId }
        : {}),
    };
  }

  private preparedDestination(
    destination: CanvasToolArgsMap['canvas_read']['destination'],
    context: CanvasRuntimeExecutionContext
  ) {
    if (destination.type === 'existing') {
      this.assertDestination(destination, context);
      return destination;
    }
    if (context.canCreateDoc === false) {
      throw new RuntimeFailure(
        'PERMISSION_DENIED',
        'The current authorization cannot create documents.'
      );
    }
    if (!this.options.createDocument) {
      throw new RuntimeFailure(
        'UNSUPPORTED_CAPABILITY',
        'New-document lifecycle is not configured.'
      );
    }
    if (destination.workspaceId !== this.options.workspaceId) {
      throw new RuntimeFailure(
        'PERMISSION_DENIED',
        'New canvas document is outside the bound workspace.'
      );
    }
    return {
      ...destination,
      reservedDocumentId: destination.reservedDocumentId ?? crypto.randomUUID(),
    };
  }

  private async applyToNewDocument(
    plan: CanvasPlan,
    _digest: string,
    native: StoredNativeImport | undefined,
    args: CanvasApplyArgs,
    context: CanvasRuntimeExecutionContext
  ): Promise<CanvasReceipt> {
    if (plan.destination.type !== 'new_document') {
      throw new RuntimeFailure(
        'INVALID_PLAN',
        'New-document plan does not contain a reserved document ID.'
      );
    }
    const docId = plan.destination.reservedDocumentId;
    if (!docId) {
      throw new RuntimeFailure(
        'INVALID_PLAN',
        'New-document plan does not contain a reserved document ID.'
      );
    }
    if (context.canCreateDoc === false || !this.options.createDocument) {
      throw new RuntimeFailure(
        'PERMISSION_DENIED',
        'The current authorization cannot create documents.'
      );
    }
    const destination = plan.destination;
    const lifecycleOperationId = `provision_${hashString(
      `${this.options.workspaceId}:${docId}:${args.requestId}`
    )}`;
    let target: Awaited<
      ReturnType<NonNullable<CanvasRuntimeOptions['createDocument']>>
    >;
    let provisioningStarted = false;
    try {
      this.assertCommitReady(context);
      await this.assertTargetAuthorization(docId, true, true, context);
      this.assertCommitReady(context);
      provisioningStarted = true;
      target = await this.options.createDocument({
        workspaceId: this.options.workspaceId,
        docId,
        title: destination.title,
        operationId: lifecycleOperationId,
        signal: context.signal,
        deadline: context.deadline,
      });
      this.assertCommitReady(context);
      const targetAuthorization = await this.assertTargetAuthorization(
        docId,
        false,
        true,
        context
      );
      this.assertCommitReady(context);
      context = {
        ...context,
        canWrite: targetAuthorization.canWrite,
        canCreateDoc: targetAuthorization.canCreateDoc,
      };
    } catch (error) {
      if (!provisioningStarted && error instanceof RuntimeFailure) throw error;
      throw new RuntimeFailure(
        'PARTIAL_APPLICATION',
        error instanceof Error
          ? error.message
          : 'New canvas document provisioning was interrupted.',
        {
          mutationState: 'partial',
          recoverableAction:
            'Retry the same requestId to resume the reserved document.',
        }
      );
    }
    const child = new CanvasRuntime({
      ...this.options,
      host: target.host,
      docId,
      createDocument: undefined,
    });
    try {
      const targetPlan: CanvasPlan = {
        ...plan,
        destination: { type: 'existing', documentId: docId },
        baseContentRevision: child.getContentRevision(),
      };
      child.storePlan(targetPlan, native, context);
      const receipt = await child.apply(args, context);
      const committed = child.readJournal(receipt.operationId);
      if (!committed) {
        throw new RuntimeFailure(
          'PARTIAL_APPLICATION',
          'The target document committed without a recoverable operation record.',
          { mutationState: 'partial' }
        );
      }
      const sourceReceipt: CanvasReceipt = {
        ...receipt,
        destination: plan.destination,
      };
      this.assertCommitReady(context);
      this.writeJournal(receipt.operationId, {
        ...committed,
        receipt: sourceReceipt,
        targetDocumentId: docId,
        targetDocumentTitle: destination.title,
        lifecycleOperationId,
      });
      if (this.options.persist) {
        try {
          await this.options.persist({
            workspaceId: this.options.workspaceId,
            docId: this.options.docId,
            operationId: receipt.operationId,
            contentRevision: this.getContentRevision(),
            signal: context.signal,
          });
        } catch {
          // The target receipt remains durable in its document; a retry with
          // the same requestId can recover it through the source journal.
        }
      }
      return sourceReceipt;
    } finally {
      child.dispose();
      target.dispose?.();
    }
  }

  private async operationInDocument(
    stored: StoredOperation,
    args: CanvasOperationArgs,
    context: CanvasRuntimeExecutionContext
  ): Promise<CanvasReceipt> {
    const docId = stored.targetDocumentId;
    if (!docId || !this.options.createDocument) {
      throw new RuntimeFailure(
        'EDITOR_UNAVAILABLE',
        'The target canvas document cannot be reopened for this operation.'
      );
    }
    const targetAuthorization = await this.assertTargetAuthorization(
      docId,
      false,
      args.action !== 'status',
      context
    );
    deadlineIfNeeded(context.deadline);
    const target = await this.options.createDocument({
      workspaceId: this.options.workspaceId,
      docId,
      title: stored.targetDocumentTitle ?? 'Canvas',
      operationId:
        stored.lifecycleOperationId ??
        `provision_${hashString(
          `${this.options.workspaceId}:${docId}:${stored.receipt.requestId}`
        )}`,
      signal: context.signal,
      deadline: context.deadline,
    });
    const child = new CanvasRuntime({
      ...this.options,
      host: target.host,
      docId,
      createDocument: undefined,
    });
    try {
      const result: CanvasReceipt = await child.operation(args, {
        ...context,
        canWrite: targetAuthorization.canWrite,
        canCreateDoc: targetAuthorization.canCreateDoc,
      });
      const sourceResult: CanvasReceipt = {
        ...result,
        destination: stored.receipt.destination ?? result.destination,
      };
      if (args.requestId) {
        const mirrored = child.readJournalByRequestId(args.requestId);
        if (mirrored) {
          this.assertCommitReady(context);
          this.writeJournal(mirrored.receipt.operationId, {
            ...mirrored,
            receipt: {
              ...mirrored.receipt,
              destination: sourceResult.destination,
            },
            targetDocumentId: docId,
            targetDocumentTitle: stored.targetDocumentTitle,
            lifecycleOperationId: stored.lifecycleOperationId,
          });
        }
      }
      return sourceResult;
    } finally {
      child.dispose();
      target.dispose?.();
    }
  }

  private async preflight(plan: CanvasPlan, signal?: AbortSignal) {
    const hostWithStd = this.options.host as EditorHost & {
      std?: EditorHost['std'];
    };
    if (hostWithStd.std) {
      try {
        abortIfNeeded(signal);
        await hostWithStd.std.get(FontLoaderService).ready;
        abortIfNeeded(signal);
      } catch {
        throw new RuntimeFailure(
          'FONT_UNAVAILABLE',
          'Native canvas fonts are not ready.'
        );
      }
    }
    for (const operation of plan.operations) {
      const props =
        operation.type === 'create'
          ? operation.node.props
          : operation.type === 'update'
            ? operation.patch.props
            : undefined;
      const fontFamily = props?.fontFamily;
      if (
        typeof fontFamily === 'string' &&
        !NATIVE_FONT_FAMILIES.has(fontFamily)
      ) {
        throw new RuntimeFailure(
          'FONT_UNAVAILABLE',
          `Font ${fontFamily} is not registered in the native canvas renderer.`
        );
      }
      const sourceId = props?.sourceId;
      if (
        operation.type === 'create' &&
        operation.node.kind.startsWith('block:') &&
        ['block:affine:image', 'block:affine:attachment'].includes(
          operation.node.kind
        ) &&
        typeof sourceId !== 'string'
      ) {
        throw new RuntimeFailure(
          'ASSET_MISSING',
          `${operation.node.kind} requires a persistent sourceId.`
        );
      }
      if (
        operation.type === 'create' &&
        operation.node.kind.startsWith('block:') &&
        'blobSync' in this.options.host.store
      ) {
        const prepared = await prepareNativeBlockAssets(operation.node, {
          hasBlob: async id =>
            !!(await this.options.host.store.blobSync.get(id)),
        });
        if (!prepared.ok) {
          throw new RuntimeFailure('ASSET_MISSING', prepared.errors.join(' '), {
            affectedIds: [operation.node.id],
          });
        }
      }
    }
  }

  private assertDestination(
    destination: CanvasToolArgsMap['canvas_read']['destination'],
    context?: CanvasRuntimeExecutionContext
  ) {
    if (destination.type === 'new_document') {
      if (context?.canCreateDoc === false) {
        throw new RuntimeFailure(
          'PERMISSION_DENIED',
          'The current authorization cannot create documents.'
        );
      }
      throw new RuntimeFailure(
        'UNSUPPORTED_CAPABILITY',
        'New-document lifecycle is not available in the live editor runtime.'
      );
    }
    if (destination.documentId !== this.options.docId) {
      throw new RuntimeFailure(
        'EDITOR_UNAVAILABLE',
        'Canvas destination does not match the bound live editor.'
      );
    }
  }

  private canWrite(context: CanvasRuntimeExecutionContext) {
    return (
      context.canWrite !== false && !this.options.host.store.readonly$.value
    );
  }

  private assertWrite(context: CanvasRuntimeExecutionContext) {
    if (!this.canWrite(context)) {
      throw new RuntimeFailure(
        'PERMISSION_DENIED',
        'The active document is readonly or canvas writes are disabled.'
      );
    }
  }

  private async assertTargetAuthorization(
    docId: string,
    create: boolean,
    write: boolean,
    context: CanvasRuntimeExecutionContext
  ) {
    abortIfNeeded(context.signal);
    deadlineIfNeeded(context.deadline);
    const authorization = this.options.authorizeTarget
      ? await this.options.authorizeTarget({
          docId,
          create,
          signal: context.signal,
        })
      : {
          canRead: true,
          canWrite: context.canWrite !== false,
          canCreateDoc: context.canCreateDoc !== false,
        };
    abortIfNeeded(context.signal);
    deadlineIfNeeded(context.deadline);
    if (
      !authorization.canRead ||
      (write && !authorization.canWrite) ||
      (create && !authorization.canCreateDoc)
    ) {
      throw new RuntimeFailure(
        'PERMISSION_DENIED',
        create
          ? 'The current authorization cannot create the target canvas document.'
          : write
            ? 'The current authorization cannot modify the target canvas document.'
            : 'The current authorization cannot read the target canvas document.'
      );
    }
    return authorization;
  }

  private assertCommitReady(context: CanvasRuntimeExecutionContext) {
    abortIfNeeded(context.signal);
    deadlineIfNeeded(context.deadline);
    this.assertWrite(context);
  }

  private get journal() {
    return this.options.host.store.spaceDoc.getMap<string>(JOURNAL_KEY);
  }

  private get preparedPlans() {
    return this.options.host.store.spaceDoc.getMap<string>(PREPARED_PLAN_KEY);
  }

  private readJournal(operationId: string): StoredOperation | undefined {
    const value = this.journal.get(operationId);
    if (!value) return undefined;
    try {
      const parsed = JSON.parse(value) as Partial<StoredOperation>;
      return parsed.receipt && parsed.digest && parsed.changes
        ? (parsed as StoredOperation)
        : undefined;
    } catch {
      return undefined;
    }
  }

  private readJournalByRequestId(requestId: string) {
    for (const value of this.journal.values()) {
      try {
        const parsed = JSON.parse(value) as Partial<StoredOperation> & {
          requestId?: string;
        };
        if (
          (parsed.receipt?.requestId === requestId ||
            parsed.requestId === requestId) &&
          parsed.receipt &&
          parsed.digest &&
          parsed.changes
        ) {
          return parsed as StoredOperation;
        }
      } catch {
        // Ignore corrupt entries; they cannot prove that a commit completed.
      }
    }
    return undefined;
  }

  private hasIncompleteRequest(requestId: string) {
    for (const value of this.journal.values()) {
      try {
        const parsed = JSON.parse(value) as {
          requestId?: string;
          receipt?: unknown;
          phase?: string;
        };
        if (
          parsed.requestId === requestId &&
          parsed.phase === 'applying' &&
          !parsed.receipt
        ) {
          return true;
        }
      } catch {
        // Corrupt unrelated entries do not identify this request.
      }
    }
    return false;
  }

  private readJournalChildren(parentOperationId: string) {
    const children: StoredOperation[] = [];
    for (const operationId of this.journal.keys()) {
      const stored = this.readJournal(operationId);
      if (stored?.receipt.parentOperationId === parentOperationId)
        children.push(stored);
    }
    return children.sort(
      (a, b) =>
        (a.ordinal ?? Number.MAX_SAFE_INTEGER) -
        (b.ordinal ?? Number.MAX_SAFE_INTEGER)
    );
  }

  private findLatestReversion(originalOperationId: string) {
    let latest: StoredOperation | undefined;
    for (const operationId of this.journal.keys()) {
      const stored = this.readJournal(operationId);
      if (stored?.originalOperationId !== originalOperationId) continue;
      if (!latest || (stored.ordinal ?? -1) > (latest.ordinal ?? -1))
        latest = stored;
    }
    return latest;
  }

  private isRepairPlan(plan: CanvasPlan, siblings: readonly StoredOperation[]) {
    if (!siblings.length) return false;
    const priorTouched = new Set(
      siblings.flatMap(operation => [
        ...operation.receipt.createdIds,
        ...operation.receipt.updatedIds,
      ])
    );
    for (const operation of plan.operations) {
      if (operation.type === 'create') continue;
      const candidates = new Set<string>();
      if (operation.target.id) candidates.add(operation.target.id);
      if (operation.target.ref) {
        for (const sibling of siblings) {
          const resolved = sibling.receipt.idMap[operation.target.ref];
          if (resolved) candidates.add(resolved);
        }
      }
      if ([...candidates].some(id => priorTouched.has(id))) return true;
    }
    return false;
  }

  private writeJournal(operationId: string, stored: StoredOperation) {
    this.options.host.store.spaceDoc.transact(() => {
      this.journal.set(operationId, JSON.stringify(stored));
    }, this.options.host.store.spaceDoc.clientID);
  }

  private aggregateReceipts(
    parentOperationId: string,
    children: readonly CanvasReceipt[]
  ): CanvasReceipt {
    const first = children[0];
    const last = children.at(-1);
    if (!first || !last) {
      throw new RuntimeFailure(
        'INVALID_PLAN',
        `Canvas operation ${parentOperationId} does not have child receipts.`
      );
    }
    return {
      ...last,
      operationId: parentOperationId,
      parentOperationId: undefined,
      beforeRevision: first.beforeRevision,
      afterRevision: last.afterRevision,
      contentRevision: this.getContentRevision(),
      createdIds: [...new Set(children.flatMap(receipt => receipt.createdIds))],
      updatedIds: [...new Set(children.flatMap(receipt => receipt.updatedIds))],
      deletedIds: [...new Set(children.flatMap(receipt => receipt.deletedIds))],
      idMap: Object.assign({}, ...children.map(receipt => receipt.idMap)),
      warnings: children.flatMap(receipt => receipt.warnings),
      execution: children.some(receipt => receipt.execution === 'partial')
        ? 'partial'
        : last.execution,
      verification: children.some(
        receipt => receipt.verification === 'needs_attention'
      )
        ? 'needs_attention'
        : last.verification,
    };
  }

  private async persistReceipt(
    operationId: string,
    digest: string,
    receipt: CanvasReceipt,
    changes: readonly StoredChange[],
    context: CanvasRuntimeExecutionContext,
    originalOperationId?: string,
    extra?: Pick<StoredOperation, 'nativeImport' | 'nativeCreated'>
  ) {
    let persistence = receipt.persistence;
    if (this.options.persist) {
      try {
        persistence =
          (await this.options.persist({
            workspaceId: this.options.workspaceId,
            docId: this.options.docId,
            operationId,
            contentRevision: receipt.contentRevision,
            signal: context.signal,
          })) ?? 'local_durable';
      } catch {
        persistence = 'sync_pending';
      }
    }
    const persisted = {
      ...receipt,
      persistence,
      contentRevision: this.getContentRevision(),
    };
    this.assertCommitReady(context);
    this.writeJournal(operationId, {
      digest,
      receipt: persisted,
      changes,
      originalOperationId,
      ...extra,
    });
    return persisted;
  }

  private async artifact(
    blob: Blob,
    fileName: string,
    mimeType: string,
    signal?: AbortSignal
  ) {
    abortIfNeeded(signal);
    const checksum = await canvasChecksum(
      new Uint8Array(await blob.arrayBuffer())
    );
    if (this.options.createArtifact) {
      const stored = await this.options.createArtifact({
        workspaceId: this.options.workspaceId,
        docId: this.options.docId,
        blob,
        fileName,
        mimeType,
        signal,
      });
      return {
        url: stored.url,
        checksum,
        mimeType: stored.mimeType ?? mimeType,
        ...(stored.handle ? { handle: stored.handle } : {}),
        ...(stored.fileName ? { fileName: stored.fileName } : { fileName }),
      };
    }
    const url = URL.createObjectURL(blob);
    this.objectUrls.add(url);
    return { url, mimeType, fileName, checksum };
  }

  private async resolveNativeArtifact(
    content: JsonObject,
    signal?: AbortSignal
  ) {
    const handle = content.handle;
    if (
      typeof handle !== 'string' ||
      !handle ||
      !this.options.resolveArtifact
    ) {
      throw new RuntimeFailure(
        'INVALID_PLAN',
        'Native artifact import requires a valid authenticated artifact handle.'
      );
    }
    try {
      abortIfNeeded(signal);
      const blob = await this.options.resolveArtifact({ handle, signal });
      abortIfNeeded(signal);
      return blob;
    } catch (error) {
      if (error instanceof RuntimeFailure) throw error;
      throw new RuntimeFailure(
        'ASSET_MISSING',
        error instanceof Error
          ? error.message
          : 'The native canvas artifact could not be resolved.'
      );
    }
  }
}
