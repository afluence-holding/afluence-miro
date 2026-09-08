import type {
  CanvasBounds,
  CanvasNode,
  CanvasNodeKind,
  CanvasProps,
} from '@affine/realtime/canvas';
import {
  CanvasRenderer,
  EdgelessCRUDIdentifier,
  ExportManager,
  type SurfaceBlockComponent,
} from '@blocksuite/affine/blocks/surface';
import { ConnectorMode, NoteDisplayMode } from '@blocksuite/affine/model';
import type { EditorHost } from '@blocksuite/affine/std';
import {
  GfxBlockElementModel,
  GfxControllerIdentifier,
  type GfxModel,
  GfxPrimitiveElementModel,
  isGfxGroupCompatibleModel,
  isPrimitiveModel,
} from '@blocksuite/affine/std/gfx';
import { Text } from '@blocksuite/affine/store';
import { Bound } from '@blocksuite/global/gfx';
import * as Y from 'yjs';

import {
  createNativeBlock,
  deleteNativeBlock,
  getNativeBlockCapabilities,
  type NativeBlockLocalParent,
  type NativeBlockSnapshot,
  snapshotNativeBlock,
  updateNativeBlock,
  validateNativeBlockNode,
} from './native-blocks';
import {
  nativePrimitiveCreateProps,
  snapshotNativePrimitive,
  validateNativePrimitiveNode,
} from './native-primitives';

export interface CanvasRendererWaitOptions {
  readonly signal?: AbortSignal;
  readonly deadline?: number;
  readonly timeoutMs?: number;
}

function nextRendererFrame(signal?: AbortSignal) {
  return new Promise<void>(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (frame !== undefined) cancelAnimationFrame(frame);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, 50);
    const frame =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(finish)
        : undefined;
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/** Wait for an offscreen/native host to finish mounting its actual renderer. */
export async function waitCanvasRenderer(
  host: EditorHost,
  options: CanvasRendererWaitOptions = {}
): Promise<
  (SurfaceBlockComponent & { readonly renderer: CanvasRenderer }) | undefined
> {
  const expiresAt = Math.min(
    Date.now() + (options.timeoutMs ?? 5000),
    options.deadline ?? Number.POSITIVE_INFINITY
  );
  const gfx = host.std.get(GfxControllerIdentifier);
  await Promise.race([
    host.updateComplete.catch(() => undefined),
    nextRendererFrame(options.signal),
  ]);
  while (!options.signal?.aborted && Date.now() < expiresAt) {
    const surface = gfx.surfaceComponent as SurfaceBlockComponent | null;
    if (surface) {
      await Promise.race([
        surface.updateComplete.catch(() => undefined),
        nextRendererFrame(options.signal),
      ]);
      if (surface.renderer instanceof CanvasRenderer) {
        return surface as SurfaceBlockComponent & {
          readonly renderer: CanvasRenderer;
        };
      }
    }
    await nextRendererFrame(options.signal);
  }
  return undefined;
}

const SYSTEM_PROPS = new Set([
  'id',
  'type',
  'flavour',
  'xywh',
  'index',
  'children',
  'childElementIds',
  'source',
  'target',
]);

const EDITABLE_PROPS: Record<string, ReadonlySet<string>> = {
  shape: new Set([
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
  ]),
  text: new Set([
    'text',
    'color',
    'fontFamily',
    'fontSize',
    'fontStyle',
    'fontWeight',
    'textAlign',
    'hasMaxWidth',
    'lockedBySelf',
  ]),
  connector: new Set([
    'mode',
    'stroke',
    'strokeWidth',
    'strokeStyle',
    'roughness',
    'routing',
    'text',
    'frontEndpointStyle',
    'rearEndpointStyle',
    'lockedBySelf',
  ]),
  brush: new Set(['points', 'color', 'lineWidth', 'lockedBySelf']),
  highlighter: new Set(['points', 'color', 'lineWidth', 'lockedBySelf']),
  mindmap: new Set(['tree', 'layoutType', 'style', 'lockedBySelf']),
  group: new Set(['title', 'lockedBySelf']),
  note: new Set(['text', 'background', 'edgeless', 'lockedBySelf']),
  frame: new Set(['title', 'background', 'lockedBySelf']),
};

function jsonValue(value: unknown): unknown {
  if (
    value === undefined ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  ) {
    return undefined;
  }
  if (value === null || typeof value !== 'object') return value;
  // Store.Text deliberately exposes its reactive internals as enumerable
  // properties. Projecting those internals makes an unchanged frame title
  // look different from the string accepted by the canvas contract.
  if (value instanceof Text) return value.toString();
  if (Array.isArray(value)) {
    return value.map(jsonValue).filter(item => item !== undefined);
  }
  if ('toJSON' in value && typeof value.toJSON === 'function') {
    return jsonValue(value.toJSON());
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const normalized = jsonValue(child);
    if (normalized !== undefined) result[key] = normalized;
  }
  return result;
}

function boundsOf(model: GfxModel): CanvasBounds {
  const bound = Bound.deserialize(model.xywh);
  // Native connectors and freshly derived containers may expose a zero-width
  // or zero-height line. CanvasBounds is an area contract, so retain its world
  // origin while projecting a minimal selectable/exportable extent.
  return {
    x: bound.x,
    y: bound.y,
    w: Math.max(1, Math.abs(bound.w)),
    h: Math.max(1, Math.abs(bound.h)),
  };
}

function paintFrameTitles(
  canvas: HTMLCanvasElement,
  bounds: CanvasBounds,
  frames: readonly GfxBlockElementModel[]
) {
  const context = canvas.getContext('2d');
  if (!context) return;
  const dpr = canvas.width / (bounds.w + 100);
  if (!Number.isFinite(dpr) || dpr <= 0) return;
  context.save();
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.font = '14px Inter, sans-serif';
  context.textBaseline = 'middle';
  for (const frame of frames) {
    if (frame.flavour !== 'affine:frame') continue;
    const titleValue = (frame.props as unknown as Record<string, unknown>)
      .title;
    const title =
      typeof titleValue === 'string'
        ? titleValue.trim()
        : titleValue instanceof Text
          ? titleValue.toString().trim()
          : '';
    if (!title) continue;
    const frameBound = Bound.deserialize(frame.xywh);
    const x = frameBound.x - bounds.x + 50;
    const y = frameBound.y - bounds.y + 50 - 26;
    const width = Math.min(
      Math.max(1, frameBound.w),
      context.measureText(title).width + 8
    );
    context.fillStyle = '#ffffff';
    context.strokeStyle = '#d1d1d1';
    context.lineWidth = 1;
    context.beginPath();
    context.roundRect(x, y, width, 22, 4);
    context.fill();
    context.stroke();
    context.fillStyle = '#000000';
    context.fillText(title, x + 4, y + 11);
  }
  context.restore();
}

function publicBlockNode(snapshot: NativeBlockSnapshot): CanvasNode {
  return {
    id: snapshot.id,
    kind: snapshot.kind,
    bounds: snapshot.bounds,
    props: snapshot.props,
    ...(snapshot.parentId ? { parentId: snapshot.parentId } : {}),
  };
}

function kindOf(model: GfxModel): CanvasNodeKind {
  if (isPrimitiveModel(model)) return model.type as CanvasNodeKind;
  if (model.flavour === 'affine:note') return 'note';
  if (model.flavour === 'affine:frame') return 'frame';
  if (model.flavour === 'affine:edgeless-text') return 'text';
  return `block:${model.flavour}`;
}

function blockText(model: GfxBlockElementModel): string | undefined {
  if (model.text) return model.text.toString();
  const firstText = (
    children: readonly { text?: Text; children?: readonly unknown[] }[]
  ): string | undefined => {
    for (const child of children) {
      if (child.text) return child.text.toString();
      if (Array.isArray(child.children)) {
        const nested = firstText(
          child.children as readonly {
            text?: Text;
            children?: readonly unknown[];
          }[]
        );
        if (nested !== undefined) return nested;
      }
    }
    return undefined;
  };
  return firstText(model.children);
}

function propsOf(model: GfxModel, kind: CanvasNodeKind): CanvasProps {
  if (
    isPrimitiveModel(model) &&
    (kind === 'brush' || kind === 'highlighter' || kind === 'mindmap')
  ) {
    return snapshotNativePrimitive(model) ?? {};
  }
  const source = isPrimitiveModel(model)
    ? model.serialize()
    : (model.props as Record<string, unknown>);
  const allowed = EDITABLE_PROPS[kind] ?? new Set<string>();
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!SYSTEM_PROPS.has(key) && allowed.has(key)) {
      const normalized = jsonValue(value);
      if (normalized !== undefined) result[key] = normalized;
    }
  }
  if (model instanceof GfxBlockElementModel) {
    const text = blockText(model);
    if (text !== undefined && (kind === 'note' || kind === 'text')) {
      result.text = text;
    }
  }
  return result as CanvasProps;
}

export function projectNativeNode(model: GfxModel): CanvasNode {
  const kind = kindOf(model);
  const serialized = isPrimitiveModel(model)
    ? (model.serialize() as Record<string, unknown>)
    : (model.props as Record<string, unknown>);
  const source = serialized.source as { id?: unknown } | undefined;
  const target = serialized.target as { id?: unknown } | undefined;
  const parent = model.group;
  return {
    id: model.id,
    kind,
    bounds: boundsOf(model),
    props: propsOf(model, kind),
    ...(parent ? { parentId: parent.id } : {}),
    ...(typeof source?.id === 'string' ? { sourceId: source.id } : {}),
    ...(typeof target?.id === 'string' ? { targetId: target.id } : {}),
  };
}

export function assertEditableProps(kind: CanvasNodeKind, props: CanvasProps) {
  const allowed = EDITABLE_PROPS[kind];
  if (!allowed) {
    throw new Error(`Node kind ${kind} does not expose editable properties`);
  }
  const invalid = Object.keys(props).filter(key => !allowed.has(key));
  if (invalid.length) {
    throw new Error(
      `Properties not editable for ${kind}: ${invalid.join(', ')}`
    );
  }
}

function nativeProps(node: CanvasNode) {
  assertEditableProps(node.kind, node.props);
  const { x, y, w, h } = node.bounds;
  const props: Record<string, unknown> = {
    ...node.props,
    xywh: new Bound(x, y, w, h).serialize(),
  };
  delete props.text;
  return props;
}

const VISUALLY_GROUPABLE_NATIVE_BLOCKS = new Set<CanvasNodeKind>([
  'block:affine:image',
  'block:affine:attachment',
]);

export class NativeCanvasAdapter {
  readonly gfx;
  readonly crud;

  constructor(readonly host: EditorHost) {
    this.gfx = host.std.get(GfxControllerIdentifier);
    this.crud = host.std.get(EdgelessCRUDIdentifier);
  }

  get allNodes() {
    const gfxNodes = this.gfx.gfxElements.map(model => {
      const projected = projectNativeNode(model);
      if (!projected.kind.startsWith('block:')) return projected;
      const nativeSnapshot = snapshotNativeBlock(
        this.host.store,
        model.id,
        boundsOf(model)
      );
      const snapshot = nativeSnapshot
        ? publicBlockNode(nativeSnapshot)
        : projected;
      return model.group ? { ...snapshot, parentId: model.group.id } : snapshot;
    });
    const gfxIds = new Set(gfxNodes.map(node => node.id));
    const nested = this.host.store
      .getAllModels()
      .filter(model => !gfxIds.has(model.id))
      .map(model => {
        let ancestor = model.parent;
        while (ancestor && !gfxIds.has(ancestor.id)) ancestor = ancestor.parent;
        const bounds = ancestor
          ? gfxNodes.find(node => node.id === ancestor?.id)?.bounds
          : undefined;
        const snapshot = snapshotNativeBlock(
          this.host.store,
          model.id,
          bounds ?? { x: 0, y: 0, w: 1, h: 1 }
        );
        return snapshot ? publicBlockNode(snapshot) : undefined;
      })
      .filter((node): node is NonNullable<typeof node> => !!node);
    return [...gfxNodes, ...nested];
  }

  get blockCapabilities() {
    return getNativeBlockCapabilities(this.host.store);
  }

  get surface() {
    const surface = this.gfx.surface;
    if (!surface) throw new Error('Edgeless surface is not initialized');
    return surface;
  }

  getNode(id: string) {
    const model = this.gfx.getElementById<GfxModel>(id);
    if (model && 'xywh' in model) {
      const projected = projectNativeNode(model);
      if (!projected.kind.startsWith('block:')) return projected;
      const nativeSnapshot = snapshotNativeBlock(
        this.host.store,
        id,
        boundsOf(model)
      );
      const snapshot = nativeSnapshot
        ? publicBlockNode(nativeSnapshot)
        : projected;
      return model.group ? { ...snapshot, parentId: model.group.id } : snapshot;
    }
    const block = this.host.store.getModelById(id);
    if (!block) return undefined;
    let ancestor = block.parent;
    while (ancestor && !('xywh' in ancestor.props)) ancestor = ancestor.parent;
    const bound =
      ancestor && 'xywh' in ancestor.props
        ? Bound.deserialize(String(ancestor.props.xywh))
        : new Bound(0, 0, 1, 1);
    const snapshot = snapshotNativeBlock(this.host.store, id, {
      x: bound.x,
      y: bound.y,
      w: bound.w,
      h: bound.h,
    });
    return snapshot ? publicBlockNode(snapshot) : undefined;
  }

  getModel(id: string) {
    const model = this.gfx.getElementById<GfxModel>(id);
    return model && 'xywh' in model ? model : undefined;
  }

  /** Lossless native value used only for journal conflict detection. */
  nativeSnapshot(id: string): unknown {
    const model = this.getModel(id);
    if (model) {
      return isPrimitiveModel(model)
        ? structuredClone(model.serialize())
        : this.host.store.getTransformer().blockToSnapshot(model);
    }
    const block = this.host.store.getModelById(id);
    return block
      ? this.host.store.getTransformer().blockToSnapshot(block)
      : undefined;
  }

  create(node: CanvasNode, localParent?: NativeBlockLocalParent): string {
    const text =
      typeof node.props.text === 'string' ? node.props.text : undefined;
    switch (node.kind) {
      case 'shape':
      case 'text':
        return this.surface.addElement({
          ...nativeProps(node),
          type: node.kind,
          ...(text !== undefined ? { text } : {}),
        });
      case 'connector':
        return this.surface.addElement({
          ...nativeProps(node),
          type: 'connector',
          mode: node.props.mode ?? ConnectorMode.Orthogonal,
          routing: node.props.routing ?? 'avoid-obstacles',
          ...(text !== undefined ? { text } : {}),
          source: node.sourceId
            ? { id: node.sourceId }
            : { position: [node.bounds.x, node.bounds.y] },
          target: node.targetId
            ? { id: node.targetId }
            : {
                position: [
                  node.bounds.x + node.bounds.w,
                  node.bounds.y + node.bounds.h,
                ],
              },
        });
      case 'brush':
      case 'highlighter':
      case 'mindmap':
        return this.surface.addElement(
          nativePrimitiveCreateProps(node) as Record<string, unknown> & {
            type: string;
          }
        );
      case 'group':
        return this.surface.addElement({
          ...nativeProps(node),
          type: 'group',
          children: {},
          title: typeof node.props.title === 'string' ? node.props.title : '',
        });
      case 'frame':
        return this.host.store.addBlock(
          'affine:frame',
          {
            ...nativeProps(node),
            id: node.id,
            title: new Text(
              typeof node.props.title === 'string' ? node.props.title : ''
            ),
          },
          this.surface.id
        );
      case 'note': {
        const id = this.host.store.addBlock(
          'affine:note',
          {
            ...nativeProps(node),
            id: node.id,
            displayMode: NoteDisplayMode.EdgelessOnly,
          },
          this.host.store.root
        );
        if (text) {
          this.host.store.addBlock(
            'affine:paragraph',
            { text: new Text(text) },
            id
          );
        }
        return id;
      }
      default:
        if (node.kind.startsWith('block:')) {
          const requestedParentId = this.usesVisualParent(
            node,
            node.parentId,
            localParent
          )
            ? this.surface.id
            : node.parentId;
          // A native note is a top-level Edgeless block. Its public tool
          // example permits omitting parentId, while nested native blocks do
          // require an explicit parent.
          const parentId =
            requestedParentId ??
            (node.kind === 'block:affine:note'
              ? this.host.store.root?.id
              : undefined);
          if (!parentId)
            throw new Error(`Creation of ${node.kind} requires a parent`);
          return createNativeBlock(
            this.host.store,
            { ...node, parentId },
            parentId,
            parentId === requestedParentId ? localParent : undefined
          );
        }
        throw new Error(`Creation of ${node.kind} is not supported`);
    }
  }

  update(id: string, patch: Partial<Omit<CanvasNode, 'id' | 'kind'>>) {
    const model = this.getModel(id);
    const modelKind = model ? kindOf(model) : undefined;
    if (model && modelKind?.startsWith('block:')) {
      if (
        Object.hasOwn(patch, 'sourceId') ||
        Object.hasOwn(patch, 'targetId')
      ) {
        throw new Error(
          `Native block ${id} does not support connector endpoints`
        );
      }
      updateNativeBlock(this.host.store, id, {
        props: {
          ...patch.props,
          ...(patch.bounds
            ? {
                xywh: new Bound(
                  patch.bounds.x,
                  patch.bounds.y,
                  patch.bounds.w,
                  patch.bounds.h
                ).serialize(),
              }
            : {}),
        },
        parentId: patch.parentId,
      });
      return;
    }
    if (!model) {
      const block = this.host.store.getModelById(id);
      if (!block) throw new Error(`Element ${id} does not exist`);
      if (patch.bounds || patch.sourceId || patch.targetId) {
        throw new Error(
          `Nested block ${id} does not support canvas geometry or connectors`
        );
      }
      updateNativeBlock(this.host.store, id, {
        props: patch.props,
        parentId: patch.parentId,
      });
      return;
    }
    const kind = kindOf(model);
    const props: Record<string, unknown> = {};
    if (patch.bounds) {
      const { x, y, w, h } = patch.bounds;
      props.xywh = new Bound(x, y, w, h).serialize();
    }
    if (patch.props) {
      assertEditableProps(kind, patch.props);
      Object.assign(props, patch.props);
      if (kind === 'frame' && typeof patch.props.title === 'string') {
        props.title = new Text(patch.props.title);
      }
      if ((kind === 'note' || kind === 'text') && !isPrimitiveModel(model)) {
        const nextText = patch.props.text;
        delete props.text;
        if (typeof nextText === 'string') {
          const firstTextChild = model.children.find(
            (child: (typeof model.children)[number]) => child.text
          );
          if (firstTextChild) {
            this.host.store.updateBlock(firstTextChild, {
              text: new Text(nextText),
            });
          } else {
            this.host.store.addBlock(
              'affine:paragraph',
              { text: new Text(nextText) },
              model
            );
          }
        }
      }
    }
    if (Object.hasOwn(patch, 'sourceId')) {
      props.source = patch.sourceId
        ? { id: patch.sourceId }
        : { position: [model.x, model.y] };
    }
    if (Object.hasOwn(patch, 'targetId')) {
      props.target = patch.targetId
        ? { id: patch.targetId }
        : { position: [model.x + model.w, model.y + model.h] };
    }
    if (Object.keys(props).length) {
      if (isPrimitiveModel(model)) this.surface.updateElement(id, props);
      else this.host.store.updateBlock(model, props);
    }
    if (Object.hasOwn(patch, 'parentId')) this.setParent(id, patch.parentId);
  }

  setParent(id: string, parentId?: string) {
    const model = this.getModel(id);
    if (!model) {
      const block = this.host.store.getModelById(id);
      const parent = parentId ? this.getModel(parentId) : undefined;
      if (
        parentId &&
        parent &&
        isGfxGroupCompatibleModel(parent) &&
        (block || this.host.store.spaceDoc.getMap('blocks').has(id))
      ) {
        const children = (
          parent as GfxModel & {
            readonly children?: { set(id: string, value: boolean): unknown };
          }
        ).children;
        if (!children) {
          throw new Error(`Parent ${parentId} cannot contain native blocks`);
        }
        children.set(id, true);
        return;
      }
      throw new Error(`Element ${id} does not exist`);
    }
    const current = model.group;
    if (current?.id === parentId) return;
    if (!parentId) {
      if (current && isGfxGroupCompatibleModel(current)) {
        const removeChild = current.removeChild.bind(current);
        removeChild(model);
      }
      return;
    }
    const parent = this.getModel(parentId);
    if (!parent || !isGfxGroupCompatibleModel(parent)) {
      // Store models and the GFX container index are hydrated after the outer
      // Yjs transaction. A frame created earlier in this same canvas apply is
      // therefore already durable, but not observable through getModel yet.
      // Record its native child relation directly so the post-transaction
      // observers hydrate the exact relationship requested by the plan.
      const yParent = this.host.store.spaceDoc
        .getMap<Y.Map<unknown>>('blocks')
        .get(parentId);
      if (
        yParent instanceof Y.Map &&
        yParent.get('sys:flavour') === 'affine:frame'
      ) {
        const childElementIds = yParent.get('prop:childElementIds');
        if (!(childElementIds instanceof Y.Map)) {
          throw new Error(`Parent ${parentId} cannot contain canvas elements`);
        }
        if (current && isGfxGroupCompatibleModel(current)) {
          const removeChild = current.removeChild.bind(current);
          removeChild(model);
        }
        childElementIds.set(id, true);
        return;
      }
      throw new Error(`Parent ${parentId} is not a native canvas container`);
    }
    if (current && isGfxGroupCompatibleModel(current)) {
      const removeChild = current.removeChild.bind(current);
      removeChild(model);
    }
    parent.addChild(model);
    // `group` is a derived model relation and is refreshed after the enclosing
    // Y.Doc transaction. Runtime post-commit verification checks the requested
    // parent once BlockSuite has observed that update.
  }

  delete(id: string) {
    const model = this.getModel(id);
    if (!model) {
      deleteNativeBlock(this.host.store, id);
      return;
    }
    this.crud.deleteElements([model]);
  }

  validateNativeBlock(
    node: CanvasNode,
    parentId?: string,
    localParent?: NativeBlockLocalParent
  ) {
    const resolvedParentId =
      parentId ??
      (node.kind === 'block:affine:note'
        ? this.host.store.root?.id
        : undefined);
    if (this.usesVisualParent(node, parentId, localParent)) {
      const surfaceId = this.surface.id;
      return validateNativeBlockNode(
        this.host.store,
        { ...node, parentId: surfaceId },
        surfaceId
      );
    }
    return validateNativeBlockNode(
      this.host.store,
      { ...node, ...(resolvedParentId ? { parentId: resolvedParentId } : {}) },
      resolvedParentId,
      localParent
    );
  }

  usesVisualParent(
    node: Pick<CanvasNode, 'kind'>,
    parentId?: string,
    localParent?: NativeBlockLocalParent
  ) {
    if (
      !VISUALLY_GROUPABLE_NATIVE_BLOCKS.has(node.kind) ||
      (!parentId && !localParent)
    )
      return false;
    const parentKind =
      localParent?.kind ??
      (parentId ? this.getNode(parentId)?.kind : undefined);
    return parentKind === 'group';
  }

  validateNativePrimitive(node: CanvasNode) {
    return validateNativePrimitiveNode(node);
  }

  async render(
    bounds: CanvasBounds,
    ids?: readonly string[],
    scale = 1,
    readiness: CanvasRendererWaitOptions = {}
  ) {
    const surfaceComponent = await waitCanvasRenderer(this.host, readiness);
    if (!surfaceComponent) return undefined;
    const models = ids
      ?.map(id => this.getModel(id))
      .filter((model): model is GfxModel => !!model);
    const blocks = models?.filter(
      (model): model is GfxBlockElementModel =>
        model instanceof GfxBlockElementModel
    );
    const frameCandidates =
      blocks ??
      this.gfx.gfxElements.filter(
        (model): model is GfxBlockElementModel =>
          model instanceof GfxBlockElementModel
      );
    const elements = models?.filter(
      (model): model is GfxPrimitiveElementModel =>
        model instanceof GfxPrimitiveElementModel
    );
    // ExportManager only reads this element for the canvas background color,
    // but compact preview hosts intentionally omit the editor's scrolling
    // children container. Supply that semantic anchor for the duration of the
    // export so the native manager can still composite DOM-backed blocks.
    const rootModel = this.host.store.root;
    const rootComponent = rootModel
      ? (this.host.view.getBlock(rootModel.id) as HTMLElement | null)
      : null;
    let temporaryBackground: HTMLElement | undefined;
    if (
      rootComponent &&
      !rootComponent.querySelector('.affine-block-children-container')
    ) {
      temporaryBackground = document.createElement('div');
      temporaryBackground.className = 'affine-block-children-container';
      temporaryBackground.style.cssText =
        'position:absolute;inset:0;pointer-events:none;background:transparent;';
      rootComponent.append(temporaryBackground);
    }
    let canvas: HTMLCanvasElement | undefined;
    try {
      canvas = await this.host.std
        .get(ExportManager)
        .edgelessToCanvas(
          surfaceComponent.renderer,
          Bound.from(bounds),
          this.gfx,
          blocks,
          elements
        );
    } finally {
      temporaryBackground?.remove();
    }
    // ExportManager also composites DOM-backed blocks. A detached/minimal host
    // can lack its root background container even though the native surface
    // renderer is fully ready; preserve a real-pixel primitive render there.
    const rendered =
      canvas ??
      (!blocks?.length
        ? surfaceComponent.renderer.getCanvasByBound(
            Bound.from(bounds),
            elements
          )
        : undefined);
    if (!rendered) return undefined;
    paintFrameTitles(rendered, bounds, frameCandidates);
    if (scale !== 1) {
      const resized = document.createElement('canvas');
      resized.width = Math.max(1, Math.round(rendered.width * scale));
      resized.height = Math.max(1, Math.round(rendered.height * scale));
      resized
        .getContext('2d')
        ?.drawImage(rendered, 0, 0, resized.width, resized.height);
      return resized;
    }
    return rendered;
  }
}
