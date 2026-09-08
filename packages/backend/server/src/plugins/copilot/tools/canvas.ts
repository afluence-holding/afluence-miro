import {
  CANVAS_MAX_LAYOUT_OBJECTS,
  validateCanvasToolArgs,
} from '@affine/realtime/canvas';
import { z } from 'zod';

import type { PermissionAccess } from '../../../core/permission';
import type { DelegatedEditorService } from '../delegated/service';
import type { CopilotChatOptions } from '../providers/types';
import { type CopilotToolExecuteOptions, defineTool } from './tool';

/**
 * The server validates the public transport envelope and typed initial node
 * subset. The editor remains authoritative for its versioned native-adapter
 * registry and verifies the complete model before it can mutate BlockSuite.
 */
const finite = z.number().finite().min(-10_000_000).max(10_000_000);
const id = z.string().trim().min(1).max(128);
const revision = z.string().trim().min(1).max(512);
const bounds = z
  .object({
    x: finite,
    y: finite,
    w: finite.positive(),
    h: finite.positive(),
  })
  .strict();
const objectIds = z
  .array(id)
  .min(1)
  .max(200)
  .describe(
    'Exact node IDs returned by canvas_read or an operation receipt. There is no wildcard: never use "*" or "all". Omit ids to address all nodes.'
  );
const canvasScope = z
  .object({
    ids: objectIds.optional(),
    bounds: bounds.optional(),
    includeIncidentConnectors: z.boolean().optional(),
    includeAutoResizeContainers: z.boolean().optional(),
  })
  .strict()
  .describe(
    'Use {} for the whole canvas. To narrow the scope, use exact node ids or world-coordinate bounds. If both are provided their intersection is selected. Omit unused fields; never invent wildcard IDs.'
  );
const destination = z.discriminatedUnion('type', [
  z.object({ type: z.literal('existing'), documentId: id }).strict(),
  z
    .object({
      type: z.literal('new_document'),
      workspaceId: id,
      title: z.string().trim().min(1).max(512),
      reservedDocumentId: id.optional(),
    })
    .strict(),
]);
const nodeReference = z
  .object({ id: id.optional(), ref: id.optional() })
  .strict()
  .refine(
    value => Boolean(value.id) || Boolean(value.ref),
    'id or ref is required'
  );
const node = z
  .object({
    id,
    ref: id.optional(),
    kind: z.union([
      z.enum([
        'shape',
        'text',
        'brush',
        'highlighter',
        'note',
        'frame',
        'group',
        'connector',
        'mindmap',
      ]),
      z.string().regex(/^block:[^\s]{1,120}$/),
    ]),
    bounds,
    props: z.record(z.string(), z.unknown()),
    parentId: id.optional(),
    sourceId: id.optional(),
    targetId: id.optional(),
    layout: z.enum(['auto', 'fixed', 'preserve']).optional(),
    design: z
      .object({
        role: z
          .enum(['title', 'section', 'body', 'metadata', 'decision'])
          .optional(),
        order: finite.optional(),
        lane: id.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const operation = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create'), node }).strict(),
  z
    .object({
      type: z.literal('update'),
      target: nodeReference,
      patch: z
        .object({
          bounds: bounds.optional(),
          props: z.record(z.string(), z.unknown()).optional(),
          parentId: id.optional(),
          sourceId: id.optional(),
          targetId: id.optional(),
          layout: z.enum(['auto', 'fixed', 'preserve']).optional(),
        })
        .strict()
        .refine(
          value => Object.keys(value).length > 0,
          'patch must not be empty'
        ),
    })
    .strict(),
  z.object({ type: z.literal('delete'), target: nodeReference }).strict(),
]);
const layoutOptions = z
  .object({
    mode: z.enum(['flow', 'row', 'column', 'grid']),
    grammar: z
      .enum([
        'flow',
        'architecture',
        'workshop',
        'mindmap',
        'timeline',
        'matrix',
        'board',
        'presentation',
      ])
      .optional(),
    density: z.enum(['compact', 'normal', 'ample']).optional(),
    direction: z.enum(['left-to-right', 'top-to-bottom']).optional(),
    siblingGap: finite.nonnegative().optional(),
    levelGap: finite.nonnegative().optional(),
    columns: z.number().int().min(1).max(100).optional(),
    origin: z.object({ x: finite, y: finite }).strict().optional(),
  })
  .strict();

export const CanvasToolNameSchema = z.enum([
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
export type CanvasToolName = z.infer<typeof CanvasToolNameSchema>;

export const CanvasToolSchemas = {
  canvas_capabilities: z.object({ destination }).strict(),
  canvas_read: z
    .object({
      destination,
      scope: canvasScope,
      fields: z.array(z.string().min(1).max(128)).min(1).max(30).optional(),
      cursor: z
        .string()
        .min(1)
        .max(4096)
        .optional()
        .describe(
          'Omit on the first read. For pagination, pass only the exact nextCursor returned by canvas_read; never invent an offset or cursor.'
        ),
      limit: z.number().int().min(1).max(200).optional(),
    })
    .strict(),
  canvas_validate: z
    .object({
      destination,
      baseContentRevision: revision,
      requestedScope: canvasScope,
      operations: z.array(operation).min(1).max(100),
      taskId: id.optional(),
      parentOperationId: id.optional(),
    })
    .strict(),
  canvas_layout: z
    .object({
      destination,
      baseContentRevision: revision,
      requestedScope: canvasScope,
      nodes: z.array(node).min(1).max(CANVAS_MAX_LAYOUT_OBJECTS),
      options: layoutOptions,
      taskId: id.optional(),
      parentOperationId: id.optional(),
    })
    .strict(),
  canvas_render: z
    .object({
      destination,
      scope: canvasScope.optional(),
      planId: id
        .optional()
        .describe(
          'Only for previewing an unapplied plan. Omit after canvas_apply to render the live canvas using scope instead.'
        ),
      contentRevision: revision.optional(),
      scale: z.number().finite().min(0.1).max(4).optional(),
    })
    .strict()
    .refine(
      value => Boolean(value.scope) || Boolean(value.planId),
      'scope or planId is required'
    ),
  canvas_apply: z
    .object({
      planId: id,
      requestId: id,
    })
    .strict(),
  canvas_operation: z
    .object({
      action: z.enum(['status', 'cancel', 'revert', 'redo', 'resume']),
      operationId: id.optional(),
      requestId: id.optional(),
    })
    .strict()
    .refine(
      value => Boolean(value.operationId) || Boolean(value.requestId),
      'operationId or requestId is required'
    ),
  canvas_focus: z
    .object({
      destination,
      scope: canvasScope,
      mode: z.enum(['view', 'select']).optional(),
    })
    .strict(),
  canvas_import: z
    .object({
      destination,
      format: z.enum([
        'native',
        'asset',
        'recipe',
        'excalidraw',
        'mermaid',
        'markdown',
        'freemind',
        'opml',
        'png',
        'svg',
        'pdf',
      ]),
      content: z.unknown(),
      requestedScope: canvasScope.optional(),
      placement: bounds.optional(),
      taskId: id.optional(),
      parentOperationId: id.optional(),
    })
    .strict(),
  canvas_export: z
    .object({
      destination,
      scope: canvasScope,
      format: z.enum([
        'native',
        'asset',
        'recipe',
        'excalidraw',
        'mermaid',
        'markdown',
        'freemind',
        'opml',
        'png',
        'svg',
        'pdf',
      ]),
      includeAssets: z.boolean().optional(),
    })
    .strict(),
} as const;

type CanvasPermission = 'Doc.Read' | 'Doc.Update';

function permissionFor(
  tool: CanvasToolName,
  args: Record<string, unknown>
): CanvasPermission {
  if (
    tool === 'canvas_apply' ||
    tool === 'canvas_import' ||
    (tool === 'canvas_operation' &&
      ['cancel', 'revert', 'redo', 'resume'].includes(String(args.action)))
  ) {
    return 'Doc.Update';
  }
  return 'Doc.Read';
}

function unavailable() {
  return {
    error: {
      code: 'EDITOR_UNAVAILABLE',
      message:
        'No focused editor with canvas tools is available for this session.',
      retryable: true,
    },
  };
}

function denied(permission: CanvasPermission) {
  return {
    error: {
      code: 'PERMISSION_DENIED',
      message: `Document permission ${permission} is required for this canvas operation.`,
      retryable: false,
    },
  };
}

function destinationMatchesLease(
  args: Record<string, unknown>,
  docId: string,
  workspaceId: string
) {
  const value = args.destination;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
  const destination = value as Record<string, unknown>;
  if (destination.type === 'existing') return destination.documentId === docId;
  if (destination.type === 'new_document')
    return destination.workspaceId === workspaceId;
  return false;
}

function executeCanvas(
  ac: PermissionAccess,
  delegated: DelegatedEditorService,
  options: CopilotChatOptions,
  tool: CanvasToolName
) {
  return async (
    args: Record<string, unknown>,
    execution: CopilotToolExecuteOptions
  ) => {
    if (!options?.user || !options.workspace) {
      return {
        error: {
          code: 'INVALID_CONTEXT',
          message: 'A workspace and user are required for canvas tools.',
          retryable: false,
        },
      };
    }
    const validated = validateCanvasToolArgs(tool, args);
    if (!validated.ok) return { ok: false, error: validated.error };
    const canonicalArgs = validated.value as unknown as Record<string, unknown>;
    const lease = delegated.getLease(options, 'frontend_canvas' as never);
    if (!lease) return unavailable();
    if (
      !destinationMatchesLease(canonicalArgs, lease.docId, lease.workspaceId)
    ) {
      return {
        error: {
          code: 'AMBIGUOUS_TARGET',
          message:
            'The requested canvas destination does not match the linked editor.',
          retryable: false,
        },
      };
    }

    // A frontend readonly flag is advisory state. Authorize every delegated
    // operation against the current server-side document permission instead.
    const permission = permissionFor(tool, canonicalArgs);
    const allowed = await ac
      .user(options.user)
      .workspace(options.workspace)
      .doc(lease.docId)
      .can(permission);
    if (!allowed) return denied(permission);

    return await delegated.execute(
      options,
      'frontend_canvas' as never,
      { tool, ...canonicalArgs },
      execution.signal,
      execution
    );
  };
}

function createTool<T extends keyof typeof CanvasToolSchemas>(
  ac: PermissionAccess,
  delegated: DelegatedEditorService,
  options: CopilotChatOptions,
  name: T,
  description: string
) {
  return defineTool({
    description,
    inputSchema: CanvasToolSchemas[name],
    execute: executeCanvas(ac, delegated, options, name),
  });
}

export function createCanvasCapabilitiesTool(
  ac: PermissionAccess,
  delegated: DelegatedEditorService,
  options: CopilotChatOptions
) {
  return createTool(
    ac,
    delegated,
    options,
    'canvas_capabilities',
    'Read the versioned capability manifest of the linked live canvas. Use it before relying on an element type, format, layout, rendering, or operation. It never changes the document.'
  );
}
export function createCanvasReadTool(
  ac: PermissionAccess,
  delegated: DelegatedEditorService,
  options: CopilotChatOptions
) {
  return createTool(
    ac,
    delegated,
    options,
    'canvas_read',
    'Read a bounded, revisioned canvas projection from the linked live editor before changing content. Omit cursor on the first read; paginate only with a returned nextCursor. Request the fields and scope needed, including nearby objects when checking spacing.'
  );
}
export function createCanvasValidateTool(
  ac: PermissionAccess,
  delegated: DelegatedEditorService,
  options: CopilotChatOptions
) {
  return createTool(
    ac,
    delegated,
    options,
    'canvas_validate',
    'Compile and validate a native canvas recipe against the linked document revision. Returns an immutable plan or actionable diagnostics and never writes.'
  );
}
export function createCanvasLayoutTool(
  ac: PermissionAccess,
  delegated: DelegatedEditorService,
  options: CopilotChatOptions
) {
  return createTool(
    ac,
    delegated,
    options,
    'canvas_layout',
    'Prepare a revision-bound layout plan with explicit canvas-unit anchors, gaps, obstacles, and constraints. It does not move objects until canvas_apply.'
  );
}
export function createCanvasRenderTool(
  ac: PermissionAccess,
  delegated: DelegatedEditorService,
  options: CopilotChatOptions
) {
  return createTool(
    ac,
    delegated,
    options,
    'canvas_render',
    'Render the current live canvas with destination and scope, omitting planId. To preview an unapplied plan, use planId instead. After canvas_apply the old preview is stale: render the live scope without planId. Report only pixels and revision metadata actually returned.'
  );
}
export function createCanvasApplyTool(
  ac: PermissionAccess,
  delegated: DelegatedEditorService,
  options: CopilotChatOptions
) {
  return createTool(
    ac,
    delegated,
    options,
    'canvas_apply',
    'Apply exactly one previously validated canvas plan using an idempotent request id. Returns a real operation receipt; do not claim success without it.'
  );
}
export function createCanvasOperationTool(
  ac: PermissionAccess,
  delegated: DelegatedEditorService,
  options: CopilotChatOptions
) {
  return createTool(
    ac,
    delegated,
    options,
    'canvas_operation',
    'Read an operation status or cancel, revert, redo, or resume a named canvas operation. Mutating actions require document update permission and preserve unrelated human work.'
  );
}
export function createCanvasFocusTool(
  ac: PermissionAccess,
  delegated: DelegatedEditorService,
  options: CopilotChatOptions
) {
  return createTool(
    ac,
    delegated,
    options,
    'canvas_focus',
    'Focus or select an explicit canvas scope in the linked editor. It only changes the viewport or selection, never document content.'
  );
}
export function createCanvasImportTool(
  ac: PermissionAccess,
  delegated: DelegatedEditorService,
  options: CopilotChatOptions
) {
  return createTool(
    ac,
    delegated,
    options,
    'canvas_import',
    'Prepare a revision-bound import plan. For an authenticated artifact, pass content exactly as { kind: "artifact_handle", handle: "<returned handle>" }; recipe and supported text/JSON formats may use inline content. Consult canvas_capabilities for supported formats and inspect fidelity before canvas_apply inserts content.'
  );
}
export function createCanvasExportTool(
  ac: PermissionAccess,
  delegated: DelegatedEditorService,
  options: CopilotChatOptions
) {
  return createTool(
    ac,
    delegated,
    options,
    'canvas_export',
    'Export an explicit canvas scope in a format declared by canvas_capabilities. Inspect fidelity/losses, revision, and checksum. When artifact.handle is returned, re-import it only as content { kind: "artifact_handle", handle: artifact.handle }, never as a URL or copied bytes.'
  );
}
