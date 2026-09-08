import type { CanvasBounds, CanvasScope } from '@affine/realtime/canvas';
import {
  type SurfaceBlockModel,
  SurfaceBlockTransformer,
} from '@blocksuite/affine/blocks/surface';
import type { EditorHost } from '@blocksuite/affine/std';
import {
  GfxControllerIdentifier,
  isGfxGroupCompatibleModel,
} from '@blocksuite/affine/std/gfx';
import {
  type BlockSnapshot,
  type DocSnapshot,
  DocSnapshotSchema,
  extMimeMap,
  type Store,
  Transformer,
} from '@blocksuite/affine/store';
import { Bound } from '@blocksuite/global/gfx';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type * as Y from 'yjs';

const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_BUNDLE_ENTRIES = 1024;
const MAX_OBJECTS = 5000;

export interface NativeCanvasBundle {
  snapshot: DocSnapshot;
  assets: Map<string, Blob>;
}

export class NativeCanvasFormatError extends Error {
  constructor(
    readonly code:
      | 'INVALID_PLAN'
      | 'ASSET_MISSING'
      | 'FORMAT_LOSS'
      | 'BUDGET_EXCEEDED',
    message: string
  ) {
    super(message);
  }
}

function fail(message: string): never {
  throw new NativeCanvasFormatError('INVALID_PLAN', message);
}

export async function canvasChecksum(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new Uint8Array(bytes).buffer
  );
  return [...new Uint8Array(digest)]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('');
}

/** Limits the recursive schema parser before it sees untrusted archive JSON. */
export function validateNativeCanvasSnapshot(
  value: unknown,
  store?: Store
): DocSnapshot {
  let count = 0;
  const ids = new Set<string>();
  function walk(block: unknown, depth: number) {
    if (depth > 64 || ++count > MAX_OBJECTS)
      throw new NativeCanvasFormatError(
        'BUDGET_EXCEEDED',
        'Native canvas contains too many objects or nesting levels.'
      );
    if (!block || typeof block !== 'object' || Array.isArray(block))
      fail('Invalid native block.');
    const b = block as BlockSnapshot;
    if (typeof b.id !== 'string' || !b.id || ids.has(b.id))
      fail('Native canvas contains an empty or duplicate ID.');
    ids.add(b.id);
    if (!Array.isArray(b.children) || !b.props || typeof b.props !== 'object')
      fail('Invalid native block structure.');
    if (store) {
      const schema = store.schema.flavourSchemaMap.get(b.flavour);
      if (!schema || (b.version !== undefined && b.version > schema.version))
        fail(`Unsupported native schema version: ${b.flavour}.`);
    }
    if (b.flavour === 'affine:surface') {
      const elements = b.props.elements;
      if (!elements || typeof elements !== 'object' || Array.isArray(elements))
        fail('Native surface elements must be a map.');
      for (const [id, element] of Object.entries(elements)) {
        if (++count > MAX_OBJECTS)
          throw new NativeCanvasFormatError(
            'BUDGET_EXCEEDED',
            'Native canvas contains too many objects.'
          );
        if (
          !id ||
          ids.has(id) ||
          !element ||
          typeof element !== 'object' ||
          Array.isArray(element)
        )
          fail('Invalid or duplicate native element.');
        ids.add(id);
      }
    }
    b.children.forEach(child => walk(child, depth + 1));
  }
  if (!value || typeof value !== 'object')
    fail('Native canvas snapshot must be an object.');
  walk((value as DocSnapshot).blocks, 0);
  const snapshot = DocSnapshotSchema.parse(value);
  if (snapshot.blocks.flavour !== 'affine:page')
    fail('Native canvas requires a page root.');
  let surfaces = 0;
  walkNativeBlocks(snapshot, block => {
    if (block.flavour === 'affine:surface') surfaces++;
  });
  if (surfaces !== 1) fail('Native canvas requires exactly one surface.');
  return snapshot;
}

export function walkNativeBlocks(
  snapshot: DocSnapshot,
  visit: (block: BlockSnapshot) => void
) {
  const stack = [snapshot.blocks];
  while (stack.length) {
    const block = stack.pop();
    if (!block) break;
    visit(block);
    stack.push(...block.children.slice().reverse());
  }
}

function selectedSnapshot(host: EditorHost, scope: CanvasScope) {
  const transformer = host.store.getTransformer();
  const full = transformer.docToSnapshot(host.store);
  if (!full) fail('The native serializer could not serialize the document.');
  const snapshot = structuredClone(full);
  if (!scope.ids && !scope.bounds) return snapshot;
  const gfx = host.std.get(GfxControllerIdentifier);
  const selected = new Set(
    scope.ids ??
      gfx.gfxElements
        .filter(model => {
          const region = scope.bounds;
          if (!region) return false;
          const b = Bound.deserialize(model.xywh);
          return (
            b.x < region.x + region.w &&
            b.maxX > region.x &&
            b.y < region.y + region.h &&
            b.maxY > region.y
          );
        })
        .map(model => model.id)
  );
  if (!selected.size) fail('The native export scope is empty.');
  for (const id of selected) {
    const model = gfx.getElementById(id);
    if (model && isGfxGroupCompatibleModel(model))
      model.childElements.forEach(child => selected.add(child.id));
  }
  function includeChildren(block: BlockSnapshot, included = false) {
    const include = included || selected.has(block.id);
    if (include) selected.add(block.id);
    block.children.forEach(child => includeChildren(child, include));
  }
  includeChildren(snapshot.blocks);
  walkNativeBlocks(snapshot, block => {
    if (block.flavour !== 'affine:surface') return;
    const elements = block.props.elements as Record<
      string,
      Record<string, unknown>
    >;
    for (const [id, element] of Object.entries(elements)) {
      if (element.type !== 'connector') continue;
      const source = element.source as { id?: string } | undefined;
      const target = element.target as { id?: string } | undefined;
      if (
        scope.includeIncidentConnectors &&
        source?.id &&
        target?.id &&
        selected.has(source.id) &&
        selected.has(target.id)
      )
        selected.add(id);
      if (
        selected.has(id) &&
        ((source?.id && !selected.has(source.id)) ||
          (target?.id && !selected.has(target.id)))
      ) {
        throw new NativeCanvasFormatError(
          'FORMAT_LOSS',
          'A selected connector points outside the export scope. Include its endpoints or exclude it.'
        );
      }
    }
    block.props.elements = Object.fromEntries(
      Object.entries(elements).filter(([id]) => selected.has(id))
    );
  });
  function prune(block: BlockSnapshot): BlockSnapshot | undefined {
    const children = block.children
      .map(prune)
      .filter((child): child is BlockSnapshot => !!child);
    return selected.has(block.id) ||
      children.length ||
      block.flavour === 'affine:page' ||
      block.flavour === 'affine:surface'
      ? { ...block, children }
      : undefined;
  }
  const selectedRoot = prune(snapshot.blocks);
  if (!selectedRoot) fail('The selected native snapshot has no page root.');
  snapshot.blocks = selectedRoot;
  return snapshot;
}

function referencedAssets(snapshot: DocSnapshot) {
  const ids = new Set<string>();
  walkNativeBlocks(snapshot, block => {
    if (
      (block.flavour === 'affine:image' ||
        block.flavour === 'affine:attachment') &&
      typeof block.props.sourceId === 'string' &&
      block.props.sourceId
    )
      ids.add(block.props.sourceId);
  });
  return ids;
}

/** A real .bs.zip: native snapshots and every referenced binary asset. */
export async function exportNativeCanvas(
  host: EditorHost,
  scope: CanvasScope = {},
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const snapshot = selectedSnapshot(host, scope);
  const assets = new Map<string, Blob>();
  for (const id of referencedAssets(snapshot)) {
    signal?.throwIfAborted();
    const blob = await host.store.workspace.blobSync.get(id);
    if (!blob)
      throw new NativeCanvasFormatError(
        'ASSET_MISSING',
        `The native export is missing asset ${id}.`
      );
    assets.set(id, blob);
  }
  return packNativeCanvasBundle({ snapshot, assets }, signal);
}

/** Packs prepared in-memory assets without committing them to the workspace. */
export async function packNativeCanvasBundle(
  bundle: NativeCanvasBundle,
  signal?: AbortSignal
) {
  const snapshot = validateNativeCanvasSnapshot(bundle.snapshot);
  const files: Record<string, Uint8Array> = {
    'canvas.snapshot.json': strToU8(JSON.stringify(snapshot)),
  };
  const manifest: Record<
    string,
    { path: string; mime: string; sha256: string }
  > = {};
  let total = files['canvas.snapshot.json'].length;
  if (total > MAX_SNAPSHOT_BYTES)
    throw new NativeCanvasFormatError(
      'BUDGET_EXCEEDED',
      'Native snapshot exceeds 8 MiB.'
    );
  for (const id of referencedAssets(snapshot)) {
    signal?.throwIfAborted();
    const blob = bundle.assets.get(id);
    if (!blob)
      throw new NativeCanvasFormatError(
        'ASSET_MISSING',
        `The native export is missing asset ${id}.`
      );
    const bytes = new Uint8Array(await blob.arrayBuffer());
    total += bytes.length;
    if (total > MAX_BUNDLE_BYTES)
      throw new NativeCanvasFormatError(
        'BUDGET_EXCEEDED',
        'Native export exceeds the bundle size limit.'
      );
    const extension =
      [...extMimeMap.entries()].find(([, mime]) => mime === blob.type)?.[0] ??
      'bin';
    const path = `assets/${encodeURIComponent(id)}.${extension}`;
    files[path] = bytes;
    manifest[id] = {
      path,
      mime: blob.type,
      sha256: await canvasChecksum(bytes),
    };
  }
  files['canvas-manifest.json'] = strToU8(
    JSON.stringify({ version: 1, assets: manifest })
  );
  if (
    Object.keys(files).length > MAX_BUNDLE_ENTRIES ||
    total + files['canvas-manifest.json'].length > MAX_BUNDLE_BYTES
  )
    throw new NativeCanvasFormatError(
      'BUDGET_EXCEEDED',
      'Native bundle exceeds archive limits.'
    );
  const bytes = zipSync(files, { level: 6 });
  if (bytes.length > MAX_BUNDLE_BYTES)
    throw new NativeCanvasFormatError(
      'BUDGET_EXCEEDED',
      'Compressed native bundle exceeds 64 MiB.'
    );
  return {
    blob: new Blob([new Uint8Array(bytes).buffer], { type: 'application/zip' }),
    fileName: 'canvas.bs.zip',
    checksum: await canvasChecksum(bytes),
    snapshot,
  };
}

/** Prepares data only. It neither registers a document nor writes assets. */
export async function readNativeCanvas(
  input: Blob | DocSnapshot,
  store?: Store,
  signal?: AbortSignal
): Promise<NativeCanvasBundle> {
  signal?.throwIfAborted();
  if (!(input instanceof Blob)) {
    const snapshot = validateNativeCanvasSnapshot(
      structuredClone(input),
      store
    );
    if (referencedAssets(snapshot).size)
      throw new NativeCanvasFormatError(
        'ASSET_MISSING',
        'Use a native bundle with assets for image or attachment snapshots.'
      );
    return { snapshot, assets: new Map() };
  }
  if (input.size > MAX_BUNDLE_BYTES)
    throw new NativeCanvasFormatError(
      'BUDGET_EXCEEDED',
      'Native bundle is too large.'
    );
  let total = 0,
    count = 0;
  const files = unzipSync(new Uint8Array(await input.arrayBuffer()), {
    filter: entry => {
      if (
        ++count > MAX_BUNDLE_ENTRIES ||
        (total += entry.originalSize) > MAX_BUNDLE_BYTES
      )
        throw new NativeCanvasFormatError(
          'BUDGET_EXCEEDED',
          'Expanded native bundle exceeds its limits.'
        );
      if (
        entry.name.startsWith('/') ||
        entry.name.split(/[\\/]/).some(part => part === '..')
      )
        fail('Unsafe archive entry path.');
      return (
        !entry.name.includes('__MACOSX') && !entry.name.endsWith('.DS_Store')
      );
    },
  });
  const snapshots = Object.entries(files).filter(([name]) =>
    name.endsWith('.snapshot.json')
  );
  if (snapshots.length !== 1) fail('Import one native document at a time.');
  if (snapshots[0][1].length > MAX_SNAPSHOT_BYTES)
    throw new NativeCanvasFormatError(
      'BUDGET_EXCEEDED',
      'Native snapshot is too large.'
    );
  const snapshot = validateNativeCanvasSnapshot(
    JSON.parse(strFromU8(snapshots[0][1])),
    store
  );
  const manifest = files['canvas-manifest.json']
    ? (JSON.parse(strFromU8(files['canvas-manifest.json'])) as {
        version: number;
        assets: Record<string, { path: string; mime: string; sha256: string }>;
      })
    : undefined;
  if (
    manifest &&
    (manifest.version !== 1 ||
      !manifest.assets ||
      typeof manifest.assets !== 'object')
  )
    fail('Unsupported native bundle manifest.');
  const assets = new Map<string, Blob>();
  for (const id of referencedAssets(snapshot)) {
    signal?.throwIfAborted();
    const entry = manifest?.assets[id];
    const path =
      entry?.path ??
      Object.keys(files).find(
        path =>
          path.startsWith('assets/') &&
          path.slice(7).replace(/\.[^.]+$/, '') === id
      );
    const bytes = path ? files[path] : undefined;
    if (!bytes)
      throw new NativeCanvasFormatError(
        'ASSET_MISSING',
        `Native bundle is missing asset ${id}.`
      );
    if (entry && (await canvasChecksum(bytes)) !== entry.sha256)
      fail(`Asset checksum mismatch: ${id}.`);
    const mime =
      entry?.mime ??
      extMimeMap.get(path?.split('.').at(-1) ?? '') ??
      'application/octet-stream';
    assets.set(id, new Blob([new Uint8Array(bytes).buffer], { type: mime }));
  }
  return { snapshot, assets };
}

/** Remaps only internal identities. External document references stay intact. */
export function remapNativeCanvas(
  snapshot: DocSnapshot,
  allocateId: (sourceId: string, flavour: string) => string,
  placement?: CanvasBounds
) {
  const idMap = new Map<string, string>();
  const output = structuredClone(snapshot);
  walkNativeBlocks(output, block => {
    idMap.set(block.id, allocateId(block.id, block.flavour));
    if (block.flavour === 'affine:surface')
      Object.entries(
        block.props.elements as Record<string, { type: string }>
      ).forEach(([id, element]) => idMap.set(id, allocateId(id, element.type)));
  });
  const mapId = (id: string) => idMap.get(id) ?? id;
  function references(value: unknown, key?: string): unknown {
    if (
      typeof value === 'string' &&
      ['id', 'reference', 'parent', 'sourceId', 'targetId'].includes(key ?? '')
    )
      return mapId(value);
    if (Array.isArray(value)) return value.map(child => references(child));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([name, child]) => [
          idMap.has(name) ? mapId(name) : name,
          references(child, name),
        ])
      );
    return value;
  }
  walkNativeBlocks(output, block => {
    block.id = mapId(block.id);
    // Asset sourceId and external pageId are not canvas identities.
    const sourceId = block.props.sourceId;
    block.props = references(block.props) as Record<string, unknown>;
    if (sourceId !== undefined) block.props.sourceId = sourceId;
  });
  if (placement) {
    const boxes: Bound[] = [];
    const collect = (props: Record<string, unknown>) => {
      if (typeof props.xywh === 'string')
        boxes.push(Bound.deserialize(props.xywh));
    };
    walkNativeBlocks(output, block => {
      collect(block.props);
      if (block.flavour === 'affine:surface')
        Object.values(
          block.props.elements as Record<string, Record<string, unknown>>
        ).forEach(collect);
    });
    const dx = placement.x - Math.min(...boxes.map(box => box.x)),
      dy = placement.y - Math.min(...boxes.map(box => box.y));
    if (Number.isFinite(dx) && Number.isFinite(dy)) {
      const shift = (props: Record<string, unknown>) => {
        if (typeof props.xywh === 'string') {
          const b = Bound.deserialize(props.xywh);
          props.xywh = new Bound(b.x + dx, b.y + dy, b.w, b.h).serialize();
        }
        if (props.type === 'connector') {
          for (const end of ['source', 'target']) {
            const endpoint = props[end] as
              | { id?: string; position?: number[] }
              | undefined;
            if (
              endpoint &&
              !endpoint.id &&
              Array.isArray(endpoint.position) &&
              endpoint.position.length === 2
            )
              endpoint.position = [
                endpoint.position[0] + dx,
                endpoint.position[1] + dy,
              ];
          }
        }
      };
      walkNativeBlocks(output, block => {
        shift(block.props);
        if (block.flavour === 'affine:surface')
          Object.values(
            block.props.elements as Record<string, Record<string, unknown>>
          ).forEach(shift);
      });
    }
  }
  return { snapshot: output, idMap: Object.fromEntries(idMap) };
}

export type NativeCanvasInsertEntry =
  | {
      type: 'block';
      id: string;
      parentId: string;
      flavour: string;
      props: Record<string, unknown>;
      snapshot: BlockSnapshot;
    }
  | {
      type: 'element';
      id: string;
      surfaceId: string;
      value: Y.Map<unknown>;
      snapshot: Record<string, unknown>;
    };

/** Converts every native value before the executor opens its journal transaction.
 * Converters can write assets only into this staging map, never into the workspace.
 * The returned Yjs values are single-use; recreate them from snapshot for retries.
 */
export async function prepareNativeCanvasInsert(
  store: Store,
  bundle: NativeCanvasBundle,
  options: {
    allocateId: (sourceId: string, flavour: string) => string;
    placement?: CanvasBounds;
    signal?: AbortSignal;
    /** Only a durable import job may list IDs it committed in earlier batches. */
    allowExistingIds?: ReadonlySet<string>;
  }
) {
  const source = validateNativeCanvasSnapshot(bundle.snapshot, store);
  const root = store.root;
  const surface = store.getModelsByFlavour('affine:surface')[0] as
    | SurfaceBlockModel
    | undefined;
  if (!root || !surface)
    fail('Native import requires an initialized document with a surface.');
  const surfaceId = surface.id;
  const remapped = remapNativeCanvas(
    source,
    (id, flavour) =>
      flavour === 'affine:page'
        ? root.id
        : flavour === 'affine:surface'
          ? surface.id
          : options.allocateId(id, flavour),
    options.placement
  );
  const ids = Object.values(remapped.idMap);
  if (new Set(ids).size !== ids.length)
    fail('Native import allocated duplicate IDs.');
  for (const id of ids) {
    const exists =
      id !== root.id &&
      id !== surface.id &&
      (store.hasBlock(id) || surface.getElementById(id));
    if (exists && !options.allowExistingIds?.has(id))
      fail(`Native import ID already exists: ${id}.`);
  }
  const assets = new Map(bundle.assets);
  const transformer = new Transformer({
    schema: store.schema,
    blobCRUD: {
      get: async id => assets.get(id) ?? null,
      set: async (id, blob) => {
        assets.set(id, blob);
        return id;
      },
      delete: async id => {
        assets.delete(id);
      },
      list: async () => [...assets.keys()],
    },
    docCRUD: {
      create: () => {
        throw new NativeCanvasFormatError(
          'INVALID_PLAN',
          'Native import converters cannot create documents.'
        );
      },
      get: () => null,
      delete: () => {
        throw new NativeCanvasFormatError(
          'INVALID_PLAN',
          'Native import converters cannot delete documents.'
        );
      },
    },
  });
  assets.forEach((blob, id) => transformer.assets.set(id, blob));
  const entries: NativeCanvasInsertEntry[] = [];
  const supportedElements = new Set([
    'shape',
    'text',
    'brush',
    'connector',
    'group',
    'mindmap',
    'highlighter',
  ]);
  const knownIds = new Set(ids);
  async function convert(block: BlockSnapshot, parent?: BlockSnapshot) {
    options.signal?.throwIfAborted();
    store.schema.validate(
      block.flavour,
      parent?.flavour,
      block.children.map(child => child.flavour)
    );
    if (block.flavour === 'affine:surface') {
      const serialized = block.props.elements as Record<
        string,
        Record<string, unknown>
      >;
      for (const [id, element] of Object.entries(serialized)) {
        if (!supportedElements.has(String(element.type)))
          fail(`Unsupported native element type: ${String(element.type)}.`);
        if (typeof element.xywh === 'string') {
          const bound: unknown = JSON.parse(element.xywh);
          if (
            !Array.isArray(bound) ||
            bound.length !== 4 ||
            !bound.every(v => typeof v === 'number' && Number.isFinite(v)) ||
            bound[2] < 0 ||
            bound[3] < 0
          )
            fail(`Invalid native element bounds: ${id}.`);
        }
        for (const name of ['source', 'target']) {
          const endpoint = element[name] as { id?: string } | undefined;
          if (endpoint?.id && !knownIds.has(endpoint.id))
            fail(`Native connector ${id} references a missing endpoint.`);
        }
      }
      const surfaceTransformer = new SurfaceBlockTransformer(new Map());
      for (const [id, value] of Object.entries(serialized))
        entries.push({
          type: 'element',
          id,
          surfaceId,
          value: surfaceTransformer.elementFromJSON(value),
          snapshot: structuredClone(value),
        });
    } else if (block.flavour !== 'affine:page') {
      const data = await transformer.snapshotToModelData(block);
      if (!data || !parent)
        fail(`Native block conversion failed: ${block.id}.`);
      entries.push({
        type: 'block',
        id: block.id,
        parentId: parent.id,
        flavour: block.flavour,
        props: data.props as Record<string, unknown>,
        snapshot: structuredClone(block),
      });
    }
    for (const child of block.children) await convert(child, block);
  }
  await convert(remapped.snapshot.blocks);
  options.signal?.throwIfAborted();
  return { ...remapped, entries, assets };
}

/** Must run inside the caller's mutation-and-journal Y.Doc transaction. */
export function insertNativeCanvasEntry(
  store: Store,
  entry: NativeCanvasInsertEntry
) {
  if (store.readonly)
    throw new NativeCanvasFormatError(
      'INVALID_PLAN',
      'Native import destination is read-only.'
    );
  if (entry.type === 'block') {
    const blocks = store.spaceDoc.getMap('blocks');
    if (blocks.has(entry.id)) fail(`Native block already exists: ${entry.id}.`);
    store.addBlock(
      entry.flavour,
      { ...entry.props, id: entry.id },
      entry.parentId
    );
    if (!blocks.has(entry.id))
      fail(`Native block insertion failed: ${entry.id}.`);
    return;
  }
  const surface = store.getModelById(
    entry.surfaceId
  ) as SurfaceBlockModel | null;
  const elements = surface?.props.elements.getValue();
  if (!elements || elements.has(entry.id))
    fail(`Native surface or element conflict: ${entry.id}.`);
  elements.set(entry.id, entry.value);
}
