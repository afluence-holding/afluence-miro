import type {
  CanvasBounds,
  CanvasDensity,
  CanvasDiagnostic,
  CanvasLayoutInput,
  CanvasLayoutOptions,
  CanvasLayoutResult,
  CanvasNode,
} from './types';

const DENSITY_GAPS: Readonly<
  Record<CanvasDensity, Readonly<{ siblingGap: number; levelGap: number }>>
> = {
  compact: { siblingGap: 32, levelGap: 64 },
  normal: { siblingGap: 40, levelGap: 80 },
  ample: { siblingGap: 48, levelGap: 96 },
};

type ResolvedOptions = Required<CanvasLayoutOptions>;

function resolveOptions(options: CanvasLayoutOptions): ResolvedOptions {
  const density = options.density ?? 'normal';
  const gaps = DENSITY_GAPS[density];
  return {
    mode: options.mode,
    grammar: options.grammar ?? 'flow',
    density,
    direction: options.direction ?? 'left-to-right',
    siblingGap: options.siblingGap ?? gaps.siblingGap,
    levelGap: options.levelGap ?? gaps.levelGap,
    columns: options.columns ?? 0,
    origin: options.origin ?? { x: 0, y: 0 },
  };
}

function sameBounds(a: CanvasBounds, b: CanvasBounds): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function isValidBounds(bounds: CanvasBounds): boolean {
  return (
    Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.w) &&
    Number.isFinite(bounds.h) &&
    bounds.w > 0 &&
    bounds.h > 0
  );
}

function replaceBounds(node: CanvasNode, bounds: CanvasBounds): CanvasNode {
  return sameBounds(node.bounds, bounds) ? node : { ...node, bounds };
}

function sortable(nodes: readonly CanvasNode[]): CanvasNode[] {
  return [...nodes].sort(
    (a, b) =>
      (a.design?.order ?? 0) - (b.design?.order ?? 0) ||
      a.bounds.y - b.bounds.y ||
      a.bounds.x - b.bounds.x
  );
}

function boundsOverlap(a: CanvasBounds, b: CanvasBounds): boolean {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

function isMovable(
  node: CanvasNode,
  scopedIds: ReadonlySet<string> | undefined
): boolean {
  return (
    node.kind !== 'connector' &&
    node.layout !== 'fixed' &&
    node.layout !== 'preserve' &&
    (!scopedIds || scopedIds.has(node.id))
  );
}

function layoutLine(
  nodes: readonly CanvasNode[],
  options: ResolvedOptions,
  horizontal: boolean
): Map<string, CanvasBounds> {
  const result = new Map<string, CanvasBounds>();
  let cursor = horizontal ? options.origin.x : options.origin.y;
  for (const node of sortable(nodes)) {
    const bounds = horizontal
      ? { ...node.bounds, x: cursor, y: options.origin.y }
      : { ...node.bounds, x: options.origin.x, y: cursor };
    result.set(node.id, bounds);
    cursor += (horizontal ? bounds.w : bounds.h) + options.siblingGap;
  }
  return result;
}

function layoutGrid(
  nodes: readonly CanvasNode[],
  options: ResolvedOptions
): Map<string, CanvasBounds> {
  const ordered = sortable(nodes);
  const columns =
    options.columns || Math.max(1, Math.ceil(Math.sqrt(ordered.length)));
  const columnWidths = Array.from({ length: columns }, () => 0);
  const rowHeights: number[] = [];
  for (const [index, node] of ordered.entries()) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    columnWidths[column] = Math.max(columnWidths[column], node.bounds.w);
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, node.bounds.h);
  }
  const columnX: number[] = [];
  const rowY: number[] = [];
  let x = options.origin.x;
  for (const width of columnWidths) {
    columnX.push(x);
    x += width + options.siblingGap;
  }
  let y = options.origin.y;
  for (const height of rowHeights) {
    rowY.push(y);
    y += height + options.siblingGap;
  }
  const result = new Map<string, CanvasBounds>();
  for (const [index, node] of ordered.entries()) {
    result.set(node.id, {
      ...node.bounds,
      x: columnX[index % columns],
      y: rowY[Math.floor(index / columns)],
    });
  }
  return result;
}

interface Graph {
  readonly layers: readonly (readonly CanvasNode[])[];
  readonly diagnostics: readonly CanvasDiagnostic[];
}

function buildLayers(nodes: readonly CanvasNode[]): Graph {
  const required = <K, V>(values: ReadonlyMap<K, V>, key: K): V => {
    const value = values.get(key);
    if (value === undefined)
      throw new Error('The canvas graph contains an unresolved identity.');
    return value;
  };
  const participants = sortable(
    nodes.filter(node => node.kind !== 'connector')
  );
  const byId = new Map(participants.map(node => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  for (const node of participants) {
    outgoing.set(node.id, []);
  }
  const diagnostics: CanvasDiagnostic[] = [];
  for (const connector of nodes.filter(node => node.kind === 'connector')) {
    if (!connector.sourceId || !connector.targetId) continue;
    if (!byId.has(connector.sourceId) || !byId.has(connector.targetId)) {
      diagnostics.push({
        code: 'CONSTRAINT_CONFLICT',
        severity: 'warning',
        message:
          'Un connector apunta a un nodo que no puede participar en el layout.',
        affectedIds: [connector.id],
        recoverable: true,
      });
      continue;
    }
    outgoing.get(connector.sourceId)?.push(connector.targetId);
  }
  // Condense strongly connected components before assigning levels. A
  // feedback edge should remain editable without collapsing an entire process
  // into an arbitrary first column.
  let serial = 0;
  const discovery = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: CanvasNode[][] = [];
  const visit = (id: string) => {
    discovery.set(id, serial);
    low.set(id, serial++);
    stack.push(id);
    onStack.add(id);
    for (const next of outgoing.get(id) ?? []) {
      if (!discovery.has(next)) {
        visit(next);
        low.set(id, Math.min(required(low, id), required(low, next)));
      } else if (onStack.has(next))
        low.set(id, Math.min(required(low, id), required(discovery, next)));
    }
    if (low.get(id) !== discovery.get(id)) return;
    const members: CanvasNode[] = [];
    let next: string;
    do {
      const top = stack.pop();
      if (top === undefined)
        throw new Error('Canvas graph traversal is inconsistent.');
      next = top;
      onStack.delete(next);
      members.push(required(byId, next));
    } while (next !== id);
    components.push(sortable(members));
  };
  participants.forEach(node => {
    if (!discovery.has(node.id)) visit(node.id);
  });
  const componentById = new Map(
    components.flatMap((component, index) =>
      component.map(node => [node.id, index] as const)
    )
  );
  const successors = components.map(() => new Set<number>());
  const indegrees = components.map(() => 0);
  for (const [id, targets] of outgoing)
    for (const target of targets) {
      const from = required(componentById, id),
        to = required(componentById, target);
      if (from !== to && !successors[from].has(to)) {
        successors[from].add(to);
        indegrees[to]++;
      }
    }
  const componentLevels = components.map(() => 0);
  const queue = components
    .map((_, index) => index)
    .filter(index => indegrees[index] === 0);
  for (const index of queue) {
    for (const target of successors[index]) {
      componentLevels[target] = Math.max(
        componentLevels[target],
        componentLevels[index] + components[index].length
      );
      if (--indegrees[target] === 0) queue.push(target);
    }
  }
  const level = new Map<string, number>();
  components.forEach((component, index) => {
    component.forEach((node, offset) =>
      level.set(node.id, componentLevels[index] + offset)
    );
    if (component.length > 1)
      diagnostics.push({
        code: 'CONSTRAINT_CONFLICT',
        severity: 'info',
        message:
          'Se conservó el ciclo con una ruta de retorno y orden de lectura estable.',
        affectedIds: component.map(node => node.id),
      });
  });
  const layers = new Map<number, CanvasNode[]>();
  for (const node of participants) {
    const index = level.get(node.id) ?? 0;
    const layer = layers.get(index) ?? [];
    layer.push(node);
    layers.set(index, layer);
  }
  return {
    layers: [...layers.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, layer]) => sortable(layer)),
    diagnostics,
  };
}

function layoutFlow(
  nodes: readonly CanvasNode[],
  options: ResolvedOptions
): {
  positions: Map<string, CanvasBounds>;
  diagnostics: readonly CanvasDiagnostic[];
} {
  const graph = buildLayers(nodes);
  const positions = new Map<string, CanvasBounds>();
  let primary =
    options.direction === 'left-to-right' ? options.origin.x : options.origin.y;
  for (const layer of graph.layers) {
    let secondary =
      options.direction === 'left-to-right'
        ? options.origin.y
        : options.origin.x;
    let layerPrimarySize = 0;
    for (const node of layer) {
      const bounds =
        options.direction === 'left-to-right'
          ? { ...node.bounds, x: primary, y: secondary }
          : { ...node.bounds, x: secondary, y: primary };
      positions.set(node.id, bounds);
      secondary +=
        (options.direction === 'left-to-right' ? bounds.h : bounds.w) +
        options.siblingGap;
      layerPrimarySize = Math.max(
        layerPrimarySize,
        options.direction === 'left-to-right' ? bounds.w : bounds.h
      );
    }
    primary += layerPrimarySize + options.levelGap;
  }
  return { positions, diagnostics: graph.diagnostics };
}

/**
 * Deterministic, DOM-free placement. The function does not mutate input nodes,
 * and preserves explicit design order followed by spatial reading order.
 */
export function layoutCanvas(input: CanvasLayoutInput): CanvasLayoutResult {
  const options = resolveOptions(input.options);
  const diagnostics: CanvasDiagnostic[] = [];
  const invalid = input.nodes.filter(node => !isValidBounds(node.bounds));
  if (invalid.length > 0) {
    diagnostics.push({
      code: 'INVALID_PLAN',
      severity: 'error',
      message: 'Todos los bounds deben ser finitos y tener tamaño positivo.',
      affectedIds: invalid.map(node => node.id),
      recoverable: true,
    });
    return { nodes: [...input.nodes], diagnostics, options };
  }
  const scopedIds = input.scope?.ids ? new Set(input.scope.ids) : undefined;
  const movable = input.nodes.filter(node => isMovable(node, scopedIds));
  let positioned: Map<string, CanvasBounds>;
  if (options.mode === 'row') positioned = layoutLine(movable, options, true);
  else if (options.mode === 'column')
    positioned = layoutLine(movable, options, false);
  else if (options.mode === 'grid') positioned = layoutGrid(movable, options);
  else {
    const flow = layoutFlow(input.nodes, options);
    positioned = new Map(
      [...flow.positions].filter(([id]) => movable.some(node => node.id === id))
    );
    diagnostics.push(...flow.diagnostics);
  }
  const result = input.nodes.map(node => {
    const bounds = positioned.get(node.id);
    return bounds ? replaceBounds(node, bounds) : node;
  });
  const fixed = input.nodes.filter(
    node =>
      node.layout === 'fixed' ||
      node.layout === 'preserve' ||
      (scopedIds && !scopedIds.has(node.id))
  );
  for (const node of result.filter(node => positioned.has(node.id))) {
    for (const obstacle of fixed) {
      if (
        node.id !== obstacle.id &&
        boundsOverlap(node.bounds, obstacle.bounds)
      ) {
        diagnostics.push({
          code: 'CONSTRAINT_CONFLICT',
          severity: 'error',
          message:
            'El layout propuesto invade un nodo fijo o fuera del ámbito.',
          affectedIds: [node.id, obstacle.id],
          recoverable: true,
        });
      }
    }
  }
  return { nodes: result, diagnostics, options };
}

export const CANVAS_DENSITY_GAPS = DENSITY_GAPS;
