import type {
  CanvasBounds,
  CanvasDensity,
  CanvasDiagnostic,
  CanvasLayoutOptions,
  CanvasNode,
  CanvasScope,
} from '@affine/realtime/canvas';
import type { EditorHost } from '@blocksuite/affine/std';
import { FontLoaderService } from '@blocksuite/affine-shared/services';
import { routeBetweenRectangles } from '@blocksuite/global/gfx';

import { isSpatialCanvasNode } from './composition';

export const CANVAS_TEXT_TOKENS = {
  body: 20,
  metadata: 16,
  section: 28,
  title: 36,
} as const;

const FRAME_PADDING: Record<CanvasDensity, number> = {
  compact: 40,
  normal: 48,
  ample: 64,
};

export interface CanvasTextMeasureRequest {
  readonly text: string;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly fontWeight: string;
  readonly fontStyle: string;
  readonly maxWidth: number;
}

export interface CanvasTextMeasurement {
  readonly width: number;
  readonly height: number;
  readonly lineHeight: number;
  readonly lines: number;
}

export interface DesignPreparationOptions {
  readonly layout?: CanvasLayoutOptions;
  readonly density?: CanvasDensity;
  readonly autoFit?: boolean;
}

export interface DesignPreparationContext {
  readonly host?: EditorHost;
  readonly scope?: CanvasScope;
  readonly signal?: AbortSignal;
  /** Tests and non-DOM hosts may provide the same renderer measurement. */
  readonly measureText?: (
    request: CanvasTextMeasureRequest
  ) => Promise<CanvasTextMeasurement> | CanvasTextMeasurement;
}

export interface PreparedDesign {
  readonly nodes: readonly CanvasNode[];
  readonly measurements: Readonly<Record<string, CanvasTextMeasurement>>;
  readonly diagnostics: readonly CanvasDiagnostic[];
}

export interface CanvasVisualAudit {
  readonly diagnostics: readonly CanvasDiagnostic[];
  /** Human rubric dimensions remain pending until a render is reviewed. */
  readonly axes: Readonly<Record<CanvasVisualAxis, 'pending'>>;
}

export type CanvasVisualAxis =
  | 'structure'
  | 'legibility'
  | 'hierarchy'
  | 'composition'
  | 'routes'
  | 'consistency'
  | 'visualContainment'
  | 'continuity';

function abortIfNeeded(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new DOMException(
      'Canvas design preparation cancelled.',
      'AbortError'
    );
}

function finiteBounds(bounds: CanvasBounds) {
  return (
    [bounds.x, bounds.y, bounds.w, bounds.h].every(Number.isFinite) &&
    bounds.w > 0 &&
    bounds.h > 0
  );
}

function textOf(node: CanvasNode) {
  const text = node.props.text;
  return typeof text === 'string' ? text : '';
}

function fontOf(node: CanvasNode) {
  const role = node.design?.role ?? node.props.role;
  const defaultSize =
    role === 'title'
      ? CANVAS_TEXT_TOKENS.title
      : role === 'section'
        ? CANVAS_TEXT_TOKENS.section
        : role === 'metadata'
          ? CANVAS_TEXT_TOKENS.metadata
          : CANVAS_TEXT_TOKENS.body;
  return {
    fontFamily:
      typeof node.props.fontFamily === 'string'
        ? node.props.fontFamily
        : 'Inter',
    fontSize:
      typeof node.props.fontSize === 'number' &&
      Number.isFinite(node.props.fontSize)
        ? node.props.fontSize
        : defaultSize,
    fontWeight:
      typeof node.props.fontWeight === 'string' ? node.props.fontWeight : '400',
    fontStyle:
      typeof node.props.fontStyle === 'string'
        ? node.props.fontStyle
        : 'normal',
  };
}

function visualBounds(node: CanvasNode): CanvasBounds {
  const rotate =
    typeof node.props.rotate === 'number' && Number.isFinite(node.props.rotate)
      ? node.props.rotate
      : 0;
  if (rotate === 0) return node.bounds;
  const radians = (rotate * Math.PI) / 180;
  const width =
    Math.abs(node.bounds.w * Math.cos(radians)) +
    Math.abs(node.bounds.h * Math.sin(radians));
  const height =
    Math.abs(node.bounds.w * Math.sin(radians)) +
    Math.abs(node.bounds.h * Math.cos(radians));
  return {
    x: node.bounds.x + (node.bounds.w - width) / 2,
    y: node.bounds.y + (node.bounds.h - height) / 2,
    w: width,
    h: height,
  };
}

async function defaultMeasure(
  request: CanvasTextMeasureRequest
): Promise<CanvasTextMeasurement | undefined> {
  if (typeof document === 'undefined') return undefined;
  // Reuse the renderer's font quoting, wrapping and line metrics. A CSS font
  // name such as blocksuite:surface:Inter is invalid when interpolated raw.
  const {
    getFontString,
    getLineWidth,
    measureTextInDOM,
    normalizeText,
    wrapText,
  } = await import('@blocksuite/affine/gfx/text');
  const font = getFontString(request);
  const { lineHeight, lineGap } = measureTextInDOM(
    request.fontFamily,
    request.fontSize,
    request.fontWeight
  );
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) return undefined;
  const text = normalizeText(request.text);
  const longestWord = Math.max(
    0,
    ...text.split(/\s+/u).map(word => getLineWidth(word, font))
  );
  // Avoid an orphaned last letter in a label. Very long URLs still wrap in a
  // bounded column rather than forcing a board thousands of units wide.
  const maxWidth = Math.max(request.maxWidth, Math.min(longestWord + 2, 480));
  const lines = wrapText(text, font, maxWidth).split('\n');
  return {
    width: Math.ceil(
      Math.max(0, ...lines.map(line => getLineWidth(line, font))) + 2
    ),
    height: Math.ceil((lineHeight + Math.max(0, lineGap)) * lines.length),
    lineHeight,
    lines: lines.length,
  };
}

async function waitForNativeFonts(
  host: EditorHost | undefined,
  signal?: AbortSignal
) {
  if (!host) return true;
  try {
    abortIfNeeded(signal);
    await host.std.get(FontLoaderService).ready;
    abortIfNeeded(signal);
    return true;
  } catch {
    return false;
  }
}

function inScope(node: CanvasNode, scope?: CanvasScope) {
  return !scope?.ids || scope.ids.includes(node.id);
}

function resizeForText(node: CanvasNode, measurement: CanvasTextMeasurement) {
  const paddingX = node.kind === 'shape' ? 20 : 0;
  const paddingY = node.kind === 'shape' ? 10 : 0;
  return {
    ...node.bounds,
    w: Math.max(node.bounds.w, measurement.width + paddingX * 2),
    h: Math.max(node.bounds.h, measurement.height + paddingY * 2),
  };
}

function applyFrameContainment(
  nodes: readonly CanvasNode[],
  density: CanvasDensity,
  diagnostics: CanvasDiagnostic[],
  scope?: CanvasScope
) {
  const result = new Map(nodes.map(node => [node.id, node]));
  const padding = FRAME_PADDING[density];
  for (const frame of nodes.filter(
    node => node.kind === 'frame' && inScope(node, scope)
  )) {
    const children = nodes.filter(
      node => node.parentId === frame.id && inScope(node, scope)
    );
    if (!children.length) continue;
    const minX = Math.min(...children.map(child => visualBounds(child).x));
    const minY = Math.min(...children.map(child => visualBounds(child).y));
    const maxX = Math.max(
      ...children.map(child => visualBounds(child).x + visualBounds(child).w)
    );
    const maxY = Math.max(
      ...children.map(child => visualBounds(child).y + visualBounds(child).h)
    );
    const needed = {
      x: minX - padding,
      y: minY - padding - 28,
      w: maxX - minX + padding * 2,
      h: maxY - minY + padding * 2 + 28,
    };
    const inside =
      frame.bounds.x <= needed.x &&
      frame.bounds.y <= needed.y &&
      frame.bounds.x + frame.bounds.w >= needed.x + needed.w &&
      frame.bounds.y + frame.bounds.h >= needed.y + needed.h;
    if (!inside && frame.layout !== 'auto') {
      diagnostics.push({
        code: 'CONSTRAINT_CONFLICT',
        severity: 'error',
        message:
          'El frame fijo o preservado no contiene a sus hijos con padding y reserva de título.',
        affectedIds: [frame.id, ...children.map(child => child.id)],
        recoverable: true,
      });
      continue;
    }
    if (!inside) {
      const x = Math.min(frame.bounds.x, needed.x);
      const y = Math.min(frame.bounds.y, needed.y);
      const right = Math.max(
        frame.bounds.x + frame.bounds.w,
        needed.x + needed.w
      );
      const bottom = Math.max(
        frame.bounds.y + frame.bounds.h,
        needed.y + needed.h
      );
      result.set(frame.id, {
        ...frame,
        bounds: { x, y, w: right - x, h: bottom - y },
      });
    }
  }
  return nodes.map(node => result.get(node.id) ?? node);
}

/** Prepares measured, native-font-ready geometry without touching the document. */
export async function prepareDesign(
  nodes: readonly CanvasNode[],
  options: DesignPreparationOptions = {},
  context: DesignPreparationContext = {}
): Promise<PreparedDesign> {
  abortIfNeeded(context.signal);
  const diagnostics: CanvasDiagnostic[] = [];
  const measurements: Record<string, CanvasTextMeasurement> = {};
  const fontsReady = await waitForNativeFonts(context.host, context.signal);
  if (context.host && !fontsReady)
    diagnostics.push({
      code: 'FONT_UNAVAILABLE',
      severity: 'error',
      message: 'No se pudo confirmar la carga de las fuentes nativas.',
      recoverable: true,
    });
  const density = options.density ?? options.layout?.density ?? 'normal';
  const prepared: CanvasNode[] = [];
  for (const input of nodes) {
    const node =
      (input.kind === 'shape' || input.kind === 'text') &&
      typeof input.props.text === 'string'
        ? { ...input, props: { ...fontOf(input), ...input.props } }
        : input;
    abortIfNeeded(context.signal);
    if (!finiteBounds(node.bounds)) {
      diagnostics.push({
        code: 'INVALID_PLAN',
        severity: 'error',
        message: 'El nodo tiene bounds no finitos o no positivos.',
        affectedIds: [node.id],
        recoverable: true,
      });
      prepared.push(node);
      continue;
    }
    if (typeof node.props.rotate === 'number' && node.props.rotate !== 0)
      diagnostics.push({
        code: 'CONSTRAINT_CONFLICT',
        severity: 'info',
        message:
          'La auditoría usa el bounds visual envolvente de un nodo rotado.',
        affectedIds: [node.id],
      });
    const text = textOf(node);
    if (!text || !inScope(node, context.scope)) {
      prepared.push(node);
      continue;
    }
    const font = fontOf(node);
    const request = {
      text,
      ...font,
      maxWidth: Math.max(1, node.bounds.w - (node.kind === 'shape' ? 40 : 0)),
    };
    const measurement = context.measureText
      ? await context.measureText(request)
      : await defaultMeasure(request);
    if (!measurement) {
      diagnostics.push({
        code: 'FONT_UNAVAILABLE',
        severity: 'error',
        message:
          'No hay adaptador de medición ni canvas disponible para medir el texto.',
        affectedIds: [node.id],
        recoverable: true,
      });
      prepared.push(node);
      continue;
    }
    measurements[node.id] = measurement;
    const required = resizeForText(node, measurement);
    if (required.w > node.bounds.w || required.h > node.bounds.h) {
      if (node.layout === 'auto' && options.autoFit !== false)
        prepared.push({ ...node, bounds: required });
      else {
        diagnostics.push({
          code: 'CONSTRAINT_CONFLICT',
          severity: 'error',
          message:
            'El texto no cabe en bounds explícitos o protegidos; no se redimensionó.',
          affectedIds: [node.id],
          recoverable: true,
        });
        prepared.push(node);
      }
    } else prepared.push(node);
  }
  return {
    nodes: applyFrameContainment(prepared, density, diagnostics, context.scope),
    measurements,
    diagnostics,
  };
}

function overlap(a: CanvasBounds, b: CanvasBounds) {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

/** Geometric evidence only; human visual judgement is deliberately left pending. */
export function auditCanvasVisual(
  nodes: readonly CanvasNode[],
  options: { readonly scope?: CanvasScope } = {}
): CanvasVisualAudit {
  const diagnostics: CanvasDiagnostic[] = [];
  const scoped = nodes.filter(isSpatialCanvasNode);
  const axes = Object.fromEntries(
    [
      'structure',
      'legibility',
      'hierarchy',
      'composition',
      'routes',
      'consistency',
      'visualContainment',
      'continuity',
    ].map(axis => [axis, 'pending'])
  ) as CanvasVisualAudit['axes'];
  for (const current of scoped) {
    if (!inScope(current, options.scope)) continue;
    if (current.kind === 'connector') {
      if (current.props.aiRouteError)
        diagnostics.push({
          code: 'CONSTRAINT_CONFLICT',
          severity: 'error',
          message:
            'No se encontró una ruta libre dentro del presupuesto de obstáculos.',
          affectedIds: [current.id],
          recoverable: true,
        });
      if (
        (typeof current.props.text === 'string' ||
          typeof current.props.label === 'string') &&
        !Array.isArray(current.props.aiRoute)
      )
        diagnostics.push({
          code: 'RENDER_UNAVAILABLE',
          severity: 'warning',
          message:
            'La etiqueta del connector no tiene una ruta o ancla verificable.',
          affectedIds: [current.id],
          recoverable: true,
        });
      continue;
    }
    const ancestorOf = (ancestor: string, child: CanvasNode) => {
      let parent = child.parentId;
      const seen = new Set<string>();
      while (parent && !seen.has(parent)) {
        if (parent === ancestor) return true;
        seen.add(parent);
        parent = scoped.find(node => node.id === parent)?.parentId;
      }
      return false;
    };
    for (const other of scoped) {
      if (
        current.id === other.id ||
        other.kind === 'connector' ||
        ancestorOf(other.id, current) ||
        ancestorOf(current.id, other)
      )
        continue;
      if (overlap(visualBounds(current), visualBounds(other)))
        diagnostics.push({
          code: 'CONSTRAINT_CONFLICT',
          severity: 'error',
          message: 'Se detectó solapamiento inesperado entre bounds visuales.',
          affectedIds: [current.id, other.id],
          recoverable: true,
        });
    }
    if (current.parentId) {
      const parent = scoped.find(node => node.id === current.parentId);
      if (parent?.kind === 'frame') {
        const childBounds = visualBounds(current);
        const frameBounds = visualBounds(parent);
        if (
          childBounds.x < frameBounds.x ||
          childBounds.y < frameBounds.y ||
          childBounds.x + childBounds.w > frameBounds.x + frameBounds.w ||
          childBounds.y + childBounds.h > frameBounds.y + frameBounds.h
        )
          diagnostics.push({
            code: 'CONSTRAINT_CONFLICT',
            severity: 'error',
            message: 'El bloque hijo excede los bounds visuales de su frame.',
            affectedIds: [current.id, parent.id],
            recoverable: true,
          });
      }
    }
  }
  return { diagnostics, axes };
}

/** Deterministic orthogonal connector metadata for an AI-owned routing plugin. */
export function routeCanvasConnectors(
  nodes: readonly CanvasNode[],
  padding = 24
): readonly CanvasNode[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const obstacles = nodes.filter(node => node.kind !== 'connector');
  return nodes.map(node => {
    if (node.kind !== 'connector' || !node.sourceId || !node.targetId)
      return node;
    const source = byId.get(node.sourceId);
    const target = byId.get(node.targetId);
    if (!source || !target) return node;
    const port = (value: unknown): [number, number] | undefined => {
      const position =
        value && typeof value === 'object' && 'position' in value
          ? value.position
          : undefined;
      return Array.isArray(position) &&
        position.length === 2 &&
        position.every(
          item => typeof item === 'number' && Number.isFinite(item)
        )
        ? [position[0], position[1]]
        : undefined;
    };
    const points = routeBetweenRectangles(
      source.bounds,
      target.bounds,
      obstacles
        .filter(
          obstacle =>
            isSpatialCanvasNode(obstacle) &&
            obstacle.kind !== 'frame' &&
            obstacle.kind !== 'group' &&
            obstacle.kind !== 'mindmap'
        )
        .map(visualBounds),
      {
        stub: padding,
        clearance: Math.min(12, padding / 2),
        sourcePort: port(node.props.source),
        targetPort: port(node.props.target),
      }
    );
    const {
      aiRoute: _oldRoute,
      aiRouteError: _oldError,
      aiLabelAnchor: _oldAnchor,
      ...props
    } = node.props;
    return {
      ...node,
      props: {
        ...props,
        ...(points
          ? { aiRoute: points.map(point => ({ x: point.x, y: point.y })) }
          : { aiRouteError: true }),
        ...(points &&
        (typeof node.props.text === 'string' ||
          typeof node.props.label === 'string')
          ? { aiLabelAnchor: { x: points[1].x, y: points[1].y } }
          : {}),
      },
    };
  });
}
