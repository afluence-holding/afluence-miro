import type {
  CanvasJsonValue,
  CanvasNode,
  CanvasProps,
} from '@affine/realtime/canvas';

export const NATIVE_PRIMITIVE_REGISTRY = [
  {
    kind: 'shape',
    editableProps: [
      'text',
      'shapeType',
      'radius',
      'filled',
      'fillColor',
      'strokeWidth',
      'strokeColor',
      'strokeStyle',
      'shapeStyle',
      'roughness',
      'color',
      'fontFamily',
      'fontSize',
      'fontStyle',
      'fontWeight',
      'textHorizontalAlign',
      'textVerticalAlign',
      'textAlign',
      'lockedBySelf',
    ],
  },
  {
    kind: 'text',
    editableProps: [
      'text',
      'color',
      'fontFamily',
      'fontSize',
      'fontStyle',
      'fontWeight',
      'textAlign',
      'hasMaxWidth',
      'lockedBySelf',
    ],
  },
  {
    kind: 'brush',
    editableProps: ['points', 'color', 'lineWidth', 'lockedBySelf'],
  },
  {
    kind: 'highlighter',
    editableProps: ['points', 'color', 'lineWidth', 'lockedBySelf'],
  },
  {
    kind: 'connector',
    editableProps: [
      'mode',
      'routing',
      'stroke',
      'strokeWidth',
      'strokeStyle',
      'roughness',
      'text',
      'frontEndpointStyle',
      'rearEndpointStyle',
      'lockedBySelf',
    ],
  },
  { kind: 'group', editableProps: ['title', 'lockedBySelf'] },
  {
    kind: 'mindmap',
    editableProps: ['tree', 'layoutType', 'style', 'lockedBySelf'],
  },
] as const;

export type NativePrimitiveKind =
  (typeof NATIVE_PRIMITIVE_REGISTRY)[number]['kind'];
export const NATIVE_PRIMITIVE_MAX_POINTS = 2_000;
export const NATIVE_PRIMITIVE_MAX_MINDMAP_NODES = 100;

export interface NativeMindmapTree {
  readonly text: string;
  readonly children?: readonly NativeMindmapTree[];
}

export interface NativePrimitiveValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

export interface NativePrimitiveModel {
  readonly type: string;
  /** Native brush points are local to this derived model origin. */
  readonly x?: number;
  readonly y?: number;
  readonly serialize?: () => Record<string, unknown>;
  readonly props?: Record<string, unknown>;
  readonly layoutType?: number;
  readonly style?: number;
  readonly tree?: NativeMindmapTreeModel;
}

export interface NativeMindmapTreeModel {
  readonly element?: {
    readonly text?: unknown;
    readonly props?: { readonly text?: unknown };
  };
  readonly children?: readonly NativeMindmapTreeModel[];
}

function finiteBounds(node: CanvasNode) {
  const { x, y, w, h } = node.bounds;
  return [x, y, w, h].every(Number.isFinite) && w > 0 && h > 0;
}

function isPrimitiveKind(
  kind: CanvasNode['kind']
): kind is NativePrimitiveKind {
  return NATIVE_PRIMITIVE_REGISTRY.some(entry => entry.kind === kind);
}

function descriptor(kind: NativePrimitiveKind) {
  const entry = NATIVE_PRIMITIVE_REGISTRY.find(entry => entry.kind === kind);
  if (!entry) throw new Error(`Primitive canvas desconocido: ${kind}`);
  return entry;
}

function finitePoint(value: unknown): value is readonly number[] {
  return (
    Array.isArray(value) &&
    (value.length === 2 || value.length === 3) &&
    value.every(item => typeof item === 'number' && Number.isFinite(item))
  );
}

function countTree(tree: NativeMindmapTree): number {
  return (
    1 +
    (tree.children?.reduce((count, child) => count + countTree(child), 0) ?? 0)
  );
}

export function isNativeMindmapTree(
  value: unknown
): value is NativeMindmapTree {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const tree = value as Record<string, unknown>;
  return (
    typeof tree.text === 'string' &&
    (tree.children === undefined ||
      (Array.isArray(tree.children) &&
        tree.children.every(isNativeMindmapTree)))
  );
}

/** Validates only native primitive input; it performs no store or DOM write. */
export function validateNativePrimitiveNode(
  node: CanvasNode
): NativePrimitiveValidation {
  if (!isPrimitiveKind(node.kind))
    return { ok: false, errors: [`${node.kind} no es una primitiva nativa.`] };
  if (!finiteBounds(node))
    return { ok: false, errors: ['bounds deben ser finitos y positivos.'] };
  const allowed = new Set<string>(descriptor(node.kind).editableProps);
  const invalid = Object.keys(node.props).filter(key => !allowed.has(key));
  if (invalid.length)
    return {
      ok: false,
      errors: [`Campos no admitidos para ${node.kind}: ${invalid.join(', ')}.`],
    };
  if (node.kind === 'brush' || node.kind === 'highlighter') {
    const points = node.props.points;
    if (!Array.isArray(points) || points.length < 2)
      return { ok: false, errors: ['points requiere al menos dos puntos.'] };
    if (points.length > NATIVE_PRIMITIVE_MAX_POINTS)
      return {
        ok: false,
        errors: ['points supera el límite de la primitiva.'],
      };
    if (!points.every(finitePoint))
      return {
        ok: false,
        errors: ['points debe contener coordenadas finitas [x,y,pressure?].'],
      };
    if (typeof node.props.color !== 'string' || !node.props.color)
      return {
        ok: false,
        errors: ['color es obligatorio para un trazo nativo.'],
      };
    if (
      typeof node.props.lineWidth !== 'number' ||
      !Number.isFinite(node.props.lineWidth) ||
      node.props.lineWidth <= 0
    )
      return { ok: false, errors: ['lineWidth debe ser un número positivo.'] };
  }
  if (node.kind === 'mindmap') {
    const tree = node.props.tree;
    if (!isNativeMindmapTree(tree))
      return {
        ok: false,
        errors: ['mindmap requiere props.tree con texto y children.'],
      };
    if (countTree(tree) > NATIVE_PRIMITIVE_MAX_MINDMAP_NODES)
      return { ok: false, errors: ['mindmap supera el límite de nodos.'] };
  }
  return { ok: true, errors: [] };
}

/**
 * Converts the authoring-safe primitive recipe to `surface.addElement` props.
 * Brush points are deliberately left in canvas/world coordinates: Affine's
 * model converts them to local points and derives `xywh` atomically.
 */
export function nativePrimitiveCreateProps(
  node: CanvasNode
): Record<string, unknown> {
  const validation = validateNativePrimitiveNode(node);
  if (!validation.ok) throw new Error(validation.errors.join(' '));
  const { x, y, w, h } = node.bounds;
  if (node.kind === 'brush' || node.kind === 'highlighter') {
    return {
      type: node.kind,
      points: node.props.points,
      color: node.props.color,
      lineWidth: node.props.lineWidth,
      ...(node.props.lockedBySelf === undefined
        ? {}
        : { lockedBySelf: node.props.lockedBySelf }),
    };
  }
  if (node.kind === 'mindmap') {
    return {
      type: 'mindmap',
      children: node.props.tree,
      ...(typeof node.props.layoutType === 'number'
        ? { layoutType: node.props.layoutType }
        : {}),
      ...(typeof node.props.style === 'number'
        ? { style: node.props.style }
        : {}),
      ...(node.props.lockedBySelf === undefined
        ? {}
        : { lockedBySelf: node.props.lockedBySelf }),
    };
  }
  return {
    type: node.kind,
    ...node.props,
    xywh: `[${x},${y},${w},${h}]`,
  };
}

function primitiveValue(value: unknown): CanvasJsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const values = value.map(primitiveValue);
    return values.every(item => item !== undefined)
      ? (values as CanvasJsonValue[])
      : undefined;
  }
  if (value && typeof value === 'object') {
    const result: Record<string, CanvasJsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      const normalized = primitiveValue(child);
      if (normalized !== undefined) result[key] = normalized;
    }
    return result;
  }
  return undefined;
}

function treeText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'toString' in value) {
    const text = value.toString();
    return text === '[object Object]' ? '' : text;
  }
  return '';
}

function snapshotTree(node: NativeMindmapTreeModel): NativeMindmapTree {
  const text = treeText(node.element?.text ?? node.element?.props?.text);
  return {
    text,
    ...(node.children?.length
      ? { children: node.children.map(snapshotTree) }
      : {}),
  };
}

/** Projects model state back to the bounded, JSON-only authoring recipe. */
export function snapshotNativePrimitive(
  model: NativePrimitiveModel
): CanvasProps | undefined {
  if (!isPrimitiveKind(model.type as CanvasNode['kind'])) return undefined;
  const kind = model.type as NativePrimitiveKind;
  const source = model.serialize?.() ?? model.props ?? {};
  const props: Record<string, CanvasJsonValue> = {};
  for (const key of descriptor(kind).editableProps) {
    if (key === 'tree') continue;
    const value = primitiveValue(source[key]);
    if (value !== undefined) props[key] = value;
  }
  if (kind === 'brush' || kind === 'highlighter') {
    const points = source.points;
    const x = model.x;
    const y = model.y;
    if (
      Array.isArray(points) &&
      typeof x === 'number' &&
      Number.isFinite(x) &&
      typeof y === 'number' &&
      Number.isFinite(y)
    ) {
      const worldPoints = points.map(point => {
        if (!finitePoint(point)) return point;
        const [pointX, pointY, ...rest] = point;
        if (pointX === undefined || pointY === undefined) return point;
        return [pointX + x, pointY + y, ...rest];
      });
      const normalized = primitiveValue(worldPoints);
      if (normalized !== undefined) props.points = normalized;
    }
  }
  if (kind === 'mindmap') {
    if (!model.tree) return undefined;
    const tree = primitiveValue(snapshotTree(model.tree));
    if (tree === undefined) return undefined;
    props.tree = tree;
    if (typeof model.layoutType === 'number')
      props.layoutType = model.layoutType;
    if (typeof model.style === 'number') props.style = model.style;
  }
  return props;
}

/** Rewrites explicit group membership after native IDs are allocated. */
export function remapNativePrimitiveRelations(
  ids: readonly string[],
  idMap: Readonly<Record<string, string>>
): readonly string[] {
  return ids.map(id => idMap[id] ?? id);
}
