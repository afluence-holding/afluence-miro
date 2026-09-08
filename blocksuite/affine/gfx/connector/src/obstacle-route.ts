import {
  type ConnectorElementModel,
  ConnectorMode,
} from '@blocksuite/affine-model';
import {
  Bound,
  PointLocation,
  routeBetweenRectangles,
  type RouteRect,
} from '@blocksuite/global/gfx';
import type { GfxModel } from '@blocksuite/std/gfx';

/** Uses native endpoints and world bounds; frame/group bodies are containers. */
export function routeConnectorAroundObstacles(
  connector: ConnectorElementModel,
  get: (id: string) => GfxModel | null | undefined,
  models: readonly GfxModel[]
): PointLocation[] | null {
  if (
    connector.routing !== 'avoid-obstacles' ||
    connector.mode !== ConnectorMode.Orthogonal ||
    !connector.source.id ||
    !connector.target.id
  )
    return null;
  const source = get(connector.source.id),
    target = get(connector.target.id);
  if (!source || !target) return null;
  const a = Bound.deserialize(source.xywh),
    b = Bound.deserialize(target.xywh);
  const obstacles: RouteRect[] = [];
  for (const model of models) {
    if (model.id === connector.id) continue;
    const type = 'type' in model ? model.type : undefined;
    const flavour = 'flavour' in model ? model.flavour : undefined;
    if (type === 'group' || type === 'mindmap' || flavour === 'affine:frame')
      continue;
    if (type === 'connector') {
      const label = (model as ConnectorElementModel).labelXYWH;
      if (label) obstacles.push(Bound.fromXYWH(label));
      continue;
    }
    obstacles.push(model.elementBound ?? Bound.deserialize(model.xywh));
  }
  const route = routeBetweenRectangles(a, b, obstacles, {
    sourcePort: connector.source.position,
    targetPort: connector.target.position,
  });
  return route?.map(point => new PointLocation([point.x, point.y])) ?? null;
}
