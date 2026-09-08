import { WorkspaceImpl } from '@affine/core/modules/workspace/impls/workspace';
import { ViewExtensionManagerIdentifier } from '@blocksuite/affine/ext-loader';
import { BlockStdScope, type EditorHost } from '@blocksuite/affine/std';
import { Text } from '@blocksuite/affine/store';
import * as Y from 'yjs';

/** An isolated native document: no workspace registration, sync, or source writes. */
export async function createCanvasPreviewDocument(
  source: EditorHost,
  empty: boolean,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const previewId = `canvas-preview-${crypto.randomUUID()}`;
  const rootDoc = new Y.Doc({ guid: previewId });
  const assets = new Map<string, Blob>();
  const collection = new WorkspaceImpl({
    id: previewId,
    rootDoc,
    blobSource: {
      name: 'canvas-preview-memory',
      readonly: false,
      get: async id =>
        assets.get(id) ?? source.store.workspace.blobSync.get(id),
      set: async (id, blob) => {
        assets.set(id, blob);
        return id;
      },
      delete: async id => {
        assets.delete(id);
      },
      list: async () => [...assets.keys()],
    },
  });
  collection.meta.initialize();
  const doc = collection.createDoc(previewId);
  // WorkspaceImpl installs the application's native store schema/extensions.
  // Copying source userExtensions would duplicate document/manager bindings.
  const store = doc.getStore();
  doc.load();
  if (empty) {
    const root = store.addBlock('affine:page', {
      title: new Text('Canvas preview'),
    });
    store.addBlock('affine:surface', {}, root);
  } else {
    // Clone only native blocks. Source journals, plans, views and awareness are
    // deliberately absent from the isolated preview.
    const snapshot = source.store.getTransformer().docToSnapshot(source.store);
    if (!snapshot) {
      collection.dispose();
      throw new Error(
        'The source document could not be serialized for preview.'
      );
    }
    const transformer = store.getTransformer();
    const pending: (typeof snapshot.blocks)[] = [snapshot.blocks];
    while (pending.length) {
      const block = pending.pop();
      if (!block) break;
      const id = block.props.sourceId;
      if (
        typeof id === 'string' &&
        (block.flavour === 'affine:image' ||
          block.flavour === 'affine:attachment')
      ) {
        const blob = await source.store.workspace.blobSync.get(id);
        if (!blob) {
          collection.dispose();
          throw new Error(`ASSET_MISSING: ${id}`);
        }
        transformer.assets.set(id, blob);
      }
      pending.push(...block.children);
    }
    await transformer.snapshotToBlock(snapshot.blocks, store);
    if (!store.root) {
      collection.dispose();
      throw new Error('The native preview could not be initialized.');
    }
  }
  const previewExtensions = source.std
    .get(ViewExtensionManagerIdentifier)
    .get('preview-edgeless');
  const std = new BlockStdScope({ store, extensions: previewExtensions });
  const host = std.render();
  const mount = document.createElement('div');
  mount.className = 'edgeless-container affine-edgeless-viewport';
  mount.inert = true;
  mount.setAttribute('aria-hidden', 'true');
  mount.style.cssText =
    'position:fixed;left:-20000px;top:0;width:1280px;height:960px;pointer-events:none;';
  mount.append(host);
  document.body.append(mount);
  const dispose = () => {
    mount.remove();
    collection.dispose();
    rootDoc.destroy();
    assets.clear();
  };
  try {
    await host.updateComplete;
    signal?.throwIfAborted();
    return { host, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
