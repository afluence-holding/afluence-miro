import {
  type CanvasBounds,
  type CanvasJsonValue,
  type CanvasNode,
  exportCanvasInterchange,
  importCanvasInterchange,
  validateCanvasNode,
} from '@affine/realtime/canvas';
import type { EditorHost } from '@blocksuite/affine/std';
import type {
  BlockSnapshot,
  DocSnapshot,
  Store,
} from '@blocksuite/affine/store';

import {
  canvasChecksum,
  exportNativeCanvas,
  type NativeCanvasBundle,
  NativeCanvasFormatError,
  readNativeCanvas,
  validateNativeCanvasSnapshot,
} from './native-interchange';
import { createCanvasPreviewDocument } from './preview-document';

const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_EXCALIDRAW_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
const BASE64_CHUNK_BYTES = 0x8000;
const IMAGE_MIME_BY_EXTENSION = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
} as const;

export interface NativeAssetImportInput {
  readonly blob: Blob;
  readonly name?: string;
  readonly bounds?: CanvasBounds;
}

export interface ExcalidrawImageImport {
  readonly bundle: NativeCanvasBundle;
  /** Excalidraw element id to generated native image block id. */
  readonly imageIds: Readonly<Record<string, string>>;
}

type PreparedAsset = {
  readonly blob: Blob;
  readonly sourceId: string;
  readonly id: string;
  readonly name: string;
  readonly image: boolean;
  readonly bounds: CanvasBounds;
};

function fail(code: NativeCanvasFormatError['code'], message: string): never {
  throw new NativeCanvasFormatError(code, message);
}

function validBounds(
  bounds: CanvasBounds | undefined
): CanvasBounds | undefined {
  if (!bounds) return undefined;
  if (
    ![bounds.x, bounds.y, bounds.w, bounds.h].every(Number.isFinite) ||
    bounds.w <= 0 ||
    bounds.h <= 0
  ) {
    fail(
      'INVALID_PLAN',
      'Los bounds del adjunto deben ser finitos y positivos.'
    );
  }
  return bounds;
}

function imageMime(bytes: Uint8Array): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

function dimensionsFromHeader(
  bytes: Uint8Array,
  mime: string
): { w: number; h: number } | undefined {
  const byte = (offset: number) => bytes[offset] ?? 0;
  const u16 = (offset: number) => (byte(offset) << 8) | byte(offset + 1);
  const u32 = (offset: number) =>
    byte(offset) * 0x1000000 +
    (byte(offset + 1) << 16) +
    (byte(offset + 2) << 8) +
    byte(offset + 3);
  if (
    mime === 'image/png' &&
    bytes.length >= 24 &&
    String.fromCharCode(...bytes.slice(12, 16)) === 'IHDR'
  ) {
    const w = u32(16),
      h = u32(20);
    return w > 0 && h > 0 ? { w, h } : undefined;
  }
  if (mime === 'image/jpeg') {
    for (let offset = 2; offset + 9 < bytes.length;) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = byte(offset + 1);
      const size = u16(offset + 2);
      if (size < 2 || offset + 2 + size > bytes.length) return undefined;
      if (marker >= 0xc0 && marker <= 0xc3) {
        const h = u16(offset + 5),
          w = u16(offset + 7);
        return w > 0 && h > 0 ? { w, h } : undefined;
      }
      offset += 2 + size;
    }
  }
  if (
    mime === 'image/webp' &&
    bytes.length >= 30 &&
    String.fromCharCode(...bytes.slice(12, 16)) === 'VP8X'
  ) {
    const w = 1 + byte(24) + (byte(25) << 8) + (byte(26) << 16);
    const h = 1 + byte(27) + (byte(28) << 8) + (byte(29) << 16);
    return { w, h };
  }
  return undefined;
}

async function verifiedImageDimensions(
  blob: Blob,
  bytes: Uint8Array,
  mime: string
) {
  let dimensions = dimensionsFromHeader(bytes, mime);
  if (dimensions && dimensions.w * dimensions.h > MAX_IMAGE_PIXELS)
    fail('BUDGET_EXCEEDED', 'La imagen supera el límite de 40 megapíxeles.');
  if (typeof createImageBitmap === 'function') {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch {
      fail('INVALID_PLAN', 'Los bytes de imagen no se pueden decodificar.');
    }
    try {
      dimensions = { w: bitmap.width, h: bitmap.height };
    } finally {
      bitmap.close();
    }
  }
  if (!dimensions)
    fail('INVALID_PLAN', 'No se pudieron leer las dimensiones de la imagen.');
  if (dimensions.w * dimensions.h > MAX_IMAGE_PIXELS)
    fail('BUDGET_EXCEEDED', 'La imagen supera el límite de 40 megapíxeles.');
  return dimensions;
}

async function automaticBounds(
  blob: Blob,
  bytes: Uint8Array,
  mime: string
): Promise<CanvasBounds> {
  const dimensions = await verifiedImageDimensions(blob, bytes, mime);
  const scale = Math.min(1, 640 / Math.max(dimensions.w, dimensions.h));
  return {
    x: 0,
    y: 0,
    w: Math.max(1, dimensions.w * scale),
    h: Math.max(1, dimensions.h * scale),
  };
}

function safeName(value: string | undefined, mime: string, ordinal: number) {
  const extension =
    Object.entries(IMAGE_MIME_BY_EXTENSION).find(
      ([, type]) => type === mime
    )?.[0] ?? 'bin';
  const name = value?.split(/[\\/]/).at(-1)?.trim();
  return name && name.length <= 160
    ? name
    : `asset-${ordinal + 1}.${extension}`;
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES)
    );
  }
  return btoa(binary);
}

async function prepareAsset(
  input: NativeAssetImportInput,
  ordinal: number
): Promise<PreparedAsset> {
  if (!(input.blob instanceof Blob))
    fail('INVALID_PLAN', 'El adjunto debe ser un Blob local.');
  if (input.blob.size <= 0 || input.blob.size > MAX_ASSET_BYTES)
    fail(
      'BUDGET_EXCEEDED',
      'El adjunto excede el límite de 64 MiB o está vacío.'
    );
  const bytes = new Uint8Array(await input.blob.arrayBuffer());
  const verifiedImageMime = imageMime(bytes);
  const mime =
    (verifiedImageMime ?? input.blob.type) || 'application/octet-stream';
  const blob = new Blob([bytes.buffer], { type: mime });
  const checksum = await canvasChecksum(bytes);
  const explicitBounds = validBounds(input.bounds);
  // Explicit placement never bypasses binary decoding. Otherwise a PNG magic
  // prefix could create a permanently broken native image block.
  const inferredBounds = verifiedImageMime
    ? await automaticBounds(blob, bytes, verifiedImageMime)
    : undefined;
  return {
    blob,
    sourceId: `sha256-${checksum}`,
    id: `asset-${checksum.slice(0, 20)}-${ordinal + 1}`,
    name: safeName(input.name, mime, ordinal),
    image: verifiedImageMime !== undefined,
    bounds: explicitBounds ?? inferredBounds ?? { x: 0, y: 0, w: 320, h: 120 },
  };
}

function blockVersion(store: Store, flavour: string) {
  const version = store.schema.flavourSchemaMap.get(flavour)?.version;
  if (version === undefined)
    fail('INVALID_PLAN', `El esquema ${flavour} no está registrado.`);
  return version;
}

function block(
  store: Store,
  id: string,
  flavour: string,
  props: Record<string, unknown>,
  children: BlockSnapshot[] = []
): BlockSnapshot {
  return {
    type: 'block',
    id,
    flavour,
    version: blockVersion(store, flavour),
    props,
    children,
  } as BlockSnapshot;
}

function sourceSkeleton(store: Store): {
  snapshot: DocSnapshot;
  root: BlockSnapshot;
  surface: BlockSnapshot;
} {
  const snapshot = store.getTransformer().docToSnapshot(store);
  if (!snapshot)
    fail('INVALID_PLAN', 'No se pudo serializar el documento nativo.');
  const root = structuredClone(snapshot.blocks);
  if (root.flavour !== 'affine:page')
    fail('INVALID_PLAN', 'El documento nativo no tiene raíz de página.');
  const presentSurface = root.children.find(
    child => child.flavour === 'affine:surface'
  );
  if (!presentSurface)
    fail('INVALID_PLAN', 'El documento nativo no tiene superficie.');
  const surface = structuredClone(presentSurface);
  surface.children = [];
  surface.props = { ...surface.props, elements: {} };
  root.children = [surface];
  return { snapshot, root, surface };
}

function nativeBlock(store: Store, asset: PreparedAsset): BlockSnapshot {
  const { x, y, w, h } = asset.bounds;
  const xywh = `[${x},${y},${w},${h}]`;
  return asset.image
    ? block(store, asset.id, 'affine:image', {
        sourceId: asset.sourceId,
        caption: asset.name,
        width: w,
        height: h,
        xywh,
      })
    : block(store, asset.id, 'affine:attachment', {
        sourceId: asset.sourceId,
        name: asset.name,
        size: asset.blob.size,
        type: asset.blob.type || 'application/octet-stream',
        embed: false,
        style: 'horizontalThin',
        footnoteIdentifier: null,
        xywh,
      });
}

/**
 * Produces a validated native import bundle without writing to the workspace.
 * Image selection trusts magic bytes only; a supplied MIME or filename cannot
 * turn arbitrary bytes into an image block.
 */
export async function createNativeAssetBundle(
  store: Store,
  input: NativeAssetImportInput | readonly NativeAssetImportInput[]
): Promise<NativeCanvasBundle> {
  const inputs = Array.isArray(input) ? input : [input];
  if (!inputs.length || inputs.length > 100)
    fail('BUDGET_EXCEEDED', 'Importa entre uno y cien adjuntos por operación.');
  const prepared = await Promise.all(inputs.map(prepareAsset));
  const { snapshot: sourceSnapshot, root, surface } = sourceSkeleton(store);
  const assets = new Map<string, Blob>();
  for (const asset of prepared) {
    if (
      !store.schema.safeValidate(
        asset.image ? 'affine:image' : 'affine:attachment',
        surface.flavour
      )
    ) {
      fail(
        'INVALID_PLAN',
        'La superficie no admite el bloque nativo de adjunto.'
      );
    }
    surface.children.push(nativeBlock(store, asset));
    const existing = assets.get(asset.sourceId);
    if (existing && existing.size !== asset.blob.size)
      fail('INVALID_PLAN', 'Dos adjuntos con el mismo hash no coinciden.');
    assets.set(asset.sourceId, asset.blob);
  }
  const snapshot = {
    ...structuredClone(sourceSnapshot),
    blocks: root,
  } as DocSnapshot;
  return { snapshot: validateNativeCanvasSnapshot(snapshot, store), assets };
}

function dataUrlBlob(value: string, declaredMime?: string): Blob {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match)
    fail(
      'INVALID_PLAN',
      'El archivo Excalidraw debe contener un data URL base64 local.'
    );
  const mime = match[1].toLowerCase();
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime))
    fail('INVALID_PLAN', `El MIME Excalidraw ${mime} no está permitido.`);
  if (declaredMime && declaredMime.toLowerCase() !== mime)
    fail(
      'INVALID_PLAN',
      'El MIME declarado de Excalidraw no coincide con su data URL.'
    );
  const binary = atob(match[2]);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new Blob([bytes.buffer], { type: mime });
}

/**
 * Extracts only local Excalidraw image files. The common Excalidraw codec can
 * project the supported shapes separately; this bundle supplies the image
 * blocks and their original bytes for the native import stage.
 */
export async function createExcalidrawImageBundle(
  store: Store,
  content: unknown
): Promise<ExcalidrawImageImport> {
  if (!content || typeof content !== 'object' || Array.isArray(content))
    fail('INVALID_PLAN', 'Excalidraw debe ser un objeto JSON.');
  const root = content as Record<string, unknown>;
  if (
    !Array.isArray(root.elements) ||
    !root.files ||
    typeof root.files !== 'object' ||
    Array.isArray(root.files)
  )
    fail(
      'INVALID_PLAN',
      'Excalidraw con imágenes requiere elements y files locales.'
    );
  const files = root.files as Record<string, unknown>;
  const inputs: NativeAssetImportInput[] = [];
  const imageIds: Record<string, string> = {};
  for (const element of root.elements) {
    if (!element || typeof element !== 'object' || Array.isArray(element))
      continue;
    const image = element as Record<string, unknown>;
    if (image.type !== 'image') continue;
    if (typeof image.id !== 'string' || typeof image.fileId !== 'string')
      fail('INVALID_PLAN', 'Una imagen Excalidraw requiere id y fileId.');
    const file = files[image.fileId];
    if (!file || typeof file !== 'object' || Array.isArray(file))
      fail('ASSET_MISSING', `No existe el archivo Excalidraw ${image.fileId}.`);
    const data = file as Record<string, unknown>;
    if (typeof data.dataURL !== 'string')
      fail(
        'ASSET_MISSING',
        `El archivo Excalidraw ${image.fileId} no contiene bytes locales.`
      );
    const numeric = (name: string) =>
      typeof image[name] === 'number' && Number.isFinite(image[name])
        ? (image[name] as number)
        : undefined;
    const x = numeric('x'),
      y = numeric('y'),
      w = numeric('width'),
      h = numeric('height');
    if (
      x === undefined ||
      y === undefined ||
      w === undefined ||
      h === undefined ||
      w <= 0 ||
      h <= 0
    )
      fail(
        'INVALID_PLAN',
        `Bounds inválidos para la imagen Excalidraw ${image.id}.`
      );
    inputs.push({
      blob: dataUrlBlob(
        data.dataURL,
        typeof data.mimeType === 'string' ? data.mimeType : undefined
      ),
      name: typeof data.fileName === 'string' ? data.fileName : undefined,
      bounds: { x, y, w, h },
    });
    imageIds[image.id] = ''; // Filled from the deterministic construction below.
  }
  const bundle = await createNativeAssetBundle(store, inputs);
  const blocks: BlockSnapshot[] = [];
  const visit = (item: BlockSnapshot) => {
    if (item.flavour === 'affine:image') blocks.push(item);
    item.children.forEach(visit);
  };
  visit(bundle.snapshot.blocks);
  Object.keys(imageIds).forEach((id, index) => {
    imageIds[id] = blocks[index]?.id ?? '';
  });
  if (Object.values(imageIds).some(id => !id))
    fail(
      'INVALID_PLAN',
      'No se pudieron materializar las imágenes Excalidraw.'
    );
  return { bundle, imageIds };
}

function withoutExcalImages(content: Record<string, unknown>) {
  return {
    ...content,
    // The pure codec needs every endpoint/group member to remain present.
    // Preserve an image as a temporary rectangle, then replace only its native
    // model after decoding; arrows and groups therefore keep their identities.
    elements: (content.elements as unknown[]).map(value =>
      value &&
      typeof value === 'object' &&
      (value as Record<string, unknown>).type === 'image'
        ? { ...(value as Record<string, unknown>), type: 'rectangle' }
        : value
    ),
  } as CanvasJsonValue;
}

function imageNodesFromBundle(
  bundle: NativeCanvasBundle,
  imageIds: Readonly<Record<string, string>>,
  content: Record<string, unknown>,
  surfaceId: string
): CanvasNode[] {
  const images = new Map<string, BlockSnapshot>();
  const visit = (block: BlockSnapshot) => {
    if (block.flavour === 'affine:image') images.set(block.id, block);
    block.children.forEach(visit);
  };
  visit(bundle.snapshot.blocks);
  const elementById = new Map(
    (content.elements as unknown[])
      .filter(value => value && typeof value === 'object')
      .map(value => [
        String((value as Record<string, unknown>).id),
        value as Record<string, unknown>,
      ])
  );
  return Object.entries(imageIds).map(([elementId, blockId]) => {
    const block = images.get(blockId);
    const element = elementById.get(elementId);
    if (!block || !element)
      fail('INVALID_PLAN', 'La imagen Excalidraw no se pudo proyectar.');
    const xywh =
      typeof block.props.xywh === 'string'
        ? JSON.parse(block.props.xywh)
        : undefined;
    if (!Array.isArray(xywh) || xywh.length !== 4)
      fail('INVALID_PLAN', 'Bounds nativos de imagen inválidos.');
    const groups = Array.isArray(element.groupIds) ? element.groupIds : [];
    const lastGroup = groups.at(-1);
    return {
      id: elementId,
      kind: 'block:affine:image',
      parentId:
        typeof lastGroup === 'string' ? `group:${lastGroup}` : surfaceId,
      bounds: { x: xywh[0], y: xywh[1], w: xywh[2], h: xywh[3] },
      props: {
        sourceId: block.props.sourceId as string,
        ...(typeof block.props.caption === 'string'
          ? { caption: block.props.caption }
          : {}),
      },
    } as CanvasNode;
  });
}

/**
 * Builds a single native bundle for supported Excalidraw geometry and local
 * image files. The source host is read-only throughout; mutations happen only
 * in an isolated preview workspace and are discarded before this resolves.
 */
export async function createExcalidrawBundle(
  host: EditorHost,
  content: unknown,
  signal?: AbortSignal
): Promise<NativeCanvasBundle> {
  if (!content || typeof content !== 'object' || Array.isArray(content))
    fail('INVALID_PLAN', 'Excalidraw debe ser un objeto JSON.');
  const source = content as Record<string, unknown>;
  if (!Array.isArray(source.elements))
    fail('INVALID_PLAN', 'Excalidraw requiere elements.');
  const preview = await createCanvasPreviewDocument(host, true, signal);
  try {
    const containsImages = source.elements.some(
      value =>
        value &&
        typeof value === 'object' &&
        (value as Record<string, unknown>).type === 'image'
    );
    const images = containsImages
      ? await createExcalidrawImageBundle(preview.host.store, source)
      : undefined;
    for (const [id, blob] of images?.bundle.assets ?? []) {
      signal?.throwIfAborted();
      await preview.host.store.workspace.blobSync.set(id, blob);
    }
    const decoded = importCanvasInterchange({
      format: 'excalidraw',
      content: withoutExcalImages(source),
    });
    if (!decoded.ok) fail('INVALID_PLAN', decoded.error.message);
    const surfaceId =
      preview.host.store.getModelsByFlavour('affine:surface')[0]?.id;
    if (!surfaceId)
      fail('INVALID_PLAN', 'La vista previa no tiene superficie.');
    const nativeImages = images
      ? imageNodesFromBundle(images.bundle, images.imageIds, source, surfaceId)
      : [];
    const imageIds = new Set(nativeImages.map(node => node.id));
    const nodes = [
      ...decoded.data.nodes.filter(node => !imageIds.has(node.id)),
      ...nativeImages,
    ];
    for (const node of nodes) {
      const nodeValidation = validateCanvasNode(node);
      if (!nodeValidation.ok)
        fail(
          'INVALID_PLAN',
          `La proyección Excalidraw ${node.id} es inválida: ${nodeValidation.error.message}`
        );
    }
    if (nodes.length > 100)
      fail('BUDGET_EXCEEDED', 'Excalidraw excede 100 objetos importables.');
    // Dynamic import avoids a module cycle: CanvasRuntime itself imports the
    // native interchange layer used by this helper.
    const { CanvasRuntime } = await import('./runtime');
    const runtime = new CanvasRuntime({
      host: preview.host,
      workspaceId: 'canvas-preview',
      docId: preview.host.store.id,
    });
    try {
      const validated = await runtime.execute(
        'canvas_validate',
        {
          destination: { type: 'existing', documentId: preview.host.store.id },
          baseContentRevision: runtime.getContentRevision(),
          requestedScope: { ids: nodes.map(node => node.id) },
          operations: nodes.map(node => ({ type: 'create' as const, node })),
        },
        { canWrite: true, signal }
      );
      if (!validated.ok) fail('INVALID_PLAN', validated.error.message);
      if (validated.data.plan.status !== 'ready') {
        const errors = validated.data.plan.diagnostics
          .filter(diagnostic => diagnostic.severity === 'error')
          .map(diagnostic => diagnostic.message)
          .join('; ');
        fail(
          'INVALID_PLAN',
          errors || 'La proyección Excalidraw no se pudo validar.'
        );
      }
      const applied = await runtime.execute(
        'canvas_apply',
        {
          planId: validated.data.plan.planId,
          requestId: `excalidraw-${crypto.randomUUID()}`,
        },
        { canWrite: true, signal }
      );
      if (!applied.ok || applied.data.execution !== 'applied')
        fail(
          'INVALID_PLAN',
          applied.ok
            ? `La proyección Excalidraw no se pudo aplicar íntegramente: ${applied.data.warnings.map(warning => warning.message).join('; ')}`
            : applied.error.message
        );
      const archive = await exportNativeCanvas(preview.host, {}, signal);
      return await readNativeCanvas(archive.blob, host.store, signal);
    } finally {
      runtime.dispose();
    }
  } finally {
    preview.dispose();
  }
}

/** Exports geometry through the strict common codec and embeds local image bytes. */
export async function exportExcalidrawWithAssets(
  host: EditorHost,
  nodes: readonly CanvasNode[]
): Promise<CanvasJsonValue> {
  const images = nodes.filter(node => node.kind === 'block:affine:image');
  const geometry = [
    ...nodes.filter(node => node.kind !== 'block:affine:image'),
    // Keep temporary bodies so the strict codec preserves image connections.
    ...images.map(node => ({
      ...node,
      kind: 'shape' as const,
      props: { shapeType: 'rectangle' },
    })),
  ];
  const exported = exportCanvasInterchange({
    format: 'excalidraw',
    nodes: geometry,
  });
  if (
    !exported.ok ||
    !exported.data.content ||
    typeof exported.data.content !== 'object' ||
    Array.isArray(exported.data.content)
  )
    fail(
      'INVALID_PLAN',
      exported.ok
        ? 'La exportación Excalidraw no produjo JSON.'
        : exported.error.message
    );
  const result = structuredClone(exported.data.content) as Record<
    string,
    unknown
  >;
  const elements = result.elements as CanvasJsonValue[];
  const files: Record<string, CanvasJsonValue> = {};
  let estimatedBytes = new TextEncoder().encode(JSON.stringify(result)).length;
  for (const node of images) {
    const sourceId = node.props.sourceId;
    if (typeof sourceId !== 'string' || !sourceId)
      fail('ASSET_MISSING', `La imagen ${node.id} no tiene sourceId.`);
    const blob = await host.store.workspace.blobSync.get(sourceId);
    if (!blob) fail('ASSET_MISSING', `No existe el blob ${sourceId}.`);
    const mime = imageMime(new Uint8Array(await blob.arrayBuffer()));
    if (!mime)
      fail('FORMAT_LOSS', `La imagen ${node.id} no es PNG, JPEG ni WebP.`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const fileId = `file-${node.id}`;
    const dataUrlBytes =
      `data:${mime};base64,`.length + 4 * Math.ceil(bytes.byteLength / 3);
    // Include a small JSON envelope per file. This guard happens before
    // allocating the large Base64 string, keeping exports bounded.
    if (estimatedBytes + dataUrlBytes + 256 > MAX_EXCALIDRAW_OUTPUT_BYTES)
      fail(
        'BUDGET_EXCEEDED',
        'La exportación Excalidraw con assets excede 64 MiB.'
      );
    estimatedBytes += dataUrlBytes + 256;
    files[fileId] = {
      id: fileId,
      mimeType: mime,
      dataURL: `data:${mime};base64,${base64FromBytes(bytes)}`,
    };
    const placeholder = elements.findIndex(
      value =>
        !!value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        (value as Record<string, unknown>).id === node.id
    );
    const nativeImage: CanvasJsonValue = {
      id: node.id,
      type: 'image',
      fileId,
      x: node.bounds.x,
      y: node.bounds.y,
      width: node.bounds.w,
      height: node.bounds.h,
      groupIds: node.parentId?.startsWith('group:')
        ? [node.parentId.slice(6)]
        : [],
    };
    if (placeholder >= 0) elements[placeholder] = nativeImage;
    else elements.push(nativeImage);
  }
  result.files = files;
  return result as CanvasJsonValue;
}
