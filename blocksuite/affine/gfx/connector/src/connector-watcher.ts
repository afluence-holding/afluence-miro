import {
  type SurfaceBlockModel,
  type SurfaceMiddleware,
  surfaceMiddlewareExtension,
} from '@blocksuite/affine-block-surface';
import type { ConnectorElementModel } from '@blocksuite/affine-model';
import { GfxBlockElementModel, type GfxModel } from '@blocksuite/std/gfx';

import { ConnectorPathGenerator } from './connector-manager';
import { routeConnectorAroundObstacles } from './obstacle-route';

export const connectorWatcher: SurfaceMiddleware = (
  surface: SurfaceBlockModel
) => {
  const hasElementById = (id: string) =>
    surface.hasElementById(id) || surface.store.hasBlock(id);
  const elementGetter = (id: string) =>
    surface.getElementById(id) ?? (surface.store.getModelById(id) as GfxModel);
  const updateConnectorPath = (connector: ConnectorElementModel) => {
    if (
      ((connector.source?.id && hasElementById(connector.source.id)) ||
        (!connector.source?.id && connector.source?.position)) &&
      ((connector.target?.id && hasElementById(connector.target.id)) ||
        (!connector.target?.id && connector.target?.position))
    ) {
      const models = [
        ...surface.elementModels,
        ...surface.store
          .getAllModels()
          .filter(
            (model): model is GfxBlockElementModel =>
              model instanceof GfxBlockElementModel
          ),
      ];
      const route = routeConnectorAroundObstacles(
        connector,
        elementGetter,
        models
      );
      ConnectorPathGenerator.updatePath(connector, route, elementGetter);
    }
  };
  const pendingList = new Set<ConnectorElementModel>();
  let pendingFlag = false;
  const addToUpdateList = (connector: ConnectorElementModel) => {
    pendingList.add(connector);

    if (!pendingFlag) {
      pendingFlag = true;
      queueMicrotask(() => {
        pendingList.forEach(updateConnectorPath);
        pendingList.clear();
        pendingFlag = false;
      });
    }
  };
  const rerouteAvoidingObstacles = () =>
    surface.getElementsByType('connector').forEach(connector => {
      if (connector.routing === 'avoid-obstacles') addToUpdateList(connector);
    });

  const disposables = [
    surface.elementAdded.subscribe(({ id }) => {
      rerouteAvoidingObstacles();
      const element = elementGetter(id);

      if (!element) return;

      if ('type' in element && element.type === 'connector') {
        addToUpdateList(element as ConnectorElementModel);
      } else {
        surface.getConnectors(id).forEach(addToUpdateList);
      }
    }),
    surface.elementUpdated.subscribe(({ id, props }) => {
      const element = elementGetter(id);
      if (!element) return;
      if (
        (!('type' in element) || element.type !== 'connector') &&
        (props['xywh'] || props['rotate'])
      )
        rerouteAvoidingObstacles();

      if (props['xywh'] || props['rotate']) {
        surface.getConnectors(id).forEach(addToUpdateList);
      }

      if (
        'type' in element &&
        element.type === 'connector' &&
        (props['mode'] !== undefined ||
          props['routing'] !== undefined ||
          props['target'] ||
          props['source'])
      ) {
        addToUpdateList(element as ConnectorElementModel);
      }
    }),
    surface.store.slots.blockUpdated.subscribe(payload => {
      if (
        payload.type === 'add' ||
        (payload.type === 'update' && payload.props.key === 'xywh')
      ) {
        surface.getConnectors(payload.id).forEach(addToUpdateList);
        rerouteAvoidingObstacles();
      }
      if (payload.type === 'delete') rerouteAvoidingObstacles();
    }),
    surface.elementRemoved.subscribe(rerouteAvoidingObstacles),
  ];

  surface
    .getElementsByType('connector')
    .forEach(connector =>
      updateConnectorPath(connector as ConnectorElementModel)
    );

  return () => {
    pendingFlag = false;
    pendingList.clear();
    disposables.forEach(d => d.unsubscribe());
  };
};

export const connectorWatcherExtension = surfaceMiddlewareExtension(
  'connector-watcher',
  connectorWatcher
);
