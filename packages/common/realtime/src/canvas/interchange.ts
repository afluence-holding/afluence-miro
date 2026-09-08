import { layoutCanvas } from './layout';
import {
  CANVAS_CONTRACT_VERSION,
  CANVAS_MAX_WRITE_BATCH,
  type CanvasAuthoringRecipe,
  type CanvasDiagnostic,
  type CanvasError,
  type CanvasFidelityEntry,
  type CanvasInterchangeInput,
  type CanvasInterchangeOutput,
  type CanvasJsonValue,
  type CanvasNode,
  type CanvasProps,
} from './types';
import { validateCanvasNode } from './validation';

const DEFAULT_MAX_OBJECTS = CANVAS_MAX_WRITE_BATCH;

export type CanvasInterchangeResult =
  | { readonly ok: true; readonly data: CanvasInterchangeOutput }
  | { readonly ok: false; readonly error: CanvasError };

/** Adapter intentionally supplied by a host; this common package never parses XML. */
export interface CanvasXmlElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly CanvasXmlElement[];
}

export interface CanvasXmlParser {
  parse(xml: string): CanvasXmlElement;
}

export interface CanvasInterchangeAdapters {
  readonly xml?: CanvasXmlParser;
}

function error(
  code: CanvasError['code'],
  message: string
): CanvasInterchangeResult {
  return {
    ok: false,
    error: {
      code,
      message,
      recoverableAction:
        'Corrige o convierte el contenido y vuelve a intentarlo.',
    },
  };
}

function success(
  format: CanvasInterchangeOutput['format'],
  nodes: readonly CanvasNode[],
  entries: readonly CanvasFidelityEntry[],
  diagnostics: readonly CanvasDiagnostic[] = [],
  recipe?: CanvasAuthoringRecipe,
  content?: CanvasJsonValue
): CanvasInterchangeResult {
  return {
    ok: true,
    data: {
      format,
      nodes,
      ...(recipe ? { recipe } : {}),
      ...(content === undefined ? {} : { content }),
      fidelity: { format, entries },
      diagnostics,
    },
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function number(value: unknown, fallback?: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function maxObjects(
  input: Pick<CanvasInterchangeInput, 'maxObjects'>
): number | undefined {
  const max = input.maxObjects ?? DEFAULT_MAX_OBJECTS;
  return Number.isInteger(max) && max > 0 && max <= DEFAULT_MAX_OBJECTS
    ? max
    : undefined;
}

function checkedNodes(
  nodes: readonly CanvasNode[],
  max: number
): CanvasInterchangeResult | undefined {
  if (nodes.length > max)
    return error(
      'BUDGET_EXCEEDED',
      `El formato excede el límite de ${max} objetos.`
    );
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id))
      return error('INVALID_PLAN', `ID duplicado: ${node.id}.`);
    ids.add(node.id);
    const validation = validateCanvasNode(node);
    if (!validation.ok) return { ok: false, error: validation.error };
  }
  for (const node of nodes) {
    for (const id of [node.parentId, node.sourceId, node.targetId]) {
      if (id !== undefined && !ids.has(id)) {
        return error(
          'INVALID_PLAN',
          `La referencia ${id} de ${node.id} no se puede resolver.`
        );
      }
    }
  }
  return undefined;
}

function recipeFromNodes(nodes: readonly CanvasNode[]): CanvasAuthoringRecipe {
  return { schemaVersion: CANVAS_CONTRACT_VERSION, recipeVersion: 1, nodes };
}

function importRecipe(
  input: CanvasInterchangeInput,
  max: number
): CanvasInterchangeResult {
  const source = record(input.content);
  if (
    !source ||
    source.schemaVersion !== CANVAS_CONTRACT_VERSION ||
    source.recipeVersion !== 1 ||
    !Array.isArray(source.nodes)
  ) {
    return error('INVALID_PLAN', 'Recipe inválida o de versión no compatible.');
  }
  const nodes: CanvasNode[] = [];
  for (const node of source.nodes) {
    const validation = validateCanvasNode(node);
    if (!validation.ok) return { ok: false, error: validation.error };
    nodes.push(validation.value);
  }
  const invalid = checkedNodes(nodes, max);
  if (invalid) return invalid;
  return success(
    'recipe',
    nodes,
    [{ outcome: 'preserved', feature: 'nodes-and-connections' }],
    [],
    recipeFromNodes(nodes)
  );
}

function exportRecipe(
  nodes: readonly CanvasNode[],
  max: number
): CanvasInterchangeResult {
  const invalid = checkedNodes(nodes, max);
  if (invalid) return invalid;
  return success(
    'recipe',
    nodes,
    [{ outcome: 'preserved', feature: 'nodes-and-connections' }],
    [],
    recipeFromNodes(nodes)
  );
}

interface ExcalElement {
  readonly id: string;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly text?: string;
  readonly groupIds?: readonly string[];
  readonly containerId?: string;
  readonly startBinding?: Readonly<{ elementId?: string }>;
  readonly endBinding?: Readonly<{ elementId?: string }>;
  /** Native-safe projection of Excalidraw's supported style subset. */
  readonly props: CanvasProps;
  readonly flattenedStyle: boolean;
}

function excalProps(
  element: Record<string, unknown>,
  type: string
): {
  props: CanvasProps;
  flattenedStyle: boolean;
} {
  const props: Record<string, CanvasJsonValue> = {};
  const copy = (source: string, target = source) => {
    const value = element[source];
    if (
      typeof value === 'string' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      props[target] = value;
  };
  if (type === 'text') {
    copy('strokeColor', 'color');
    copy('fontSize');
    copy('textAlign');
  } else if (type === 'arrow') {
    copy('strokeColor', 'stroke');
    copy('strokeWidth');
    copy('strokeStyle');
    copy('roughness');
  } else {
    copy('backgroundColor', 'fillColor');
    copy('strokeColor');
    copy('strokeWidth');
    copy('strokeStyle');
    copy('roughness');
    if (type === 'rectangle' || type === 'ellipse' || type === 'diamond')
      props.shapeType = type === 'rectangle' ? 'rect' : type;
    if (typeof element.fillStyle === 'string')
      props.filled =
        element.fillStyle !== 'hachure' && element.fillStyle !== 'cross-hatch';
  }
  return {
    props,
    // These fields either require an asset pipeline or lack a native equivalent.
    flattenedStyle:
      element.opacity !== undefined ||
      element.roundness !== undefined ||
      element.seed !== undefined ||
      element.version !== undefined ||
      element.customData !== undefined,
  };
}

function copyExcalStyle(
  node: CanvasNode,
  output: Record<string, CanvasJsonValue>
) {
  const copy = (source: string, target = source) => {
    const value = node.props[source];
    if (
      typeof value === 'string' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      output[target] = value;
  };
  if (node.kind === 'text') {
    copy('color', 'strokeColor');
    copy('fontSize');
    copy('textAlign');
  } else if (node.kind === 'connector') {
    copy('stroke', 'strokeColor');
    copy('strokeWidth');
    copy('strokeStyle');
    copy('roughness');
  } else {
    copy('fillColor', 'backgroundColor');
    copy('strokeColor');
    copy('strokeWidth');
    copy('strokeStyle');
    copy('roughness');
  }
}

function parseExcalElements(
  value: CanvasJsonValue,
  max: number
): ExcalElement[] | CanvasInterchangeResult {
  const root = record(value);
  const raw = root?.elements;
  if (!Array.isArray(raw))
    return error('INVALID_PLAN', 'Excalidraw requiere un objeto con elements.');
  if (raw.length > max)
    return error(
      'BUDGET_EXCEEDED',
      `Excalidraw excede el límite de ${max} objetos.`
    );
  const ids = new Set<string>();
  const elements: ExcalElement[] = [];
  for (const item of raw) {
    const element = record(item);
    const id = string(element?.id);
    const type = string(element?.type);
    const x = number(element?.x);
    const y = number(element?.y);
    const width = number(element?.width);
    const height = number(element?.height);
    if (
      !element ||
      !id ||
      !type ||
      x === undefined ||
      y === undefined ||
      width === undefined ||
      height === undefined
    )
      return error('INVALID_PLAN', 'Elemento Excalidraw malformado.');
    if (ids.has(id))
      return error('INVALID_PLAN', `ID Excalidraw duplicado: ${id}.`);
    ids.add(id);
    if (!['rectangle', 'ellipse', 'diamond', 'text', 'arrow'].includes(type))
      return error(
        'UNSUPPORTED_CAPABILITY',
        `Excalidraw ${type} no pertenece al subconjunto soportado.`
      );
    const groupIds =
      Array.isArray(element.groupIds) &&
      element.groupIds.every(value => typeof value === 'string')
        ? (element.groupIds as string[])
        : undefined;
    const start = record(element.startBinding);
    const end = record(element.endBinding);
    elements.push({
      id,
      type,
      x,
      y,
      width,
      height,
      ...(typeof element.text === 'string' ? { text: element.text } : {}),
      ...(groupIds ? { groupIds } : {}),
      ...(typeof element.containerId === 'string'
        ? { containerId: element.containerId }
        : {}),
      ...(start
        ? {
            startBinding:
              typeof start.elementId === 'string'
                ? { elementId: start.elementId }
                : {},
          }
        : {}),
      ...(end
        ? {
            endBinding:
              typeof end.elementId === 'string'
                ? { elementId: end.elementId }
                : {},
          }
        : {}),
      ...excalProps(element, type),
    });
  }
  return elements;
}

function importExcalidraw(
  input: CanvasInterchangeInput,
  max: number
): CanvasInterchangeResult {
  const parsed = parseExcalElements(input.content, max);
  if (!Array.isArray(parsed)) return parsed;
  const nodes: CanvasNode[] = [];
  const arrows = new Set(
    parsed
      .filter(element => element.type === 'arrow')
      .map(element => element.id)
  );
  const danglingLabel = parsed.find(
    element =>
      element.type === 'text' &&
      element.containerId &&
      !arrows.has(element.containerId)
  );
  if (danglingLabel)
    return error(
      'INVALID_PLAN',
      'La etiqueta ' +
        danglingLabel.id +
        ' apunta a un contenedor Excalidraw inexistente.'
    );
  const labelByConnector = new Map(
    parsed.flatMap(element =>
      element.type === 'text' && typeof element.containerId === 'string'
        ? [[element.containerId, element.text ?? ''] as const]
        : []
    )
  );
  const groupMembers = new Map<string, CanvasNode[]>();
  for (const element of parsed) {
    if (element.type === 'text' && element.containerId) continue;
    if (element.type === 'arrow') {
      const sourceId = element.startBinding?.elementId;
      const targetId = element.endBinding?.elementId;
      if (!sourceId || !targetId)
        return error(
          'UNSUPPORTED_CAPABILITY',
          'Un arrow sin extremos vinculados no puede convertirse en connector.'
        );
      nodes.push({
        id: element.id,
        kind: 'connector',
        bounds: {
          x: element.x,
          y: element.y,
          w: Math.max(1, Math.abs(element.width)),
          h: Math.max(1, Math.abs(element.height)),
        },
        props: (() => {
          const label = labelByConnector.get(element.id);
          return label === undefined
            ? element.props
            : { text: label, ...element.props };
        })(),
        sourceId,
        targetId,
      });
      continue;
    }
    const kind = element.type === 'text' ? 'text' : 'shape';
    const parentId = element.groupIds?.at(-1);
    const node: CanvasNode = {
      id: element.id,
      kind,
      bounds: {
        x: element.x,
        y: element.y,
        w: Math.max(1, Math.abs(element.width)),
        h: Math.max(1, Math.abs(element.height)),
      },
      props:
        element.type === 'text'
          ? { text: element.text ?? '', ...element.props }
          : element.props,
      ...(parentId ? { parentId: `group:${parentId}` } : {}),
    };
    nodes.push(node);
    for (const groupId of element.groupIds ?? [])
      groupMembers.set(groupId, [...(groupMembers.get(groupId) ?? []), node]);
  }
  for (const [groupId, members] of [...groupMembers.entries()].sort(
    ([a], [b]) => a.localeCompare(b)
  )) {
    const left = Math.min(...members.map(node => node.bounds.x));
    const top = Math.min(...members.map(node => node.bounds.y));
    const right = Math.max(
      ...members.map(node => node.bounds.x + node.bounds.w)
    );
    const bottom = Math.max(
      ...members.map(node => node.bounds.y + node.bounds.h)
    );
    nodes.push({
      id: `group:${groupId}`,
      kind: 'group',
      bounds: { x: left, y: top, w: right - left, h: bottom - top },
      props: {},
    });
  }
  const invalid = checkedNodes(nodes, max);
  if (invalid) return invalid;
  return success('excalidraw', nodes, [
    { outcome: 'preserved', feature: 'shapes-text-and-bound-arrows' },
    ...(groupMembers.size
      ? [{ outcome: 'converted' as const, feature: 'groups' }]
      : []),
    ...(labelByConnector.size
      ? [{ outcome: 'converted' as const, feature: 'arrow-labels' }]
      : []),
    ...(parsed.some(element => element.flattenedStyle)
      ? [
          {
            outcome: 'flattened' as const,
            feature: 'opacity-roundness-and-custom-style',
          },
        ]
      : [
          {
            outcome: 'preserved' as const,
            feature: 'supported-stroke-fill-and-text-style',
          },
        ]),
  ]);
}

function exportExcalidraw(
  nodes: readonly CanvasNode[],
  max: number
): CanvasInterchangeResult {
  const invalid = checkedNodes(nodes, max);
  if (invalid) return invalid;
  const unsupported = nodes.find(
    node => !['shape', 'text', 'connector', 'group'].includes(node.kind)
  );
  if (unsupported)
    return error(
      'UNSUPPORTED_CAPABILITY',
      `${unsupported.kind} no se puede exportar a Excalidraw en este subconjunto.`
    );
  const elements: CanvasJsonValue[] = [];
  const bound = new Map<string, CanvasJsonValue[]>();
  for (const connector of nodes.filter(node => node.kind === 'connector')) {
    if (!connector.sourceId || !connector.targetId)
      return error(
        'INVALID_PLAN',
        'Connector ' + connector.id + ' requires both endpoint identifiers.'
      );
    for (const endpoint of [connector.sourceId, connector.targetId])
      bound.set(endpoint, [
        ...(bound.get(endpoint) ?? []),
        { type: 'arrow', id: connector.id },
      ]);
  }
  for (const node of nodes
    .filter(node => node.kind !== 'group')
    .sort((a, b) => a.id.localeCompare(b.id))) {
    const base: Record<string, CanvasJsonValue> = {
      id: node.id,
      x: node.bounds.x,
      y: node.bounds.y,
      width: node.bounds.w,
      height: node.bounds.h,
      groupIds: node.parentId?.startsWith('group:')
        ? [node.parentId.slice(6)]
        : [],
    };
    copyExcalStyle(node, base);
    if (node.kind === 'connector') {
      if (!node.sourceId || !node.targetId)
        return error(
          'INVALID_PLAN',
          'Connector ' + node.id + ' requires both endpoint identifiers.'
        );
      base.type = 'arrow';
      base.startBinding = { elementId: node.sourceId };
      base.endBinding = { elementId: node.targetId };
      elements.push(base);
      const label =
        typeof node.props.text === 'string' ? node.props.text : undefined;
      if (label)
        elements.push({
          id: `${node.id}:label`,
          type: 'text',
          x: node.bounds.x,
          y: node.bounds.y,
          width: Math.max(1, node.bounds.w),
          height: 20,
          text: label,
          containerId: node.id,
        });
    } else {
      base.type =
        node.kind === 'text'
          ? 'text'
          : typeof node.props.shapeType === 'string' &&
              ['rectangle', 'ellipse', 'diamond'].includes(node.props.shapeType)
            ? node.props.shapeType
            : 'rectangle';
      if (node.kind === 'text')
        base.text = typeof node.props.text === 'string' ? node.props.text : '';
      const boundElements = bound.get(node.id);
      if (boundElements) base.boundElements = boundElements;
      elements.push(base);
    }
  }
  if (elements.length > max)
    return error(
      'BUDGET_EXCEEDED',
      `La expansión Excalidraw excede el límite de ${max} objetos.`
    );
  return success(
    'excalidraw',
    nodes,
    [
      { outcome: 'preserved', feature: 'shapes-text-and-bound-arrows' },
      { outcome: 'converted', feature: 'groups-and-labels' },
      { outcome: 'preserved', feature: 'supported-stroke-fill-and-text-style' },
    ],
    [],
    undefined,
    { type: 'excalidraw', elements }
  );
}

interface MermaidEdge {
  readonly source: string;
  readonly target: string;
  readonly label?: string;
}

function importMermaid(
  input: CanvasInterchangeInput,
  max: number
): CanvasInterchangeResult {
  if (typeof input.content !== 'string')
    return error('INVALID_PLAN', 'Mermaid debe ser texto.');
  const lines = input.content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const declaration = lines.shift();
  const match = declaration?.match(/^flowchart\s+(TD|LR)$/i);
  if (!match)
    return error(
      'UNSUPPORTED_CAPABILITY',
      'Solo se admite Mermaid flowchart TD o LR.'
    );
  const labels = new Map<string, string>();
  const edges: MermaidEdge[] = [];
  const pattern =
    /^([A-Za-z][\w-]*)(?:\[([^\]]*)\])?\s*-->(?:\|([^|]*)\|)?\s*([A-Za-z][\w-]*)(?:\[([^\]]*)\])?$/;
  for (const line of lines) {
    const edge = line.match(pattern);
    if (!edge)
      return error(
        'UNSUPPORTED_CAPABILITY',
        `Sintaxis Mermaid fuera del subconjunto: ${line}`
      );
    const [, source, sourceLabel, label, target, targetLabel] = edge;
    if (sourceLabel !== undefined) labels.set(source, sourceLabel);
    if (targetLabel !== undefined) labels.set(target, targetLabel);
    edges.push({ source, target, ...(label === undefined ? {} : { label }) });
  }
  const ids = [
    ...new Set(edges.flatMap(edge => [edge.source, edge.target])),
  ].sort((a, b) => a.localeCompare(b));
  if (ids.length + edges.length > max)
    return error(
      'BUDGET_EXCEEDED',
      `Mermaid excede el límite de ${max} objetos.`
    );
  const nodes: CanvasNode[] = ids.map(id => ({
    id,
    kind: 'shape',
    bounds: { x: 0, y: 0, w: 180, h: 72 },
    props: { text: labels.get(id) ?? id },
  }));
  const edgeNodes: CanvasNode[] = edges.map((edge, index) => ({
    id: `edge:${index}`,
    kind: 'connector',
    bounds: { x: 0, y: 0, w: 1, h: 1 },
    props: (edge.label === undefined
      ? {}
      : { text: edge.label }) as CanvasProps,
    sourceId: edge.source,
    targetId: edge.target,
  }));
  const positioned = layoutCanvas({
    nodes: [...nodes, ...edgeNodes],
    options: {
      mode: 'flow',
      direction:
        match[1].toUpperCase() === 'TD' ? 'top-to-bottom' : 'left-to-right',
    },
  });
  return success(
    'mermaid',
    positioned.nodes,
    [
      { outcome: 'converted', feature: 'flowchart-layout' },
      { outcome: 'preserved', feature: 'nodes-and-directed-edges' },
    ],
    positioned.diagnostics
  );
}

function exportMermaid(
  nodes: readonly CanvasNode[],
  max: number
): CanvasInterchangeResult {
  const invalid = checkedNodes(nodes, max);
  if (invalid) return invalid;
  if (nodes.some(node => !['shape', 'connector'].includes(node.kind)))
    return error(
      'UNSUPPORTED_CAPABILITY',
      'Mermaid solo exporta shape y connector en este subconjunto.'
    );
  const shapes = nodes
    .filter(node => node.kind === 'shape')
    .sort((a, b) => a.id.localeCompare(b.id));
  const edges = nodes
    .filter(node => node.kind === 'connector')
    .sort((a, b) => a.id.localeCompare(b.id));
  const lines = ['flowchart LR'];
  for (const edge of edges) {
    const label =
      typeof edge.props.text === 'string' ? `|${edge.props.text}|` : '';
    lines.push(`${edge.sourceId} -->${label} ${edge.targetId}`);
  }
  for (const shape of shapes.filter(
    shape =>
      !edges.some(
        edge => edge.sourceId === shape.id || edge.targetId === shape.id
      )
  ))
    lines.push(
      `${shape.id}[${typeof shape.props.text === 'string' ? shape.props.text : shape.id}]`
    );
  return success(
    'mermaid',
    nodes,
    [{ outcome: 'converted', feature: 'flowchart-source' }],
    [],
    undefined,
    lines.join('\n')
  );
}

function importMarkdown(
  input: CanvasInterchangeInput,
  max: number
): CanvasInterchangeResult {
  if (typeof input.content !== 'string')
    return error('INVALID_PLAN', 'Markdown debe ser texto.');
  const rows = input.content
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0);
  if (rows.length > max)
    return error(
      'BUDGET_EXCEEDED',
      `Markdown excede el límite de ${max} bloques.`
    );
  const nodes = rows.map((line, index) => ({
    id: `markdown:${index}`,
    kind: 'text' as const,
    bounds: { x: 0, y: index * 72, w: 480, h: 48 },
    props: { text: line.replace(/^#{1,6}\s+|^[-*+]\s+/, '') },
  }));
  return success('markdown', nodes, [
    { outcome: 'converted', feature: 'headings-and-lines-to-text' },
  ]);
}

type InterchangeTree = {
  readonly text: string;
  readonly children?: readonly InterchangeTree[];
};

function treeCount(tree: InterchangeTree): number {
  return (
    1 +
    (tree.children?.reduce((count, child) => count + treeCount(child), 0) ?? 0)
  );
}

function markdownLabel(node: CanvasNode) {
  const text = node.props.text;
  return typeof text === 'string' && text.trim() ? text.trim() : node.id;
}

function exportMarkdown(
  nodes: readonly CanvasNode[],
  max: number
): CanvasInterchangeResult {
  const invalid = checkedNodes(nodes, max);
  if (invalid) return invalid;
  const content = nodes
    .filter(node => node.kind !== 'connector' && node.kind !== 'group')
    .sort(
      (left, right) =>
        (left.design?.order ?? left.bounds.y) -
          (right.design?.order ?? right.bounds.y) ||
        left.bounds.x - right.bounds.x ||
        left.id.localeCompare(right.id)
    )
    .map(node => {
      const role = node.design?.role;
      const prefix =
        role === 'title' ? '# ' : role === 'section' ? '## ' : '- ';
      return `${prefix}${markdownLabel(node)}`;
    })
    .join('\n');
  return success(
    'markdown',
    nodes,
    [
      { outcome: 'converted', feature: 'canvas-content-to-markdown-outline' },
      { outcome: 'flattened', feature: 'geometry-connectors-and-visual-style' },
    ],
    [],
    undefined,
    content
  );
}

function xmlEscape(value: string) {
  const entities: Readonly<Record<string, string>> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  };
  return value.replace(
    /[&<>"']/g,
    character => entities[character] ?? character
  );
}

function asMindmapTree(
  value: CanvasJsonValue | undefined
): InterchangeTree | undefined {
  const source = record(value);
  if (!source || typeof source.text !== 'string') return;
  const rawChildren = source.children;
  if (rawChildren !== undefined && !Array.isArray(rawChildren)) return;
  const children = (rawChildren ?? [])
    .map(child => asMindmapTree(child))
    .filter((child): child is InterchangeTree => child !== undefined);
  if (children.length !== (rawChildren?.length ?? 0)) return;
  return { text: source.text, ...(children.length ? { children } : {}) };
}

function exportXmlTree(
  tree: InterchangeTree,
  format: 'freemind' | 'opml'
): string {
  const tag = format === 'freemind' ? 'node' : 'outline';
  const attribute = format === 'freemind' ? 'TEXT' : 'text';
  const children =
    tree.children?.map(child => exportXmlTree(child, format)).join('') ?? '';
  return children
    ? `<${tag} ${attribute}="${xmlEscape(tree.text)}">${children}</${tag}>`
    : `<${tag} ${attribute}="${xmlEscape(tree.text)}"/>`;
}

function exportXml(
  nodes: readonly CanvasNode[],
  max: number,
  format: 'freemind' | 'opml'
): CanvasInterchangeResult {
  const invalid = checkedNodes(nodes, max);
  if (invalid) return invalid;
  const mindmaps = nodes.filter(node => node.kind === 'mindmap');
  if (!mindmaps.length || mindmaps.length !== nodes.length)
    return error(
      'UNSUPPORTED_CAPABILITY',
      `${format} solo exporta mindmaps nativos completos; convierte primero el diagrama a un árbol.`
    );
  const trees = mindmaps.map(node => asMindmapTree(node.props.tree));
  if (trees.some(tree => !tree))
    return error('INVALID_PLAN', 'El mindmap no contiene un árbol exportable.');
  const treeContent = trees as InterchangeTree[];
  const content =
    format === 'freemind'
      ? `<map version="1.0.1">${treeContent.map(tree => exportXmlTree(tree, format)).join('')}</map>`
      : `<?xml version="1.0" encoding="UTF-8"?><opml version="2.0"><head><title>Canvas</title></head><body>${treeContent.map(tree => exportXmlTree(tree, format)).join('')}</body></opml>`;
  return success(
    format,
    nodes,
    [
      { outcome: 'preserved', feature: 'tree-topology-and-text' },
      { outcome: 'flattened', feature: 'canvas-geometry-and-native-style' },
    ],
    [],
    undefined,
    content
  );
}

function xmlTree(
  root: CanvasXmlElement,
  format: 'freemind' | 'opml',
  max: number
): CanvasInterchangeResult {
  const roots =
    format === 'freemind'
      ? root.name === 'map'
        ? root.children.filter(child => child.name === 'node')
        : []
      : root.name === 'opml'
        ? (root.children
            .find(child => child.name === 'body')
            ?.children.filter(child => child.name === 'outline') ?? [])
        : [];
  if (!roots.length)
    return error('INVALID_PLAN', `${format} no contiene un árbol compatible.`);

  const itemName = format === 'freemind' ? 'node' : 'outline';
  const toTree = (element: CanvasXmlElement): InterchangeTree => {
    const children = element.children
      .filter(child => child.name === itemName)
      .map(toTree);
    return {
      text: element.attributes.TEXT ?? element.attributes.text ?? '',
      ...(children.length ? { children } : {}),
    };
  };
  const trees = roots.map(toTree);
  if (trees.reduce((count, tree) => count + treeCount(tree), 0) > max)
    return error(
      'BUDGET_EXCEEDED',
      `${format} excede el límite de ${max} nodos.`
    );
  const nodes: CanvasNode[] = trees.map((tree, index) => ({
    id: `${format}:mindmap:${index}`,
    kind: 'mindmap',
    bounds: { x: index * 420, y: 0, w: 360, h: 240 },
    props: { tree },
  }));
  const invalid = checkedNodes(nodes, max);
  if (invalid) return invalid;
  return success(format, nodes, [
    { outcome: 'preserved', feature: 'tree-topology-and-text' },
    { outcome: 'flattened', feature: 'source-xml-metadata-and-icons' },
  ]);
}

function importXml(
  input: CanvasInterchangeInput,
  format: 'freemind' | 'opml',
  max: number,
  adapters?: CanvasInterchangeAdapters
): CanvasInterchangeResult {
  if (typeof input.content !== 'string')
    return error('INVALID_PLAN', `${format} debe ser XML.`);
  if (/<!DOCTYPE|<!ENTITY/i.test(input.content))
    return error('INVALID_PLAN', 'XML con DTD o entidades no está permitido.');
  if (!adapters?.xml)
    return error(
      'UNSUPPORTED_CAPABILITY',
      `${format} requiere un adaptador XML seguro del host.`
    );
  try {
    return xmlTree(adapters.xml.parse(input.content), format, max);
  } catch {
    return error(
      'INVALID_PLAN',
      `${format} no se pudo analizar de forma segura.`
    );
  }
}

export function importCanvasInterchange(
  input: CanvasInterchangeInput,
  adapters?: CanvasInterchangeAdapters
): CanvasInterchangeResult {
  const max = maxObjects(input);
  if (!max)
    return error(
      'BUDGET_EXCEEDED',
      `maxObjects debe ser un entero de 1 a ${DEFAULT_MAX_OBJECTS}.`
    );
  switch (input.format) {
    case 'recipe':
      return importRecipe(input, max);
    case 'excalidraw':
      return importExcalidraw(input, max);
    case 'mermaid':
      return importMermaid(input, max);
    case 'markdown':
      return importMarkdown(input, max);
    case 'freemind':
    case 'opml':
      return importXml(input, input.format, max, adapters);
    case 'native':
      return error(
        'UNSUPPORTED_CAPABILITY',
        'El contenedor native solo lo implementa el adaptador .bs.zip del editor.'
      );
    default:
      return error(
        'UNSUPPORTED_CAPABILITY',
        `${input.format} no es un formato importable en este contrato.`
      );
  }
}

export function exportCanvasInterchange(
  input: Omit<CanvasInterchangeInput, 'content'> & {
    readonly nodes: readonly CanvasNode[];
  }
): CanvasInterchangeResult {
  const max = maxObjects(input);
  if (!max)
    return error(
      'BUDGET_EXCEEDED',
      `maxObjects debe ser un entero de 1 a ${DEFAULT_MAX_OBJECTS}.`
    );
  switch (input.format) {
    case 'recipe':
      return exportRecipe(input.nodes, max);
    case 'excalidraw':
      return exportExcalidraw(input.nodes, max);
    case 'mermaid':
      return exportMermaid(input.nodes, max);
    case 'markdown':
      return exportMarkdown(input.nodes, max);
    case 'freemind':
    case 'opml':
      return exportXml(input.nodes, max, input.format);
    case 'native':
      return error(
        'UNSUPPORTED_CAPABILITY',
        'El contenedor native solo lo implementa el adaptador .bs.zip del editor.'
      );
    default:
      return error(
        'UNSUPPORTED_CAPABILITY',
        `${input.format} es un formato visual de exportación del editor.`
      );
  }
}
