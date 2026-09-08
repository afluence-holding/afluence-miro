import type { CanvasNode, CanvasProps } from '@affine/realtime/canvas';
import { afterEach, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';

import {
  createNativeBlock,
  deleteNativeBlock,
  getNativeBlockCapabilities,
  NATIVE_BLOCK_REGISTRY,
  snapshotNativeBlock,
  updateNativeBlock,
} from '../../../../../packages/frontend/core/src/blocksuite/ai/runtime/canvas/native-blocks.js';
import {
  exportNativeCanvas,
  insertNativeCanvasEntry,
  prepareNativeCanvasInsert,
  readNativeCanvas,
} from '../../../../../packages/frontend/core/src/blocksuite/ai/runtime/canvas/native-interchange.js';
import { setupEditor } from '../utils/setup.js';

const bounds = { x: 40, y: 40, w: 320, h: 120 };

function node(
  flavour: string,
  props: CanvasProps,
  parentId: string,
  index: number
): CanvasNode {
  return {
    id: `native-coverage-${index}-${flavour.replace('affine:', '')}`,
    kind: `block:${flavour}`,
    parentId,
    bounds: { ...bounds, x: bounds.x + index * 12, y: bounds.y + index * 12 },
    props,
  };
}

function fixture(
  flavour: string,
  assetId: string,
  documentId: string
): CanvasProps {
  const text = { text: `Contenido ${flavour}` };
  switch (flavour) {
    case 'affine:divider':
      return {};
    case 'affine:list':
      return { ...text, type: 'todo', checked: false, order: 1 };
    case 'affine:code':
      return {
        ...text,
        language: 'typescript',
        wrap: true,
        caption: 'Código',
        lineNumber: true,
      };
    case 'affine:latex':
      return { latex: 'x^2+y^2=r^2' };
    case 'affine:callout':
      return { ...text, backgroundColorName: 'blue' };
    case 'affine:image':
      return { sourceId: assetId, caption: 'Imagen de prueba' };
    case 'affine:attachment':
      return {
        sourceId: assetId,
        name: 'evidence.png',
        size: 68,
        type: 'image/png',
        embed: true,
        style: 'horizontalThin',
        footnoteIdentifier: null,
      };
    case 'affine:bookmark':
      return {
        url: 'https://example.test/bookmark',
        title: 'Bookmark',
        description: 'Descripción',
        style: 'horizontal',
        caption: 'Referencia',
        image: null,
        icon: null,
        footnoteIdentifier: null,
      };
    case 'affine:surface-ref':
      return {
        reference: 'native-coverage-frame',
        caption: 'Frame de referencia',
        refFlavour: 'affine:frame',
      };
    case 'affine:table':
      return {
        table: {
          rows: [{ id: 'row-a', order: 'a0' }],
          columns: [{ id: 'col-a', order: 'a0', width: 240 }],
          cells: {
            'row-a:col-a': {
              richText: [{ insert: 'Celda rica', attributes: { bold: true } }],
            },
          },
        },
      };
    case 'affine:database':
      return {
        database: {
          title: {
            richText: [{ insert: 'Base de datos', attributes: { bold: true } }],
          },
          columns: [],
          views: [
            {
              id: 'database-table-view',
              name: 'Tabla',
              mode: 'table',
              columns: [],
              filter: { type: 'group', op: 'and', conditions: [] },
              header: { iconColumn: 'type' },
            },
          ],
          cells: {},
        },
      };
    case 'affine:data-view':
      return {
        title: 'Vista de datos',
        columns: [],
        views: [
          {
            id: 'query-table-view',
            name: 'Tabla',
            mode: 'table',
            columns: [],
            filter: { type: 'group', op: 'and', conditions: [] },
            header: { iconColumn: 'type' },
          },
        ],
        cells: {},
      };
    case 'affine:embed-youtube':
      return {
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        style: 'video',
        title: 'Video',
        description: 'Demo',
        caption: 'YouTube',
      };
    case 'affine:embed-figma':
      return {
        url: 'https://www.figma.com/file/example',
        style: 'figma',
        title: 'Diseño',
        description: 'Demo',
        caption: 'Figma',
      };
    case 'affine:embed-github':
      return {
        url: 'https://github.com/toeverything/AFFiNE/issues/1',
        style: 'horizontal',
        owner: 'toeverything',
        repo: 'AFFiNE',
        githubType: 'issue',
        githubId: '1',
        title: 'Issue',
        description: 'Demo',
        caption: 'GitHub',
      };
    case 'affine:embed-html':
      return {
        html: '<p>Contenido aislado</p>',
        design: 'inline',
        style: 'html',
        caption: 'HTML',
      };
    case 'affine:embed-linked-doc':
      return {
        pageId: documentId,
        style: 'horizontal',
        title: 'Documento',
        description: 'Demo',
        caption: 'Enlace',
        footnoteIdentifier: null,
      };
    case 'affine:embed-synced-doc':
      return {
        pageId: documentId,
        style: 'syncedDoc',
        title: 'Documento sincronizado',
        description: 'Demo',
        caption: 'Sync',
        preFoldHeight: 240,
      };
    case 'affine:embed-loom':
      return {
        url: 'https://www.loom.com/share/example',
        style: 'video',
        title: 'Loom',
        description: 'Demo',
        caption: 'Loom',
      };
    case 'affine:edgeless-text':
      return {};
    case 'affine:frame':
      return { title: 'Frame nativo' };
    default:
      return text;
  }
}

describe('inventario nativo Affine en Chromium', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => cleanup?.());

  test('registra 25 schemas, materializa los 23 editables y rehidrata modelos desde .bs.zip', async () => {
    cleanup = await setupEditor('page');
    const store = window.editor.host!.store;
    const root = store.root!;
    const surface = store.getModelsByFlavour('affine:surface')[0]!;
    const assetId = 'native-coverage-asset';
    await store.workspace.blobSync.set(
      assetId,
      new Blob(['png-fixture'], { type: 'image/png' })
    );

    const capabilities = getNativeBlockCapabilities(store);
    expect(capabilities).toHaveLength(25);
    expect(capabilities.filter(entry => entry.registered)).toHaveLength(25);
    expect(capabilities.filter(entry => entry.structural)).toHaveLength(2);

    const noteId = createNativeBlock(
      store,
      node('affine:note', {}, root.id, 0)
    );
    const parents = [root.id, surface.id, noteId];
    const created: Array<{ flavour: string; id: string }> = [];
    for (const [index, descriptor] of NATIVE_BLOCK_REGISTRY.entries()) {
      if (descriptor.structural || descriptor.flavour === 'affine:note')
        continue;
      const parentId = parents.find(parent =>
        store.schema.safeValidate(
          descriptor.flavour,
          store.getModelById(parent)?.flavour
        )
      );
      expect(parentId, descriptor.flavour).toBeTruthy();
      const id = createNativeBlock(
        store,
        node(
          descriptor.flavour,
          fixture(descriptor.flavour, assetId, store.id),
          parentId!,
          index
        )
      );
      const snapshot = snapshotNativeBlock(store, id, bounds);
      expect(snapshot?.kind).toBe(descriptor.kind);
      expect(store.getModelById(id)?.flavour).toBe(descriptor.flavour);
      updateNativeBlock(store, id, { props: snapshot!.props });
      created.push({ flavour: descriptor.flavour, id });
    }
    expect(created).toHaveLength(22);
    await expect(store.workspace.blobSync.get(assetId)).resolves.toBeTruthy();

    // The two data models must mount their native UI, not merely survive as
    // snapshots in the Store. A table view is supplied above, so the renderer
    // has a concrete current view to hydrate.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    for (const flavour of ['affine:database', 'affine:data-view']) {
      const id = created.find(entry => entry.flavour === flavour)?.id;
      const component = id ? window.editor.host!.view.getBlock(id) : undefined;
      expect(component, `${flavour} no se montó en la vista`).toBeTruthy();
      const mounted = component as
        | (HTMLElement & {
            updateComplete?: Promise<unknown>;
          })
        | undefined;
      await mounted?.updateComplete;
      expect(mounted?.isConnected, `${flavour} no quedó conectado`).toBe(true);
      const renderedRoot = mounted?.shadowRoot ?? mounted;
      expect(
        renderedRoot?.childElementCount ?? 0,
        `${flavour} no produjo UI nativa`
      ).toBeGreaterThan(0);
    }

    const exported = await exportNativeCanvas(window.editor.host!);
    const bundle = await readNativeCanvas(exported.blob, store);
    expect(bundle.assets.get(assetId)).toBeInstanceOf(Blob);
    const prepared = await prepareNativeCanvasInsert(store, bundle, {
      allocateId: sourceId => `rehydrated-${sourceId}`,
    });
    prepared.assets.forEach(
      (blob, id) => void store.workspace.blobSync.set(id, blob)
    );
    store.transact(() =>
      prepared.entries.forEach(entry => insertNativeCanvasEntry(store, entry))
    );
    for (const { flavour, id } of created) {
      const restored = store.getModelById(`rehydrated-${id}`);
      expect(restored?.flavour, flavour).toBe(flavour);
    }

    for (const { id } of created) deleteNativeBlock(store, id);
    expect(created.every(({ id }) => !store.hasBlock(id))).toBe(true);
    await page.screenshot({ path: '/tmp/edgeless-ai-native-blocks.png' });
  });
});
