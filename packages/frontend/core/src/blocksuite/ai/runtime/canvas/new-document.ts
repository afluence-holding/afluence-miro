import type { Workspace } from '@affine/core/modules/workspace/entities/workspace';
import {
  DocModeExtension,
  DocModeProvider,
} from '@blocksuite/affine/shared/services';
import { BlockStdScope, type EditorHost } from '@blocksuite/affine/std';
import { Text } from '@blocksuite/affine/store';

const LIFECYCLE_KEY = 'affine:canvas-ai:new-documents:v1';

export interface CanvasDocumentRequest {
  workspaceId: string;
  docId: string;
  title: string;
  operationId: string;
  signal?: AbortSignal;
  deadline?: number;
}

type ProvisioningRecord = {
  version: 1;
  docId: string;
  operationId: string;
  title: string;
  phase: 'reserved' | 'registered' | 'initialized';
};

function checkCancellation(signal?: AbortSignal, deadline?: number) {
  signal?.throwIfAborted();
  if (deadline !== undefined && Date.now() >= deadline)
    throw new Error(
      'OPERATION_CONFLICT: La solicitud venció antes de completar la creación del documento.'
    );
}

/**
 * Called only by an authorized apply. Preparing a plan does not call this
 * factory. The workspace marker survives interruption between registration and
 * initialization, so retries resume the reserved ID without replacing content.
 */
export function canvasDocumentFactory(
  workspace: Workspace,
  sourceHost: EditorHost
) {
  return async (request: CanvasDocumentRequest) => {
    const { docId, operationId, title, signal, deadline } = request;
    checkCancellation(signal, deadline);
    if (request.workspaceId !== workspace.id || docId === sourceHost.store.id) {
      throw new Error(
        'Canvas document destination does not match the authorized workspace.'
      );
    }
    const journal =
      workspace.rootYDoc.getMap<ProvisioningRecord>(LIFECYCLE_KEY);
    const previous = journal.get(docId);
    const existing = workspace.docCollection.getDoc(docId);
    if (
      previous &&
      (previous.operationId !== operationId || previous.title !== title)
    ) {
      throw new Error(
        'The reserved document ID belongs to another canvas operation.'
      );
    }
    if (existing && !previous) {
      throw new Error(
        'The destination ID already belongs to an existing document.'
      );
    }
    const record: ProvisioningRecord = previous ?? {
      version: 1,
      docId,
      operationId,
      title,
      phase: 'reserved',
    };
    const mark = (phase: ProvisioningRecord['phase']) => {
      workspace.rootYDoc.transact(
        () => journal.set(docId, { ...record, phase }),
        'canvas-document-lifecycle'
      );
    };
    if (!previous) mark('reserved');
    checkCancellation(signal, deadline);
    if (!existing) {
      // skipInit permits recovery if registration succeeds but initialization
      // is interrupted. A retry never invokes createDoc for a registered ID.
      workspace.docs.createDoc({
        id: docId,
        title,
        primaryMode: 'edgeless',
        skipInit: true,
      });
    }
    mark('registered');
    const target = workspace.docCollection
      .getDoc(docId)
      ?.getStore({ id: docId });
    if (!target)
      throw new Error('The registered canvas document is not available yet.');
    target.load();
    await workspace.engine.doc.waitForDocReady(docId, signal);
    checkCancellation(signal, deadline);
    const roots = target.getBlocksByFlavour('affine:page');
    const surfaces = target.getBlocksByFlavour('affine:surface');
    if (
      roots.length > 1 ||
      surfaces.length > 1 ||
      (!roots.length && surfaces.length)
    ) {
      throw new Error(
        'The reserved document has an inconsistent native structure.'
      );
    }
    target.spaceDoc.transact(() => {
      const rootId =
        roots[0]?.id ??
        target.addBlock('affine:page', { title: new Text(title) });
      if (!surfaces.length) target.addBlock('affine:surface', {}, rootId);
      target.spaceDoc
        .getMap<ProvisioningRecord>(LIFECYCLE_KEY)
        .set(docId, { ...record, phase: 'initialized' });
    }, 'canvas-document-lifecycle');
    if (
      !target.root ||
      target.getBlocksByFlavour('affine:surface').length !== 1
    ) {
      throw new Error(
        'Canvas document initialization did not complete. Retry the original operation.'
      );
    }
    mark('initialized');
    checkCancellation(signal, deadline);

    // A native mounted editor provides the same model services and renderer as
    // the source. Its camera and selection cannot steal the user's input.
    const mode = sourceHost.std.get(DocModeProvider);
    const std = new BlockStdScope({
      store: target,
      extensions: [
        ...sourceHost.std.userExtensions,
        DocModeExtension({
          getEditorMode: () => 'edgeless',
          setEditorMode: () => {},
          getPrimaryMode: mode.getPrimaryMode.bind(mode),
          setPrimaryMode: mode.setPrimaryMode.bind(mode),
          togglePrimaryMode: mode.togglePrimaryMode.bind(mode),
          onPrimaryModeChange: mode.onPrimaryModeChange.bind(mode),
        }),
      ],
    });
    const host = std.render();
    const mount = document.createElement('div');
    mount.className = 'edgeless-container affine-edgeless-viewport';
    mount.setAttribute('aria-hidden', 'true');
    mount.inert = true;
    mount.style.cssText =
      'position:fixed;left:-20000px;top:0;width:1280px;height:960px;pointer-events:none;';
    mount.append(host);
    document.body.append(mount);
    try {
      await host.updateComplete;
      checkCancellation(signal, deadline);
      return { host, dispose: () => mount.remove() };
    } catch (error) {
      mount.remove();
      throw error;
    }
  };
}
