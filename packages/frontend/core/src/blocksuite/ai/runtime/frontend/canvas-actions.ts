export interface CanvasOperationAction {
  tool: 'canvas_operation' | 'canvas_focus';
  args: Record<string, unknown>;
  binding: { workspaceId: string; docId: string; clientId?: string };
}

export interface CanvasActionEventDetail {
  action: CanvasOperationAction;
  accept: (response: Promise<unknown>) => void;
  claimed: boolean;
}

export const CANVAS_ACTION_EVENT = 'affine:canvas-action';

/** Routes an explicit UI action through the authenticated live editor bridge. */
export function requestCanvasAction(
  action: CanvasOperationAction
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const detail: CanvasActionEventDetail = {
      action,
      claimed: false,
      accept: response => {
        response.then(resolve, reject);
      },
    };
    document.dispatchEvent(
      new CustomEvent<CanvasActionEventDetail>(CANVAS_ACTION_EVENT, { detail })
    );
    if (!detail.claimed)
      reject(
        new Error(
          'EDITOR_UNAVAILABLE: Abre este documento en Edgeless para usar la acción.'
        )
      );
  });
}
