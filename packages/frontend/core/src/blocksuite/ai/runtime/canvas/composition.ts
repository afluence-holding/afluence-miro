import {
  type CanvasBounds,
  type CanvasDiagnostic,
  type CanvasLayoutOptions,
  type CanvasNode,
  type CanvasScope,
  layoutCanvas,
} from '@affine/realtime/canvas';

const INLINE_BLOCKS = new Set([
  'affine:paragraph',
  'affine:list',
  'affine:code',
  'affine:divider',
  'affine:latex',
  'affine:callout',
  'affine:table',
  'affine:database',
  'affine:data-view',
]);
export function isSpatialCanvasNode(node: CanvasNode) {
  return !(
    node.kind.startsWith('block:') && INLINE_BLOCKS.has(node.kind.slice(6))
  );
}
const padding = { compact: 40, normal: 48, ample: 64 };
const groupGap = { compact: 96, normal: 128, ample: 160 };
const contains = (a: CanvasBounds, b: CanvasBounds) =>
  b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;

/** Compose actual native containers bottom-up, then place sibling clusters.
 * Children preserve their local arrangement when a container moves. Explicit
 * fixed/preserve nodes and nodes outside the requested scope never move.
 */
export function composeCanvas(
  nodes: readonly CanvasNode[],
  options: CanvasLayoutOptions,
  scope: CanvasScope = {}
) {
  const byId = new Map(nodes.map(node => [node.id, structuredClone(node)]));
  const diagnostics: CanvasDiagnostic[] = [];
  const scoped = scope.ids ? new Set(scope.ids) : undefined;
  const movable = (node: CanvasNode) =>
    node.layout !== 'fixed' &&
    node.layout !== 'preserve' &&
    (!scoped || scoped.has(node.id)) &&
    (!scope.bounds || contains(scope.bounds, node.bounds));
  const children = (id?: string) =>
    [...byId.values()].filter(
      node =>
        isSpatialCanvasNode(node) &&
        (id === undefined
          ? !node.parentId || !byId.has(node.parentId)
          : node.parentId === id)
    );
  const isContainer = (node: CanvasNode) =>
    node.kind === 'frame' || node.kind === 'group';
  const descendants = (id: string, seen = new Set<string>()): CanvasNode[] => {
    if (seen.has(id))
      throw new Error('Canvas container hierarchy contains a cycle.');
    seen.add(id);
    return children(id).flatMap(node => [
      node,
      ...descendants(node.id, new Set(seen)),
    ]);
  };
  const mode =
    options.grammar === 'timeline' || options.grammar === 'presentation'
      ? 'row'
      : ['workshop', 'matrix', 'board'].includes(options.grammar ?? '')
        ? 'grid'
        : options.mode;
  const arrange = (
    siblings: CanvasNode[],
    origin: { x: number; y: number },
    clusters = false
  ) => {
    const relevant = siblings.filter(node => node.kind !== 'connector');
    const edges = [...byId.values()].filter(
      node =>
        node.kind === 'connector' &&
        relevant.some(n => n.id === node.sourceId) &&
        relevant.some(n => n.id === node.targetId)
    );
    const locked = relevant.map(node => ({
      ...node,
      ...(!movable(node) ||
      (isContainer(node) && descendants(node.id).some(child => !movable(child)))
        ? { layout: 'fixed' as const }
        : {}),
    }));
    const result = layoutCanvas({
      nodes: [...locked, ...edges],
      options: {
        ...options,
        mode,
        origin,
        ...(clusters && options.siblingGap === undefined
          ? { siblingGap: groupGap[options.density ?? 'normal'] }
          : {}),
      },
      scope: { ids: relevant.filter(movable).map(node => node.id) },
    });
    diagnostics.push(...result.diagnostics);
    for (const positioned of result.nodes) {
      const original = byId.get(positioned.id);
      if (!original)
        throw new Error('Layout returned an unknown canvas identity.');
      if (positioned.kind === 'connector' || !movable(original)) continue;
      const dx = positioned.bounds.x - original.bounds.x,
        dy = positioned.bounds.y - original.bounds.y;
      if (isContainer(original) && (dx || dy)) {
        for (const child of descendants(original.id)) {
          if (!movable(child)) continue;
          byId.set(child.id, {
            ...child,
            bounds: {
              ...child.bounds,
              x: child.bounds.x + dx,
              y: child.bounds.y + dy,
            },
          });
        }
      }
      byId.set(original.id, { ...original, bounds: positioned.bounds });
    }
  };
  const visited = new Set<string>();
  const composeContainer = (
    container: CanvasNode,
    chain = new Set<string>()
  ) => {
    if (chain.has(container.id))
      throw new Error('Canvas container hierarchy contains a cycle.');
    if (visited.has(container.id)) return;
    const next = new Set(chain).add(container.id);
    children(container.id)
      .filter(isContainer)
      .forEach(child => composeContainer(child, next));
    const p = padding[options.density ?? 'normal'];
    const title = container.kind === 'frame' ? 40 : 24;
    arrange(children(container.id), {
      x: container.bounds.x + p,
      y: container.bounds.y + p + title,
    });
    const members = children(container.id).filter(
      node => node.kind !== 'connector'
    );
    if (members.length) {
      const left = Math.min(...members.map(n => n.bounds.x)) - p;
      const top = Math.min(...members.map(n => n.bounds.y)) - p - title;
      const right = Math.max(...members.map(n => n.bounds.x + n.bounds.w)) + p;
      const bottom = Math.max(...members.map(n => n.bounds.y + n.bounds.h)) + p;
      const bounds = { x: left, y: top, w: right - left, h: bottom - top };
      if (container.layout === 'auto' && movable(container))
        byId.set(container.id, { ...container, bounds });
      else if (!contains(container.bounds, bounds))
        diagnostics.push({
          code: 'CONSTRAINT_CONFLICT',
          severity: 'error',
          message:
            'Los miembros no caben con el padding requerido en el contenedor fijado.',
          affectedIds: [container.id],
        });
    }
    visited.add(container.id);
  };
  [...byId.values()]
    .filter(isContainer)
    .forEach(node => composeContainer(node));
  const roots = children();
  // Lanes are explicit user/model authoring hints; no dates or owners invented.
  if (options.grammar === 'timeline' && roots.some(node => node.design?.lane)) {
    const lanes = [...new Set(roots.map(node => node.design?.lane ?? ''))];
    let y = options.origin?.y ?? 0;
    for (const lane of lanes) {
      const members = roots.filter(node => (node.design?.lane ?? '') === lane);
      arrange(members, { x: options.origin?.x ?? 0, y });
      y +=
        Math.max(0, ...members.map(node => node.bounds.h)) +
        groupGap[options.density ?? 'normal'];
    }
    diagnostics.push({
      code: 'CONSTRAINT_CONFLICT',
      severity: 'info',
      message:
        'Timeline ordinal: el espacio representa orden, no duración temporal.',
    });
  } else
    arrange(roots, options.origin ?? { x: 0, y: 0 }, roots.some(isContainer));
  return { nodes: nodes.map(node => byId.get(node.id) ?? node), diagnostics };
}
