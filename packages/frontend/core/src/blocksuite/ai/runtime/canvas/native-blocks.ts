import type {
  CanvasBounds,
  CanvasNode,
  CanvasProps,
} from '@affine/realtime/canvas';
import { type BlockModel, type Store, Text } from '@blocksuite/affine/store';

export type NativeBlockStatus = 'supported' | 'experimental' | 'unsupported';

export interface NativeBlockDescriptor {
  readonly flavour: string;
  readonly kind: `block:${string}`;
  readonly status: NativeBlockStatus;
  readonly props: readonly string[];
  readonly requiresAsset?: boolean;
  readonly structural?: boolean;
}

const CONTENT_PROPS = [
  'text',
  'richText',
  'type',
  'textAlign',
  'collapsed',
] as const;
const GFX_PROPS = [
  'xywh',
  'index',
  'lockedBySelf',
  'rotate',
  'width',
  'height',
] as const;

/**
 * This is an allow-list, not a second schema. `store.schema` remains the
 * authority for registered flavours and parent/child relationships.
 */
export const NATIVE_BLOCK_REGISTRY: readonly NativeBlockDescriptor[] = [
  {
    flavour: 'affine:page',
    kind: 'block:affine:page',
    status: 'unsupported',
    props: [],
    structural: true,
  },
  {
    flavour: 'affine:surface',
    kind: 'block:affine:surface',
    status: 'unsupported',
    props: [],
    structural: true,
  },
  {
    flavour: 'affine:note',
    kind: 'block:affine:note',
    status: 'supported',
    props: ['displayMode', ...GFX_PROPS],
  },
  {
    flavour: 'affine:frame',
    kind: 'block:affine:frame',
    status: 'supported',
    props: ['title', 'background', ...GFX_PROPS],
  },
  {
    flavour: 'affine:paragraph',
    kind: 'block:affine:paragraph',
    status: 'supported',
    props: CONTENT_PROPS,
  },
  {
    flavour: 'affine:list',
    kind: 'block:affine:list',
    status: 'supported',
    props: [...CONTENT_PROPS, 'checked', 'order'],
  },
  {
    flavour: 'affine:divider',
    kind: 'block:affine:divider',
    status: 'supported',
    props: [],
  },
  {
    flavour: 'affine:code',
    kind: 'block:affine:code',
    status: 'supported',
    props: [
      'text',
      'richText',
      'language',
      'wrap',
      'caption',
      'lineNumber',
      'collapsed',
    ],
  },
  {
    flavour: 'affine:latex',
    kind: 'block:affine:latex',
    status: 'supported',
    props: ['latex', ...GFX_PROPS],
  },
  {
    flavour: 'affine:callout',
    kind: 'block:affine:callout',
    status: 'supported',
    props: ['text', 'richText', 'icon', 'backgroundColorName'],
  },
  {
    flavour: 'affine:edgeless-text',
    kind: 'block:affine:edgeless-text',
    status: 'supported',
    props: [
      'text',
      'richText',
      'color',
      'fontFamily',
      'fontStyle',
      'fontWeight',
      'textAlign',
      'hasMaxWidth',
      ...GFX_PROPS,
    ],
  },
  {
    flavour: 'affine:image',
    kind: 'block:affine:image',
    status: 'experimental',
    props: ['sourceId', 'caption', ...GFX_PROPS],
    requiresAsset: true,
  },
  {
    flavour: 'affine:attachment',
    kind: 'block:affine:attachment',
    status: 'experimental',
    props: [
      'sourceId',
      'name',
      'size',
      'type',
      'caption',
      'embed',
      'style',
      'footnoteIdentifier',
      ...GFX_PROPS,
    ],
    requiresAsset: true,
  },
  {
    flavour: 'affine:bookmark',
    kind: 'block:affine:bookmark',
    status: 'experimental',
    props: [
      'url',
      'caption',
      'style',
      'title',
      'description',
      'image',
      'icon',
      'footnoteIdentifier',
      ...GFX_PROPS,
    ],
  },
  {
    flavour: 'affine:surface-ref',
    kind: 'block:affine:surface-ref',
    status: 'experimental',
    props: ['reference', 'caption', 'refFlavour'],
  },
  {
    flavour: 'affine:table',
    kind: 'block:affine:table',
    status: 'experimental',
    props: ['table', 'textAlign'],
  },
  {
    flavour: 'affine:database',
    kind: 'block:affine:database',
    status: 'experimental',
    props: ['database'],
  },
  {
    flavour: 'affine:data-view',
    kind: 'block:affine:data-view',
    status: 'experimental',
    // DataView is a separate native model, not an alias for database. Keep its
    // actual semantic state so snapshots neither invent references nor drop it.
    props: ['title', 'views', 'columns', 'cells'],
  },
  {
    flavour: 'affine:embed-youtube',
    kind: 'block:affine:embed-youtube',
    status: 'experimental',
    props: ['url', 'caption', 'style', 'title', 'description', ...GFX_PROPS],
  },
  {
    flavour: 'affine:embed-figma',
    kind: 'block:affine:embed-figma',
    status: 'experimental',
    props: ['url', 'caption', 'style', 'title', 'description', ...GFX_PROPS],
  },
  {
    flavour: 'affine:embed-github',
    kind: 'block:affine:embed-github',
    status: 'experimental',
    props: [
      'url',
      'caption',
      'style',
      'owner',
      'repo',
      'githubType',
      'githubId',
      'title',
      'description',
      ...GFX_PROPS,
    ],
  },
  {
    flavour: 'affine:embed-html',
    kind: 'block:affine:embed-html',
    status: 'experimental',
    props: ['html', 'design', 'caption', 'style', ...GFX_PROPS],
  },
  {
    flavour: 'affine:embed-linked-doc',
    kind: 'block:affine:embed-linked-doc',
    status: 'experimental',
    props: [
      'pageId',
      'caption',
      'style',
      'title',
      'description',
      'footnoteIdentifier',
      ...GFX_PROPS,
    ],
  },
  {
    flavour: 'affine:embed-synced-doc',
    kind: 'block:affine:embed-synced-doc',
    status: 'experimental',
    props: [
      'pageId',
      'caption',
      'style',
      'title',
      'description',
      'preFoldHeight',
      ...GFX_PROPS,
    ],
  },
  {
    flavour: 'affine:embed-loom',
    kind: 'block:affine:embed-loom',
    status: 'experimental',
    props: ['url', 'caption', 'style', 'title', 'description', ...GFX_PROPS],
  },
] as const;

export interface NativeBlockCapability extends NativeBlockDescriptor {
  readonly registered: boolean;
}

export interface NativeBlockValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly descriptor?: NativeBlockDescriptor;
}

/**
 * A parent declared earlier in the same plan has no Store model during
 * preflight. Its native flavour is sufficient for schema validation and keeps
 * validation side-effect free before the transaction begins.
 */
export interface NativeBlockLocalParent {
  readonly kind: CanvasNode['kind'];
  readonly flavour?: string;
}

export interface NativeBlockAssetPreparation {
  readonly hasBlob?: (sourceId: string) => Promise<boolean>;
}

export interface NativeBlockSnapshot {
  readonly id: string;
  readonly kind: `block:${string}`;
  readonly parentId?: string;
  readonly bounds: CanvasBounds;
  readonly props: CanvasProps;
  readonly children: readonly string[];
}

function descriptorForKind(kind: CanvasNode['kind']) {
  return NATIVE_BLOCK_REGISTRY.find(entry => entry.kind === kind);
}

function json(value: unknown): value is CanvasProps[string] {
  if (value === null || ['string', 'boolean'].includes(typeof value))
    return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(json);
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every(json)
  );
}

function supportedParent(
  store: Store,
  descriptor: NativeBlockDescriptor,
  parent?: BlockModel | null
) {
  return (
    !!parent && store.schema.safeValidate(descriptor.flavour, parent.flavour)
  );
}

function localParentFlavour(parent?: NativeBlockLocalParent) {
  if (parent?.flavour) return parent.flavour;
  if (parent?.kind.startsWith('block:'))
    return parent.kind.slice('block:'.length);
  // A local canvas note/frame has not acquired a Store model yet, but both are
  // native block parents with stable Affine flavours.
  if (parent?.kind === 'note') return 'affine:note';
  if (parent?.kind === 'frame') return 'affine:frame';
  return undefined;
}

function textValue(value: unknown) {
  if (typeof value !== 'string')
    throw new Error(
      'text debe ser texto plano; no se acepta delta arbitrario.'
    );
  return new Text(value);
}

function richTextValue(value: unknown) {
  if (!Array.isArray(value))
    throw new Error('richText debe ser una lista de inserts serializables.');
  const deltas = value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Error('richText contiene un delta inválido.');
    const delta = item as Record<string, unknown>;
    if (typeof delta.insert !== 'string')
      throw new Error('richText solo admite inserts de texto.');
    if (delta.attributes !== undefined && !json(delta.attributes))
      throw new Error('richText contiene atributos no serializables.');
    return {
      insert: delta.insert,
      ...(delta.attributes === undefined
        ? {}
        : { attributes: delta.attributes as Record<string, unknown> }),
    };
  });
  return new Text(deltas);
}

function semanticTable(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('table debe ser JSON semántico.');
  const source = value as Record<string, unknown>;
  if (
    !Array.isArray(source.rows) ||
    !Array.isArray(source.columns) ||
    !source.cells ||
    typeof source.cells !== 'object'
  )
    throw new Error('table requiere rows, columns y cells.');
  const rows = Object.fromEntries(
    source.rows.map((row, index) => {
      const item = row as Record<string, unknown>;
      const id = typeof item.id === 'string' ? item.id : `row-${index}`;
      return [
        id,
        {
          rowId: id,
          order: typeof item.order === 'string' ? item.order : `${index}`,
        },
      ];
    })
  );
  const columns = Object.fromEntries(
    source.columns.map((column, index) => {
      const item = column as Record<string, unknown>;
      const id = typeof item.id === 'string' ? item.id : `column-${index}`;
      return [
        id,
        {
          columnId: id,
          order: typeof item.order === 'string' ? item.order : `${index}`,
          ...(typeof item.width === 'number' ? { width: item.width } : {}),
        },
      ];
    })
  );
  const cells = Object.fromEntries(
    Object.entries(source.cells as Record<string, unknown>).map(
      ([key, cell]) => {
        const rich =
          cell && typeof cell === 'object' && !Array.isArray(cell)
            ? (cell as Record<string, unknown>).richText
            : undefined;
        return [
          key,
          {
            text:
              rich === undefined
                ? new Text(typeof cell === 'string' ? cell : '')
                : richTextValue(rich),
          },
        ];
      }
    )
  );
  return { rows, columns, cells };
}

function semanticDatabase(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('database debe ser JSON semántico.');
  const source = value as Record<string, unknown>;
  if (
    !Array.isArray(source.columns) ||
    !Array.isArray(source.views) ||
    !source.cells ||
    typeof source.cells !== 'object'
  )
    throw new Error('database requiere columns, views y cells.');
  if (!json(source.columns) || !json(source.views) || !json(source.cells))
    throw new Error('database contiene valores no serializables.');
  const title = source.title;
  const nativeTitle =
    typeof title === 'string'
      ? textValue(title)
      : title && typeof title === 'object' && !Array.isArray(title)
        ? (() => {
            const semantic = title as Record<string, unknown>;
            if (semantic.richText !== undefined)
              return richTextValue(semantic.richText);
            if (typeof semantic.text === 'string')
              return textValue(semantic.text);
            throw new Error('database.title debe ser texto o richText.');
          })()
        : textValue('');
  return {
    title: nativeTitle,
    columns: source.columns,
    views: source.views,
    cells: semanticDatabaseValue(source.cells),
  };
}

/** Converts only explicit rich-text recipe values; ordinary data stays JSON. */
function semanticDatabaseValue(value: CanvasProps[string]): unknown {
  if (Array.isArray(value)) return value.map(semanticDatabaseValue);
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, CanvasProps[string]>;
  if (source.richText !== undefined) return richTextValue(source.richText);
  return Object.fromEntries(
    Object.entries(source).map(([key, child]) => [
      key,
      semanticDatabaseValue(child),
    ])
  );
}

function snapshotValue(value: unknown): CanvasProps[string] | undefined {
  if (value instanceof Text) return value.toString();
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const items = value.map(snapshotValue);
    return items.every(item => item !== undefined) ? items : undefined;
  }
  if (value && typeof value === 'object') {
    if ('toJSON' in value && typeof value.toJSON === 'function')
      return snapshotValue(value.toJSON());
    const result: Record<string, CanvasProps[string]> = {};
    for (const [key, child] of Object.entries(value)) {
      const normalized = snapshotValue(child);
      if (normalized !== undefined) result[key] = normalized;
    }
    return result;
  }
  return undefined;
}

function snapshotTable(props: Record<string, unknown>): CanvasProps[string] {
  const rows = Object.values(
    (props.rows as Record<string, Record<string, unknown>>) ?? {}
  ).map(row => ({
    id: typeof row.rowId === 'string' ? row.rowId : '',
    ...(typeof row.order === 'string' ? { order: row.order } : {}),
  }));
  const columns = Object.values(
    (props.columns as Record<string, Record<string, unknown>>) ?? {}
  ).map(column => ({
    id: typeof column.columnId === 'string' ? column.columnId : '',
    ...(typeof column.order === 'string' ? { order: column.order } : {}),
    ...(typeof column.width === 'number' ? { width: column.width } : {}),
  }));
  const cells = Object.fromEntries(
    Object.entries(
      (props.cells as Record<string, { text?: unknown }>) ?? {}
    ).map(([key, cell]) => {
      if (cell.text instanceof Text) {
        const richText = snapshotValue(cell.text.toDelta());
        return [
          key,
          Array.isArray(richText)
            ? { text: cell.text.toString(), richText }
            : cell.text.toString(),
        ];
      }
      return [key, snapshotValue(cell.text) ?? ''];
    })
  );
  return { rows, columns, cells };
}

function snapshotSemanticValue(
  value: unknown
): CanvasProps[string] | undefined {
  if (value instanceof Text) {
    return {
      text: value.toString(),
      richText: snapshotValue(value.toDelta()) ?? [],
    };
  }
  if (Array.isArray(value)) {
    const items = value.map(snapshotSemanticValue);
    return items.every(item => item !== undefined) ? items : undefined;
  }
  if (value && typeof value === 'object') {
    if ('toJSON' in value && typeof value.toJSON === 'function')
      return snapshotSemanticValue(value.toJSON());
    const result: Record<string, CanvasProps[string]> = {};
    for (const [key, child] of Object.entries(value)) {
      const normalized = snapshotSemanticValue(child);
      if (normalized !== undefined) result[key] = normalized;
    }
    return result;
  }
  return snapshotValue(value);
}

function snapshotDatabase(props: Record<string, unknown>): CanvasProps[string] {
  return {
    title: snapshotSemanticValue(props.title) ?? { text: '', richText: [] },
    columns: snapshotSemanticValue(props.columns) ?? [],
    views: snapshotSemanticValue(props.views) ?? [],
    cells: snapshotSemanticValue(props.cells) ?? {},
  };
}

function sanitizedProps(descriptor: NativeBlockDescriptor, props: CanvasProps) {
  const invalid = Object.keys(props).filter(
    key => !descriptor.props.includes(key)
  );
  if (invalid.length)
    throw new Error(
      `Campos no admitidos para ${descriptor.flavour}: ${invalid.join(', ')}.`
    );
  if (!Object.values(props).every(json))
    throw new Error('Las propiedades deben ser JSON finito sin funciones.');
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text' || key === 'richText') continue;
    if (descriptor.flavour === 'affine:frame' && key === 'title') {
      result.title = textValue(value);
      continue;
    }
    if (key === 'table') Object.assign(result, semanticTable(value));
    else if (key === 'database') Object.assign(result, semanticDatabase(value));
    else result[key] = value;
  }
  if (props.richText !== undefined) result.text = richTextValue(props.richText);
  else if (props.text !== undefined) result.text = textValue(props.text);
  return result;
}

export function getNativeBlockCapabilities(
  store: Store
): readonly NativeBlockCapability[] {
  return NATIVE_BLOCK_REGISTRY.map(entry => ({
    ...entry,
    registered: store.schema.flavourSchemaMap.has(entry.flavour),
  }));
}

export function validateNativeBlockNode(
  store: Store,
  node: CanvasNode,
  parentId?: string,
  localParent?: NativeBlockLocalParent
): NativeBlockValidation {
  const descriptor = descriptorForKind(node.kind);
  if (!descriptor)
    return {
      ok: false,
      errors: [`${node.kind} no es un bloque Affine registrado.`],
    };
  if (descriptor.structural)
    return {
      ok: false,
      descriptor,
      errors: [
        `${descriptor.flavour} es estructural y no se crea directamente.`,
      ],
    };
  if (!store.schema.flavourSchemaMap.has(descriptor.flavour))
    return {
      ok: false,
      descriptor,
      errors: [`El esquema ${descriptor.flavour} no está registrado.`],
    };
  const parent = store.getModelById(parentId ?? node.parentId ?? '');
  const parentFlavour = parent?.flavour ?? localParentFlavour(localParent);
  if (
    !parentFlavour ||
    !store.schema.safeValidate(descriptor.flavour, parentFlavour)
  )
    return {
      ok: false,
      descriptor,
      errors: [`${descriptor.flavour} no puede ser hijo del padre indicado.`],
    };
  try {
    sanitizedProps(descriptor, node.props);
  } catch (error) {
    return {
      ok: false,
      descriptor,
      errors: [
        error instanceof Error ? error.message : 'Propiedades inválidas.',
      ],
    };
  }
  return { ok: true, descriptor, errors: [] };
}

/** Verify blob references before writes. It never uploads or fetches URLs. */
export async function prepareNativeBlockAssets(
  node: CanvasNode,
  options: NativeBlockAssetPreparation
): Promise<NativeBlockValidation> {
  const descriptor = descriptorForKind(node.kind);
  if (!descriptor?.requiresAsset) return { ok: true, descriptor, errors: [] };
  const sourceId = node.props.sourceId;
  if (typeof sourceId !== 'string' || !sourceId)
    return {
      ok: false,
      descriptor,
      errors: ['sourceId es obligatorio para este bloque.'],
    };
  if (!options.hasBlob)
    return {
      ok: false,
      descriptor,
      errors: ['No hay verificador de blobs disponible.'],
    };
  return (await options.hasBlob(sourceId))
    ? { ok: true, descriptor, errors: [] }
    : { ok: false, descriptor, errors: [`El blob ${sourceId} no existe.`] };
}

export function createNativeBlock(
  store: Store,
  node: CanvasNode,
  parentId?: string,
  localParent?: NativeBlockLocalParent
): string {
  const validation = validateNativeBlockNode(
    store,
    node,
    parentId,
    localParent
  );
  if (!validation.ok || !validation.descriptor)
    throw new Error(validation.errors.join(' '));
  const props = sanitizedProps(validation.descriptor, node.props);
  if (validation.descriptor.props.includes('xywh')) {
    props.xywh = `[${node.bounds.x},${node.bounds.y},${node.bounds.w},${node.bounds.h}]`;
  }
  const resolvedParentId = parentId ?? node.parentId;
  if (!resolvedParentId)
    throw new Error(`El bloque ${node.id} requiere un parentId.`);
  return store.addBlock(
    validation.descriptor.flavour,
    { ...props, id: node.id },
    resolvedParentId
  );
}

export function updateNativeBlock(
  store: Store,
  id: string,
  patch: Pick<Partial<CanvasNode>, 'props' | 'parentId'>
): void {
  const model = store.getModelById(id);
  if (!model) throw new Error(`No existe el bloque ${id}.`);
  const descriptor = NATIVE_BLOCK_REGISTRY.find(
    entry => entry.flavour === model.flavour
  );
  if (!descriptor || descriptor.structural)
    throw new Error(
      `${model.flavour} no admite actualización mediante canvas.`
    );
  const props = patch.props
    ? sanitizedProps(descriptor, patch.props)
    : undefined;
  let parent: BlockModel | null = null;
  if (patch.parentId !== undefined) {
    parent = store.getModelById(patch.parentId);
    if (!supportedParent(store, descriptor, parent))
      throw new Error(`${model.flavour} no puede moverse a ese padre.`);
  }
  if (props) store.updateBlock(model, props);
  if (parent) store.moveBlocks([model], parent);
}

export function deleteNativeBlock(store: Store, id: string): void {
  const model = store.getModelById(id);
  if (!model) return;
  if (model.flavour === 'affine:page' || model.flavour === 'affine:surface')
    throw new Error(
      `${model.flavour} es estructural y no se borra directamente.`
    );
  store.deleteBlock(model);
}

export function snapshotNativeBlock(
  store: Store,
  id: string,
  bounds: CanvasBounds
): NativeBlockSnapshot | undefined {
  const model = store.getModelById(id);
  if (!model) return undefined;
  const descriptor = NATIVE_BLOCK_REGISTRY.find(
    entry => entry.flavour === model.flavour
  );
  if (!descriptor) return undefined;
  const props: Record<string, CanvasProps[string]> = {};
  const source = model.props as Record<string, unknown>;
  if (descriptor.flavour === 'affine:table')
    props.table = snapshotTable(source);
  if (descriptor.flavour === 'affine:database')
    props.database = snapshotDatabase(source);
  for (const key of descriptor.props) {
    if (key === 'table' || key === 'database') continue;
    const value = source[key];
    if (key === 'text' && value instanceof Text) {
      props.text = value.toString();
      const richText = snapshotValue(value.toDelta());
      if (richText !== undefined) props.richText = richText;
    } else {
      const normalized = snapshotValue(value);
      if (normalized !== undefined) props[key] = normalized;
    }
  }
  return {
    id: model.id,
    kind: descriptor.kind,
    ...(model.parent?.id ? { parentId: model.parent.id } : {}),
    bounds,
    props,
    children: model.children.map(child => child.id),
  };
}
