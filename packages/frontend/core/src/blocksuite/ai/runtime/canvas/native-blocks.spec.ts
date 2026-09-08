import type { CanvasNode } from '@affine/realtime/canvas';
import {
  CalloutBlockSchemaExtension,
  CodeBlockSchemaExtension,
  DatabaseBlockSchemaExtension,
  DividerBlockSchemaExtension,
  ImageBlockSchemaExtension,
  LatexBlockSchemaExtension,
  ListBlockSchemaExtension,
  NoteBlockSchemaExtension,
  ParagraphBlockSchemaExtension,
  RootBlockSchemaExtension,
  TableBlockSchemaExtension,
} from '@blocksuite/affine/model';
import { Text } from '@blocksuite/affine/store';
import { TestWorkspace } from '@blocksuite/affine/store/test';
import { describe, expect, it } from 'vitest';

import {
  createNativeBlock,
  getNativeBlockCapabilities,
  prepareNativeBlockAssets,
  snapshotNativeBlock,
  updateNativeBlock,
  validateNativeBlockNode,
} from './native-blocks';

const extensions = [
  RootBlockSchemaExtension,
  NoteBlockSchemaExtension,
  ParagraphBlockSchemaExtension,
  ListBlockSchemaExtension,
  DividerBlockSchemaExtension,
  CodeBlockSchemaExtension,
  LatexBlockSchemaExtension,
  CalloutBlockSchemaExtension,
  TableBlockSchemaExtension,
  DatabaseBlockSchemaExtension,
  ImageBlockSchemaExtension,
];

function createStore() {
  const workspace = new TestWorkspace();
  workspace.meta.initialize();
  const doc = workspace.createDoc('canvas-native-blocks');
  doc.load();
  const store = doc.getStore({ extensions });
  const rootId = store.addBlock('affine:page', { title: new Text('Canvas') });
  const noteId = store.addBlock('affine:note', {}, rootId);
  return { store, noteId };
}

function block(
  flavour: string,
  props: CanvasNode['props'],
  parentId: string
): CanvasNode {
  return {
    id: `draft-${flavour}`,
    kind: `block:${flavour}`,
    bounds: { x: 0, y: 0, w: 400, h: 80 },
    props,
    parentId,
  };
}

function modelProps(
  store: ReturnType<typeof createStore>['store'],
  id: string
) {
  return store.getModelById(id)?.props as unknown as Record<string, unknown>;
}

describe('native blocks for canvas', () => {
  it('creates rich nested blocks with real schemas and preserves text on update', () => {
    const { store, noteId } = createStore();
    const paragraph = createNativeBlock(
      store,
      block(
        'affine:paragraph',
        { text: 'Contenido íntegro', type: 'h2' },
        noteId
      )
    );
    const list = createNativeBlock(
      store,
      block(
        'affine:list',
        { text: 'Pendiente', type: 'todo', checked: false },
        noteId
      )
    );
    const code = createNativeBlock(
      store,
      block(
        'affine:code',
        { text: 'const x = 1', language: 'typescript' },
        noteId
      )
    );
    const callout = createNativeBlock(
      store,
      block('affine:callout', { text: 'No perder este aviso' }, noteId)
    );
    updateNativeBlock(store, paragraph, {
      props: {
        richText: [
          { insert: 'Texto ' },
          { insert: 'actualizado', attributes: { bold: true } },
        ],
      },
    });
    const snapshot = snapshotNativeBlock(store, paragraph, {
      x: 0,
      y: 0,
      w: 400,
      h: 80,
    });
    expect(paragraph).toBe('draft-affine:paragraph');
    expect(store.hasBlock(paragraph)).toBe(true);
    expect(store.getModelById(paragraph)?.flavour).toBe('affine:paragraph');
    expect((modelProps(store, paragraph).text as Text).toString()).toBe(
      'Texto actualizado'
    );
    expect(snapshot?.props.richText).toEqual([
      expect.objectContaining({ insert: 'Texto ' }),
      expect.objectContaining({ insert: 'actualizado' }),
    ]);
    expect(store.getModelById(list)?.flavour).toBe('affine:list');
    expect(store.getModelById(code)?.flavour).toBe('affine:code');
    expect(store.getModelById(callout)?.flavour).toBe('affine:callout');
  });

  it('preserva tablas y bases de datos semánticas al leer y rehidratar', () => {
    const { store, noteId } = createStore();
    const table = createNativeBlock(
      store,
      block(
        'affine:table',
        {
          table: {
            rows: [{ id: 'r1' }],
            columns: [{ id: 'c1', width: 240 }],
            cells: { 'r1:c1': 'Responsable' },
          },
        },
        noteId
      )
    );
    const database = createNativeBlock(
      store,
      block(
        'affine:database',
        {
          database: {
            title: {
              text: 'Pipeline',
              richText: [{ insert: 'Pipeline', attributes: { bold: true } }],
            },
            columns: [],
            views: [],
            cells: {
              owner: {
                richText: [{ insert: 'Ada', attributes: { italic: true } }],
              },
            },
          },
        },
        noteId
      )
    );
    const snapshot = snapshotNativeBlock(store, database, {
      x: 20,
      y: 30,
      w: 400,
      h: 200,
    });
    expect(store.getModelById(table)?.flavour).toBe('affine:table');
    expect((modelProps(store, database).title as Text).toString()).toBe(
      'Pipeline'
    );
    expect(snapshot).toMatchObject({
      kind: 'block:affine:database',
      parentId: noteId,
      bounds: { x: 20, y: 30 },
    });
    expect(
      snapshotNativeBlock(store, table, { x: 0, y: 0, w: 200, h: 100 })?.props
        .table
    ).toMatchObject({ cells: { 'r1:c1': { text: 'Responsable' } } });
    expect(snapshot?.props.database).toMatchObject({
      title: {
        text: 'Pipeline',
        richText: [expect.objectContaining({ insert: 'Pipeline' })],
      },
      columns: [],
      views: [],
      cells: {
        owner: {
          text: 'Ada',
          richText: [expect.objectContaining({ insert: 'Ada' })],
        },
      },
    });
    const tableSnapshot = snapshotNativeBlock(store, table, {
      x: 0,
      y: 0,
      w: 200,
      h: 100,
    })!;
    const databaseSnapshot = snapshot!;
    const restored = createStore();
    const restoredTable = createNativeBlock(restored.store, {
      ...tableSnapshot,
      id: 'restored-table',
      parentId: restored.noteId,
    });
    const restoredDatabase = createNativeBlock(restored.store, {
      ...databaseSnapshot,
      id: 'restored-database',
      parentId: restored.noteId,
    });
    expect(
      (
        modelProps(restored.store, restoredTable).cells as Record<
          string,
          { text: Text }
        >
      )['r1:c1'].text.toDelta()
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ insert: 'Responsable' }),
      ])
    );
    expect(
      (modelProps(restored.store, restoredDatabase).title as Text).toDelta()
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ insert: 'Pipeline' })])
    );
    expect(
      (
        modelProps(restored.store, restoredDatabase).cells as Record<
          string,
          Text
        >
      ).owner.toDelta()
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ insert: 'Ada' })])
    );
  });

  it('enforces registered parents, structural exclusions, allowed fields and blob preparation', async () => {
    const { store, noteId } = createStore();
    const rootId = store.root?.id;
    expect(rootId).toBeTruthy();
    expect(
      validateNativeBlockNode(
        store,
        block(
          'affine:note',
          {
            background: { light: '#FFF7ED', dark: '#252525' },
            edgeless: {
              style: {
                borderRadius: 8,
                borderSize: 4,
                borderStyle: 'none',
                shadowType: '--affine-note-shadow-box',
              },
            },
          },
          rootId!
        )
      )
    ).toMatchObject({ ok: true });
    expect(
      validateNativeBlockNode(store, block('affine:page', {}, noteId))
    ).toMatchObject({ ok: false });
    expect(
      validateNativeBlockNode(
        store,
        block('affine:paragraph', { text: 'x', arbitraryJs: 'no' }, noteId)
      )
    ).toMatchObject({ ok: false });
    expect(
      validateNativeBlockNode(
        store,
        block('affine:paragraph', { text: 'anidado' }, 'plan-note'),
        'plan-note',
        { kind: 'block:affine:note', flavour: 'affine:note' }
      )
    ).toMatchObject({ ok: true });
    expect(
      validateNativeBlockNode(
        store,
        block('affine:paragraph', { text: 'sin padre válido' }, 'plan-shape'),
        'plan-shape',
        { kind: 'shape' }
      )
    ).toMatchObject({ ok: false });
    await expect(
      prepareNativeBlockAssets(
        block('affine:image', { sourceId: 'blob-ok' }, noteId),
        { hasBlob: async sourceId => sourceId === 'blob-ok' }
      )
    ).resolves.toMatchObject({ ok: true });
    await expect(
      prepareNativeBlockAssets(
        block('affine:image', { sourceId: 'missing' }, noteId),
        { hasBlob: async () => false }
      )
    ).resolves.toMatchObject({ ok: false });
    expect(
      getNativeBlockCapabilities(store).find(
        capability => capability.flavour === 'affine:database'
      )
    ).toMatchObject({ registered: true, status: 'experimental' });
  });
});
