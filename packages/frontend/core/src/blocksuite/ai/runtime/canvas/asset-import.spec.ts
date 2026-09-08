/** @vitest-environment happy-dom */
import {
  type SurfaceBlockModel,
  SurfaceBlockSchemaExtension,
} from '@blocksuite/affine/blocks/surface';
import {
  AttachmentBlockSchemaExtension,
  ImageBlockSchemaExtension,
  RootBlockSchemaExtension,
} from '@blocksuite/affine/model';
import { Text } from '@blocksuite/affine/store';
import { TestWorkspace } from '@blocksuite/affine/store/test';
import { describe, expect, it } from 'vitest';

import {
  createExcalidrawImageBundle,
  createNativeAssetBundle,
  exportExcalidrawWithAssets,
} from './asset-import';
import {
  insertNativeCanvasEntry,
  prepareNativeCanvasInsert,
} from './native-interchange';

function fixture() {
  const workspace = new TestWorkspace({ id: 'asset-import' });
  workspace.storeExtensions = [
    RootBlockSchemaExtension,
    SurfaceBlockSchemaExtension,
    ImageBlockSchemaExtension,
    AttachmentBlockSchemaExtension,
  ];
  workspace.meta.initialize();
  const doc = workspace.createDoc('asset-source');
  doc.load();
  const store = doc.getStore();
  const root = store.addBlock('affine:page', { title: new Text('Assets') });
  const surfaceId = store.addBlock('affine:surface', {}, root);
  return { store, surface: store.getModelById(surfaceId) as SurfaceBlockModel };
}

const png = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
  ),
  character => character.charCodeAt(0)
);

describe('importación nativa de assets', () => {
  it('clasifica por bytes, conserva el blob por SHA-256 y no muta el Store al preparar', async () => {
    const { store, surface } = fixture();
    const before = store.getTransformer().docToSnapshot(store);
    const bundle = await createNativeAssetBundle(store, {
      blob: new Blob([png.buffer], { type: 'text/plain' }),
      name: '../captura.png',
      bounds: { x: 24, y: 36, w: 480, h: 270 },
    });
    expect(store.getTransformer().docToSnapshot(store)).toEqual(before);
    const image = bundle.snapshot.blocks.children
      .find(block => block.flavour === 'affine:surface')!
      .children.find(block => block.flavour === 'affine:image')!;
    expect(image.props.sourceId).toMatch(/^sha256-[a-f0-9]{64}$/);
    expect(image.props.xywh).toBe('[24,36,480,270]');
    expect(bundle.assets.get(String(image.props.sourceId))?.type).toBe(
      'image/png'
    );

    let ordinal = 0;
    const prepared = await prepareNativeCanvasInsert(store, bundle, {
      allocateId: () => `asset-imported-${++ordinal}`,
    });
    expect(store.getTransformer().docToSnapshot(store)).toEqual(before);
    store.transact(() =>
      prepared.entries.forEach(entry => insertNativeCanvasEntry(store, entry))
    );
    const inserted = prepared.entries.find(
      entry => entry.type === 'block' && entry.flavour === 'affine:image'
    );
    expect(inserted).toBeTruthy();
    expect(store.getModelById(inserted!.id)?.flavour).toBe('affine:image');
    expect(surface.children.some(child => child.id === inserted!.id)).toBe(
      true
    );
  });

  it('convierte bytes no visuales en attachment y rechaza data URLs Excalidraw remotas', async () => {
    const { store } = fixture();
    const bundle = await createNativeAssetBundle(store, {
      blob: new Blob(['un archivo binario'], { type: 'application/pdf' }),
      name: 'evidence.pdf',
    });
    const attachment = bundle.snapshot.blocks.children
      .find(block => block.flavour === 'affine:surface')!
      .children.find(block => block.flavour === 'affine:attachment')!;
    expect(attachment.props).toMatchObject({
      name: 'evidence.pdf',
      type: 'application/pdf',
      embed: false,
    });
    await expect(
      createExcalidrawImageBundle(store, {
        elements: [
          {
            id: 'remote-image',
            type: 'image',
            fileId: 'remote',
            x: 0,
            y: 0,
            width: 10,
            height: 10,
          },
        ],
        files: { remote: { dataURL: 'https://example.test/image.png' } },
      })
    ).rejects.toThrow('data URL base64 local');
  });

  it('calcula bounds automáticos desde la cabecera real sin deformar la imagen', async () => {
    const { store } = fixture();
    const bytes = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
      ),
      character => character.charCodeAt(0)
    );
    const bundle = await createNativeAssetBundle(store, {
      blob: new Blob([bytes.buffer], { type: 'image/png' }),
    });
    const image = bundle.snapshot.blocks.children
      .find(block => block.flavour === 'affine:surface')!
      .children.find(block => block.flavour === 'affine:image')!;
    expect(image.props.xywh).toBe('[0,0,1,1]');
  });

  it('extrae imágenes Excalidraw locales y conserva su identidad de elemento', async () => {
    const { store } = fixture();
    const dataUrl = `data:image/png;base64,${btoa(String.fromCharCode(...png))}`;
    const imported = await createExcalidrawImageBundle(store, {
      elements: [
        {
          id: 'excal-image',
          type: 'image',
          fileId: 'file-one',
          x: 12,
          y: 16,
          width: 300,
          height: 200,
        },
      ],
      files: {
        'file-one': {
          dataURL: dataUrl,
          mimeType: 'image/png',
          fileName: 'funnel.png',
        },
      },
    });
    const image = imported.bundle.snapshot.blocks.children
      .find(block => block.flavour === 'affine:surface')!
      .children.find(block => block.flavour === 'affine:image')!;
    expect(imported.imageIds['excal-image']).toBe(image.id);
    expect(imported.bundle.assets.get(String(image.props.sourceId))?.type).toBe(
      'image/png'
    );
  });

  it('exporta una imagen PNG de más de 256 KiB por Base64 segmentado', async () => {
    const { store } = fixture();
    const sourceId = 'large-local-image';
    const largePng = new Uint8Array(256 * 1024 + 17);
    largePng.set(png);
    await store.workspace.blobSync.set(
      sourceId,
      new Blob([largePng], { type: 'image/png' })
    );
    const content = (await exportExcalidrawWithAssets({ store } as never, [
      {
        id: 'large-image',
        kind: 'block:affine:image',
        bounds: { x: 0, y: 0, w: 320, h: 180 },
        props: { sourceId },
      },
    ])) as {
      files: Record<string, { dataURL: string }>;
    };
    const dataUrl = content.files['file-large-image']?.dataURL;
    expect(dataUrl).toMatch(/^data:image\/png;base64,/);
    const encoded = dataUrl?.slice(dataUrl.indexOf(',') + 1);
    expect(atob(encoded ?? '')).toHaveLength(largePng.byteLength);
  });
});
