import {
  CANVAS_CONTRACT_VERSION,
  CANVAS_MAX_LAYOUT_OBJECTS,
  CANVAS_MAX_READ_OBJECTS,
  CANVAS_MAX_WRITE_BATCH,
  type CanvasBounds,
  type CanvasDiagnostic,
  type CanvasError,
  type CanvasErrorCode,
  type CanvasJsonValue,
  type CanvasLayoutOptions,
  type CanvasNode,
  type CanvasNodeReference,
  type CanvasOperation,
  type CanvasPlan,
  type CanvasScope,
  type CanvasToolArgsMap,
  type CanvasToolName,
} from './types';

const INVALID_PLAN = 'INVALID_PLAN' as const;
const MAX_ID_LENGTH = 512;
const MAX_JSON_DEPTH = 32;

export type CanvasValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: CanvasError };

export class CanvasValidationError extends Error {
  readonly code: CanvasErrorCode = INVALID_PLAN;
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = 'CanvasValidationError';
    this.path = path;
  }
}

function fail(path: string, message: string): never {
  throw new CanvasValidationError(path, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(path, 'Debe ser un objeto.');
  return value;
}

function keys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      fail(`${path}.${key}`, 'Propiedad desconocida.');
  }
}

function string(value: unknown, path: string, allowEmpty = false): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.trim().length === 0) ||
    value.length > MAX_ID_LENGTH
  ) {
    fail(path, 'Debe ser una cadena no vacía dentro del límite.');
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : string(value, path);
}

function finite(value: unknown, path: string, positive = false): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (positive && value <= 0)
  ) {
    fail(
      path,
      positive
        ? 'Debe ser un número finito positivo.'
        : 'Debe ser un número finito.'
    );
  }
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'Debe ser booleano.');
  return value;
}

function literal<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(path, `Debe ser uno de: ${allowed.join(', ')}.`);
  }
  return value as T;
}

function json(value: unknown, path: string, depth = 0): void {
  if (depth > MAX_JSON_DEPTH)
    fail(path, 'El valor JSON excede la profundidad máxima.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return;
  if (typeof value === 'number') {
    finite(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => json(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value))
      json(child, `${path}.${key}`, depth + 1);
    return;
  }
  fail(path, 'Debe ser JSON serializable.');
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, 'Debe ser una lista.');
  return value;
}

export function parseCanvasBounds(
  value: unknown,
  path = 'bounds'
): CanvasBounds {
  const input = object(value, path);
  keys(input, ['x', 'y', 'w', 'h'], path);
  return {
    x: finite(input.x, `${path}.x`),
    y: finite(input.y, `${path}.y`),
    w: finite(input.w, `${path}.w`, true),
    h: finite(input.h, `${path}.h`, true),
  };
}

export function parseCanvasScope(value: unknown, path = 'scope'): CanvasScope {
  const input = object(value, path);
  keys(
    input,
    [
      'ids',
      'bounds',
      'includeIncidentConnectors',
      'includeAutoResizeContainers',
    ],
    path
  );
  const ids =
    input.ids === undefined
      ? undefined
      : array(input.ids, `${path}.ids`).map((id, index) =>
          string(id, `${path}.ids[${index}]`)
        );
  if (ids && new Set(ids).size !== ids.length)
    fail(`${path}.ids`, 'No puede contener IDs duplicados.');
  const result: CanvasScope = {
    ...(ids ? { ids } : {}),
    ...(input.bounds === undefined
      ? {}
      : { bounds: parseCanvasBounds(input.bounds, `${path}.bounds`) }),
    ...(input.includeIncidentConnectors === undefined
      ? {}
      : {
          includeIncidentConnectors: boolean(
            input.includeIncidentConnectors,
            `${path}.includeIncidentConnectors`
          ),
        }),
    ...(input.includeAutoResizeContainers === undefined
      ? {}
      : {
          includeAutoResizeContainers: boolean(
            input.includeAutoResizeContainers,
            `${path}.includeAutoResizeContainers`
          ),
        }),
  };
  if (!result.ids && !result.bounds)
    fail(path, 'Debe identificar IDs, bounds, o ambos.');
  return result;
}

export function parseCanvasNodeReference(
  value: unknown,
  path = 'target'
): CanvasNodeReference {
  const input = object(value, path);
  keys(input, ['id', 'ref'], path);
  const id = optionalString(input.id, `${path}.id`);
  const ref = optionalString(input.ref, `${path}.ref`);
  if (
    (id === undefined && ref === undefined) ||
    (id !== undefined && ref !== undefined)
  ) {
    fail(path, 'Debe contener exactamente uno de id o ref.');
  }
  return {
    ...(id === undefined ? {} : { id }),
    ...(ref === undefined ? {} : { ref }),
  };
}

export function parseCanvasNode(value: unknown, path = 'node'): CanvasNode {
  const input = object(value, path);
  keys(
    input,
    [
      'id',
      'ref',
      'kind',
      'bounds',
      'props',
      'parentId',
      'sourceId',
      'targetId',
      'layout',
      'design',
    ],
    path
  );
  const id = string(input.id, `${path}.id`);
  const ref = optionalString(input.ref, `${path}.ref`);
  const kind = string(input.kind, `${path}.kind`) as CanvasNode['kind'];
  const builtIn = [
    'shape',
    'text',
    'brush',
    'highlighter',
    'note',
    'frame',
    'group',
    'connector',
    'mindmap',
  ];
  if (!builtIn.includes(kind) && !kind.startsWith('block:')) {
    fail(`${path}.kind`, 'Tipo de nodo no admitido por el contrato.');
  }
  const props = object(input.props, `${path}.props`);
  json(props, `${path}.props`);
  const design =
    input.design === undefined
      ? undefined
      : object(input.design, `${path}.design`);
  if (design) keys(design, ['role', 'order', 'lane'], `${path}.design`);
  const sourceId = optionalString(input.sourceId, `${path}.sourceId`);
  const targetId = optionalString(input.targetId, `${path}.targetId`);
  if (
    kind === 'connector' &&
    (sourceId === undefined || targetId === undefined)
  ) {
    fail(path, 'Un connector requiere sourceId y targetId.');
  }
  if (
    kind !== 'connector' &&
    (sourceId !== undefined || targetId !== undefined)
  ) {
    fail(path, 'Solo un connector puede declarar sourceId o targetId.');
  }
  return {
    id,
    ...(ref === undefined ? {} : { ref }),
    kind,
    bounds: parseCanvasBounds(input.bounds, `${path}.bounds`),
    props: props as CanvasNode['props'],
    ...(design
      ? {
          design: {
            ...(design.role === undefined
              ? {}
              : {
                  role: literal(
                    design.role,
                    [
                      'title',
                      'section',
                      'body',
                      'metadata',
                      'decision',
                    ] as const,
                    `${path}.design.role`
                  ),
                }),
            ...(design.order === undefined
              ? {}
              : { order: finite(design.order, `${path}.design.order`) }),
            ...(design.lane === undefined
              ? {}
              : { lane: string(design.lane, `${path}.design.lane`) }),
          },
        }
      : {}),
    ...(input.parentId === undefined
      ? {}
      : { parentId: string(input.parentId, `${path}.parentId`) }),
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(targetId === undefined ? {} : { targetId }),
    ...(input.layout === undefined
      ? {}
      : {
          layout: literal(
            input.layout,
            ['auto', 'fixed', 'preserve'] as const,
            `${path}.layout`
          ),
        }),
  };
}

function parseOperation(value: unknown, path: string): CanvasOperation {
  const input = object(value, path);
  const type = literal(
    input.type,
    ['create', 'update', 'delete'] as const,
    `${path}.type`
  );
  if (type === 'create') {
    keys(input, ['type', 'node'], path);
    return { type, node: parseCanvasNode(input.node, `${path}.node`) };
  }
  if (type === 'delete') {
    keys(input, ['type', 'target'], path);
    return {
      type,
      target: parseCanvasNodeReference(input.target, `${path}.target`),
    };
  }
  keys(input, ['type', 'target', 'patch'], path);
  const patch = object(input.patch, `${path}.patch`);
  keys(
    patch,
    ['bounds', 'props', 'parentId', 'sourceId', 'targetId', 'layout'],
    `${path}.patch`
  );
  if (Object.keys(patch).length === 0)
    fail(`${path}.patch`, 'Un update debe cambiar algún campo.');
  if (patch.props !== undefined)
    json(object(patch.props, `${path}.patch.props`), `${path}.patch.props`);
  return {
    type,
    target: parseCanvasNodeReference(input.target, `${path}.target`),
    patch: {
      ...(patch.bounds === undefined
        ? {}
        : { bounds: parseCanvasBounds(patch.bounds, `${path}.patch.bounds`) }),
      ...(patch.props === undefined
        ? {}
        : {
            props: object(
              patch.props,
              `${path}.patch.props`
            ) as CanvasNode['props'],
          }),
      ...(patch.parentId === undefined
        ? {}
        : { parentId: string(patch.parentId, `${path}.patch.parentId`) }),
      ...(patch.sourceId === undefined
        ? {}
        : { sourceId: string(patch.sourceId, `${path}.patch.sourceId`) }),
      ...(patch.targetId === undefined
        ? {}
        : { targetId: string(patch.targetId, `${path}.patch.targetId`) }),
      ...(patch.layout === undefined
        ? {}
        : {
            layout: literal(
              patch.layout,
              ['auto', 'fixed', 'preserve'] as const,
              `${path}.patch.layout`
            ),
          }),
    },
  };
}

function parseDestination(value: unknown, path = 'destination') {
  const input = object(value, path);
  const type = literal(
    input.type,
    ['existing', 'new_document'] as const,
    `${path}.type`
  );
  if (type === 'existing') {
    keys(input, ['type', 'documentId'], path);
    return {
      type,
      documentId: string(input.documentId, `${path}.documentId`),
    } as const;
  }
  keys(input, ['type', 'workspaceId', 'title', 'reservedDocumentId'], path);
  return {
    type,
    workspaceId: string(input.workspaceId, `${path}.workspaceId`),
    title: string(input.title, `${path}.title`),
    ...(input.reservedDocumentId === undefined
      ? {}
      : {
          reservedDocumentId: string(
            input.reservedDocumentId,
            `${path}.reservedDocumentId`
          ),
        }),
  } as const;
}

export function parseCanvasLayoutOptions(
  value: unknown,
  path = 'options'
): CanvasLayoutOptions {
  const input = object(value, path);
  keys(
    input,
    [
      'mode',
      'grammar',
      'density',
      'direction',
      'siblingGap',
      'levelGap',
      'columns',
      'origin',
    ],
    path
  );
  const columns =
    input.columns === undefined
      ? undefined
      : finite(input.columns, `${path}.columns`, true);
  if (columns !== undefined && !Number.isInteger(columns))
    fail(`${path}.columns`, 'Debe ser entero.');
  const origin =
    input.origin === undefined
      ? undefined
      : object(input.origin, `${path}.origin`);
  if (origin) keys(origin, ['x', 'y'], `${path}.origin`);
  return {
    mode: literal(
      input.mode,
      ['flow', 'row', 'column', 'grid'] as const,
      `${path}.mode`
    ),
    ...(input.grammar === undefined
      ? {}
      : {
          grammar: literal(
            input.grammar,
            [
              'flow',
              'architecture',
              'workshop',
              'mindmap',
              'timeline',
              'matrix',
              'board',
              'presentation',
            ] as const,
            `${path}.grammar`
          ),
        }),
    ...(input.density === undefined
      ? {}
      : {
          density: literal(
            input.density,
            ['compact', 'normal', 'ample'] as const,
            `${path}.density`
          ),
        }),
    ...(input.direction === undefined
      ? {}
      : {
          direction: literal(
            input.direction,
            ['left-to-right', 'top-to-bottom'] as const,
            `${path}.direction`
          ),
        }),
    ...(input.siblingGap === undefined
      ? {}
      : { siblingGap: finite(input.siblingGap, `${path}.siblingGap`, true) }),
    ...(input.levelGap === undefined
      ? {}
      : { levelGap: finite(input.levelGap, `${path}.levelGap`, true) }),
    ...(columns === undefined ? {} : { columns }),
    ...(origin === undefined
      ? {}
      : {
          origin: {
            x: finite(origin.x, `${path}.origin.x`),
            y: finite(origin.y, `${path}.origin.y`),
          },
        }),
  };
}

export function parseCanvasPlan(value: unknown, path = 'plan'): CanvasPlan {
  const input = object(value, path);
  keys(
    input,
    [
      'schemaVersion',
      'planId',
      'status',
      'baseContentRevision',
      'capabilitiesVersion',
      'requestedScope',
      'effectiveScope',
      'destination',
      'taskId',
      'parentOperationId',
      'grammar',
      'layout',
      'operations',
      'diagnostics',
      'expiresAt',
    ],
    path
  );
  if (input.schemaVersion !== CANVAS_CONTRACT_VERSION)
    fail(`${path}.schemaVersion`, 'Versión de contrato no compatible.');
  const operations = array(input.operations, `${path}.operations`).map(
    (operation, index) =>
      parseOperation(operation, `${path}.operations[${index}]`)
  );
  if (operations.length > CANVAS_MAX_WRITE_BATCH)
    fail(
      `${path}.operations`,
      `No puede superar ${CANVAS_MAX_WRITE_BATCH} operaciones por lote.`
    );
  return {
    schemaVersion: CANVAS_CONTRACT_VERSION,
    planId: string(input.planId, `${path}.planId`),
    status: literal(
      input.status,
      ['ready', 'invalid'] as const,
      `${path}.status`
    ),
    baseContentRevision: string(
      input.baseContentRevision,
      `${path}.baseContentRevision`
    ),
    capabilitiesVersion: string(
      input.capabilitiesVersion,
      `${path}.capabilitiesVersion`
    ),
    requestedScope: parseCanvasScope(
      input.requestedScope,
      `${path}.requestedScope`
    ),
    effectiveScope: parseCanvasScope(
      input.effectiveScope,
      `${path}.effectiveScope`
    ),
    destination: parseDestination(input.destination, `${path}.destination`),
    ...(input.taskId === undefined
      ? {}
      : { taskId: string(input.taskId, `${path}.taskId`) }),
    ...(input.parentOperationId === undefined
      ? {}
      : {
          parentOperationId: string(
            input.parentOperationId,
            `${path}.parentOperationId`
          ),
        }),
    ...(input.grammar === undefined
      ? {}
      : {
          grammar: literal(
            input.grammar,
            [
              'flow',
              'architecture',
              'workshop',
              'mindmap',
              'timeline',
              'matrix',
              'board',
              'presentation',
            ] as const,
            `${path}.grammar`
          ),
        }),
    ...(input.layout === undefined
      ? {}
      : { layout: parseCanvasLayoutOptions(input.layout, `${path}.layout`) }),
    operations,
    diagnostics: parseDiagnostics(input.diagnostics, `${path}.diagnostics`),
    ...(input.expiresAt === undefined
      ? {}
      : { expiresAt: string(input.expiresAt, `${path}.expiresAt`) }),
  };
}

function parseDiagnostics(
  value: unknown,
  path: string
): readonly CanvasDiagnostic[] {
  return array(value, path).map((item, index) => {
    const diagnostic = object(item, `${path}[${index}]`);
    keys(
      diagnostic,
      ['code', 'severity', 'message', 'affectedIds', 'path', 'recoverable'],
      `${path}[${index}]`
    );
    return {
      code: literal(
        diagnostic.code,
        [
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
        ] as const,
        `${path}[${index}].code`
      ),
      severity: literal(
        diagnostic.severity,
        ['error', 'warning', 'info'] as const,
        `${path}[${index}].severity`
      ),
      message: string(diagnostic.message, `${path}[${index}].message`),
      ...(diagnostic.affectedIds === undefined
        ? {}
        : {
            affectedIds: array(
              diagnostic.affectedIds,
              `${path}[${index}].affectedIds`
            ).map((id, idIndex) =>
              string(id, `${path}[${index}].affectedIds[${idIndex}]`)
            ),
          }),
      ...(diagnostic.path === undefined
        ? {}
        : { path: string(diagnostic.path, `${path}[${index}].path`) }),
      ...(diagnostic.recoverable === undefined
        ? {}
        : {
            recoverable: boolean(
              diagnostic.recoverable,
              `${path}[${index}].recoverable`
            ),
          }),
    };
  });
}

/** Parses a tool's flattened arguments. Provider transport adds `tool` itself. */
export function parseCanvasToolArgs<T extends CanvasToolName>(
  tool: T,
  value: unknown
): CanvasToolArgsMap[T] {
  const input = object(value, 'args');
  switch (tool) {
    case 'canvas_capabilities':
      keys(input, ['destination'], 'args');
      return {
        destination: parseDestination(input.destination),
      } as CanvasToolArgsMap[T];
    case 'canvas_read': {
      keys(
        input,
        ['destination', 'scope', 'fields', 'cursor', 'limit'],
        'args'
      );
      const limit =
        input.limit === undefined
          ? undefined
          : finite(input.limit, 'args.limit', true);
      if (
        limit !== undefined &&
        (!Number.isInteger(limit) || limit > CANVAS_MAX_READ_OBJECTS)
      )
        fail(
          'args.limit',
          `Debe ser un entero menor o igual a ${CANVAS_MAX_READ_OBJECTS}.`
        );
      return {
        destination: parseDestination(input.destination),
        scope: parseCanvasScope(input.scope),
        ...(input.fields === undefined
          ? {}
          : {
              fields: array(input.fields, 'args.fields').map((field, index) =>
                string(field, `args.fields[${index}]`)
              ),
            }),
        ...(input.cursor === undefined
          ? {}
          : { cursor: string(input.cursor, 'args.cursor') }),
        ...(limit === undefined ? {} : { limit }),
      } as unknown as CanvasToolArgsMap[T];
    }
    case 'canvas_validate':
      keys(
        input,
        [
          'destination',
          'baseContentRevision',
          'requestedScope',
          'operations',
          'taskId',
          'parentOperationId',
        ],
        'args'
      );
      return {
        destination: parseDestination(input.destination),
        baseContentRevision: string(
          input.baseContentRevision,
          'args.baseContentRevision'
        ),
        requestedScope: parseCanvasScope(
          input.requestedScope,
          'args.requestedScope'
        ),
        operations: parseOperations(input.operations),
        ...(input.taskId === undefined
          ? {}
          : { taskId: string(input.taskId, 'args.taskId') }),
        ...(input.parentOperationId === undefined
          ? {}
          : {
              parentOperationId: string(
                input.parentOperationId,
                'args.parentOperationId'
              ),
            }),
      } as CanvasToolArgsMap[T];
    case 'canvas_layout': {
      keys(
        input,
        [
          'destination',
          'baseContentRevision',
          'requestedScope',
          'nodes',
          'options',
          'taskId',
          'parentOperationId',
        ],
        'args'
      );
      const nodes = array(input.nodes, 'args.nodes');
      if (nodes.length > CANVAS_MAX_LAYOUT_OBJECTS)
        fail(
          'args.nodes',
          `No puede superar ${CANVAS_MAX_LAYOUT_OBJECTS} objetos para layout.`
        );
      return {
        destination: parseDestination(input.destination),
        baseContentRevision: string(
          input.baseContentRevision,
          'args.baseContentRevision'
        ),
        requestedScope: parseCanvasScope(
          input.requestedScope,
          'args.requestedScope'
        ),
        nodes: nodes.map((node, index) =>
          parseCanvasNode(node, `args.nodes[${index}]`)
        ),
        options: parseCanvasLayoutOptions(input.options),
        ...(input.taskId === undefined
          ? {}
          : { taskId: string(input.taskId, 'args.taskId') }),
        ...(input.parentOperationId === undefined
          ? {}
          : {
              parentOperationId: string(
                input.parentOperationId,
                'args.parentOperationId'
              ),
            }),
      } as unknown as CanvasToolArgsMap[T];
    }
    case 'canvas_apply':
      keys(input, ['planId', 'requestId'], 'args');
      return {
        planId: string(input.planId, 'args.planId'),
        requestId: string(input.requestId, 'args.requestId'),
      } as CanvasToolArgsMap[T];
    case 'canvas_render':
      keys(
        input,
        ['destination', 'scope', 'planId', 'contentRevision', 'scale'],
        'args'
      );
      return {
        destination: parseDestination(input.destination),
        ...(input.scope === undefined
          ? {}
          : { scope: parseCanvasScope(input.scope) }),
        ...(input.planId === undefined
          ? {}
          : { planId: string(input.planId, 'args.planId') }),
        ...(input.contentRevision === undefined
          ? {}
          : {
              contentRevision: string(
                input.contentRevision,
                'args.contentRevision'
              ),
            }),
        ...(input.scale === undefined
          ? {}
          : { scale: finite(input.scale, 'args.scale', true) }),
      } as CanvasToolArgsMap[T];
    case 'canvas_operation':
      keys(input, ['operationId', 'action', 'requestId'], 'args');
      if (input.operationId === undefined && input.requestId === undefined)
        fail('args', 'Debe contener operationId o requestId.');
      return {
        ...(input.operationId === undefined
          ? {}
          : { operationId: string(input.operationId, 'args.operationId') }),
        action: literal(
          input.action,
          ['status', 'cancel', 'revert', 'redo', 'resume'] as const,
          'args.action'
        ),
        ...(input.requestId === undefined
          ? {}
          : { requestId: string(input.requestId, 'args.requestId') }),
      } as CanvasToolArgsMap[T];
    case 'canvas_focus':
      keys(input, ['destination', 'scope', 'mode'], 'args');
      return {
        destination: parseDestination(input.destination),
        scope: parseCanvasScope(input.scope),
        ...(input.mode === undefined
          ? {}
          : {
              mode: literal(
                input.mode,
                ['view', 'select'] as const,
                'args.mode'
              ),
            }),
      } as CanvasToolArgsMap[T];
    case 'canvas_import':
      keys(
        input,
        [
          'destination',
          'format',
          'content',
          'requestedScope',
          'placement',
          'taskId',
          'parentOperationId',
        ],
        'args'
      );
      json(input.content, 'args.content');
      return {
        destination: parseDestination(input.destination),
        format: literal(
          input.format,
          [
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
          ] as const,
          'args.format'
        ),
        content: input.content as CanvasJsonValue,
        ...(input.requestedScope === undefined
          ? {}
          : {
              requestedScope: parseCanvasScope(
                input.requestedScope,
                'args.requestedScope'
              ),
            }),
        ...(input.placement === undefined
          ? {}
          : {
              placement: parseCanvasBounds(input.placement, 'args.placement'),
            }),
        ...(input.taskId === undefined
          ? {}
          : { taskId: string(input.taskId, 'args.taskId') }),
        ...(input.parentOperationId === undefined
          ? {}
          : {
              parentOperationId: string(
                input.parentOperationId,
                'args.parentOperationId'
              ),
            }),
      } as CanvasToolArgsMap[T];
    case 'canvas_export':
      keys(input, ['destination', 'scope', 'format', 'includeAssets'], 'args');
      return {
        destination: parseDestination(input.destination),
        scope: parseCanvasScope(input.scope),
        format: literal(
          input.format,
          [
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
          ] as const,
          'args.format'
        ),
        ...(input.includeAssets === undefined
          ? {}
          : {
              includeAssets: boolean(input.includeAssets, 'args.includeAssets'),
            }),
      } as CanvasToolArgsMap[T];
  }
  fail('tool', 'Herramienta de canvas no admitida.');
}

function parseOperations(value: unknown): readonly CanvasOperation[] {
  const operations = array(value, 'args.operations').map((operation, index) =>
    parseOperation(operation, `args.operations[${index}]`)
  );
  if (operations.length > CANVAS_MAX_WRITE_BATCH)
    fail(
      'args.operations',
      `No puede superar ${CANVAS_MAX_WRITE_BATCH} operaciones por lote.`
    );
  return operations;
}

function validationResult<T>(parse: () => T): CanvasValidationResult<T> {
  try {
    return { ok: true, value: parse() };
  } catch (error) {
    if (error instanceof CanvasValidationError) {
      return {
        ok: false,
        error: {
          code: INVALID_PLAN,
          message: error.message,
          recoverableAction:
            'Corrige el campo indicado y prepara un plan nuevo.',
        },
      };
    }
    throw error;
  }
}

export function validateCanvasNode(
  value: unknown
): CanvasValidationResult<CanvasNode> {
  return validationResult(() => parseCanvasNode(value));
}

export function validateCanvasPlan(
  value: unknown
): CanvasValidationResult<CanvasPlan> {
  return validationResult(() => parseCanvasPlan(value));
}

export function validateCanvasToolArgs<T extends CanvasToolName>(
  tool: T,
  value: unknown
): CanvasValidationResult<CanvasToolArgsMap[T]> {
  return validationResult(() => parseCanvasToolArgs(tool, value));
}
