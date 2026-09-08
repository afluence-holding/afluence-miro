import { SignalWatcher, WithDisposable } from '@blocksuite/affine/global/lit';
import { ShadowlessElement } from '@blocksuite/affine/std';
import { css, html, nothing } from 'lit';
import { property, state } from 'lit/decorators.js';

import type { CanvasOperationAction } from '../../runtime/frontend/canvas-actions';
import type { StreamObject } from '../ai-chat-messages';

type JsonRecord = Record<string, unknown>;
const MAX_INLINE_DATA_URL_LENGTH = 700_000;

export type CanvasOperationActionCallback = (
  action: CanvasOperationAction
) => Promise<unknown> | unknown;

type CanvasArtifact = {
  url?: string;
  dataUrl?: string;
  mimeType?: string;
  fileName?: string;
};

export type CanvasOperationCardModel = {
  title: string;
  detail?: string;
  error?: string;
  artifact?: CanvasArtifact;
  downloadUrl?: string;
  downloadName?: string;
  focus?: CanvasOperationAction;
  revert?: CanvasOperationAction;
  redo?: CanvasOperationAction;
  resume?: CanvasOperationAction;
  cancel?: CanvasOperationAction;
};

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' ? (value as JsonRecord) : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function binding(value: unknown): CanvasOperationAction['binding'] | undefined {
  const item = record(value);
  const workspaceId = item?.workspaceId;
  const docId = item?.docId;
  if (
    typeof workspaceId !== 'string' ||
    !workspaceId ||
    typeof docId !== 'string' ||
    !docId
  ) {
    return undefined;
  }
  return {
    workspaceId,
    docId,
    ...(typeof item.clientId === 'string' && item.clientId
      ? { clientId: item.clientId }
      : {}),
  };
}

function data(result: unknown): JsonRecord | undefined {
  const envelope = record(result);
  if (!envelope) return undefined;
  return record(envelope.data) ?? envelope;
}

function error(result: unknown) {
  const envelope = record(result);
  const failure = record(envelope?.error);
  if (typeof failure?.message === 'string') return failure.message;
  if (typeof envelope?.message === 'string') return envelope.message;
  return undefined;
}

function artifact(value: unknown): CanvasArtifact | undefined {
  const item = record(value);
  if (!item) return undefined;
  const url = typeof item.url === 'string' ? item.url : undefined;
  const dataUrl = typeof item.dataUrl === 'string' ? item.dataUrl : undefined;
  const mimeType =
    typeof item.mimeType === 'string' ? item.mimeType : undefined;
  const fileName =
    typeof item.fileName === 'string'
      ? item.fileName
          .split('')
          .map(char =>
            char.charCodeAt(0) < 32 ||
            char.charCodeAt(0) === 127 ||
            char === '/' ||
            char === '\\'
              ? '_'
              : char
          )
          .join('')
          .slice(0, 240)
      : undefined;
  return url || dataUrl || mimeType
    ? { url, dataUrl, mimeType, fileName }
    : undefined;
}

function permittedArtifactUrl(value: string | undefined) {
  if (!value) return undefined;
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  if (
    value.length <= MAX_INLINE_DATA_URL_LENGTH &&
    /^data:image\/(png|jpeg|webp);base64,/i.test(value)
  ) {
    return value;
  }
  try {
    const url = new URL(
      value,
      globalThis.location?.origin ?? 'https://affine.local'
    );
    return ['http:', 'https:', 'blob:'].includes(url.protocol)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function downloadName(operationId: unknown, mimeType?: string) {
  const suffix =
    mimeType === 'application/pdf'
      ? 'pdf'
      : mimeType === 'image/svg+xml'
        ? 'svg'
        : mimeType === 'application/zip'
          ? 'zip'
          : 'png';
  const safe =
    typeof operationId === 'string'
      ? operationId.replace(/[^A-Za-z0-9_-]/g, '')
      : '';
  return `${safe || 'canvas-artifact'}.${suffix}`;
}

function actionRequestId() {
  return globalThis.crypto?.randomUUID?.();
}

function operationTitle(execution: unknown, persistence: unknown) {
  if (persistence === 'sync_pending' && execution === 'applied')
    return 'Cambios aplicados; sincronización pendiente';
  switch (execution) {
    case 'applied':
      return 'Cambios aplicados al lienzo';
    case 'reverted':
      return 'Cambios deshechos';
    case 'partial':
      return 'Cambios aplicados parcialmente';
    case 'conflict':
      return 'Cambios con conflicto';
    case 'cancelled':
      return 'Operación cancelada';
    default:
      return 'Resultado del lienzo';
  }
}

export function canvasOperationCardModel(
  result: unknown
): CanvasOperationCardModel {
  const envelope = record(result);
  const failure = error(result);
  if (envelope?.ok === false || failure) {
    return {
      title: 'No se pudo completar la operación del lienzo',
      error: failure ?? 'Resultado no disponible.',
    };
  }
  const value = data(result);
  if (!value) return { title: 'Resultado del lienzo' };
  const operationId = value.operationId;
  const operationBinding = binding(envelope?.binding);
  const currentArtifact = artifact(value.artifact);
  const artifactUrl = permittedArtifactUrl(
    currentArtifact?.url ?? currentArtifact?.dataUrl
  );
  const ids = [
    ...new Set([
      ...strings(value.createdIds),
      ...strings(value.updatedIds),
      ...strings(record(value.scope)?.ids),
    ]),
  ];
  const scope = ids.length ? { ids } : undefined;
  const requestId = actionRequestId();
  const canAct = !!operationBinding && !!requestId;
  const target = record(value.destination);
  const newDocument =
    target?.type === 'new_document' &&
    target.workspaceId === operationBinding?.workspaceId &&
    typeof target.reservedDocumentId === 'string' &&
    typeof target.title === 'string'
      ? {
          type: 'new_document' as const,
          workspaceId: target.workspaceId,
          title: target.title,
          reservedDocumentId: target.reservedDocumentId,
        }
      : undefined;
  const focus =
    canAct && (scope || newDocument)
      ? {
          tool: 'canvas_focus' as const,
          args: {
            destination: newDocument ?? {
              type: 'existing',
              documentId: operationBinding.docId,
            },
            scope: scope ?? {},
            mode: 'select',
          },
          binding: operationBinding,
        }
      : undefined;
  const revertAvailable = record(value.revert)?.available === true;
  const revert =
    canAct && revertAvailable && typeof operationId === 'string'
      ? {
          tool: 'canvas_operation' as const,
          args: { action: 'revert', operationId, requestId },
          binding: operationBinding,
        }
      : undefined;
  const originalOperationId =
    typeof value.parentOperationId === 'string'
      ? value.parentOperationId
      : operationId;
  const redo =
    canAct &&
    value.execution === 'reverted' &&
    typeof originalOperationId === 'string'
      ? {
          tool: 'canvas_operation' as const,
          args: { action: 'redo', operationId: originalOperationId, requestId },
          binding: operationBinding,
        }
      : undefined;
  const detail =
    typeof value.execution === 'string'
      ? `Estado: ${value.execution}${typeof value.contentRevision === 'string' ? ` · Revisión ${value.contentRevision}` : ''}`
      : currentArtifact
        ? 'Artefacto del lienzo listo.'
        : undefined;
  const progress = record(value.progress);
  const pendingJob =
    canAct && progress?.canResume === true && typeof operationId === 'string';
  const progressDetail =
    Number.isSafeInteger(progress?.completed) &&
    Number.isSafeInteger(progress?.total)
      ? `${progress?.completed} de ${progress?.total} elementos procesados`
      : undefined;
  return {
    title: operationTitle(value.execution, value.persistence),
    detail: progressDetail
      ? `${progressDetail}${detail ? ` · ${detail}` : ''}`
      : detail,
    ...(currentArtifact ? { artifact: currentArtifact } : {}),
    ...(artifactUrl
      ? {
          downloadUrl: artifactUrl,
          downloadName:
            currentArtifact?.fileName ||
            downloadName(operationId, currentArtifact?.mimeType),
        }
      : {}),
    ...(focus ? { focus } : {}),
    ...(revert ? { revert } : {}),
    ...(redo ? { redo } : {}),
    ...(pendingJob
      ? {
          resume: {
            tool: 'canvas_operation' as const,
            args: { action: 'resume', operationId, requestId },
            binding: operationBinding,
          },
          cancel: {
            tool: 'canvas_operation' as const,
            args: { action: 'cancel', operationId, requestId },
            binding: operationBinding,
          },
        }
      : {}),
  };
}

export async function dispatchCanvasOperationAction(
  callback: CanvasOperationActionCallback | undefined,
  action: CanvasOperationAction | undefined
) {
  if (!callback || !action) return false;
  const response = await callback(action);
  const failure = error(response);
  if (failure || record(response)?.ok === false)
    throw new Error(failure ?? 'La operación del lienzo falló.');
  return response;
}

export class CanvasOperationCard extends SignalWatcher(
  WithDisposable(ShadowlessElement)
) {
  static override styles = css`
    canvas-operation-card .canvas-operation-card {
      margin: 8px 0;
      padding: 12px;
      border: 0.5px solid var(--affine-border-color);
      border-radius: 8px;
      color: var(--affine-text-primary-color);
    }

    canvas-operation-card .title {
      font-size: 14px;
      font-weight: 500;
      line-height: 22px;
    }
    canvas-operation-card .detail,
    canvas-operation-card .error {
      margin-top: 4px;
      font-size: 12px;
      line-height: 18px;
      color: var(--affine-text-secondary-color);
    }
    canvas-operation-card .error {
      color: var(--affine-error-color);
    }
    canvas-operation-card img {
      display: block;
      width: 100%;
      max-height: 240px;
      margin-top: 10px;
      border-radius: 6px;
      object-fit: contain;
      background: var(--affine-hover-color);
    }
    canvas-operation-card .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    canvas-operation-card button,
    canvas-operation-card a {
      min-height: 28px;
      padding: 4px 8px;
      border: 0.5px solid var(--affine-border-color);
      border-radius: 6px;
      color: inherit;
      background: transparent;
      font: inherit;
      font-size: 12px;
      line-height: 18px;
      text-decoration: none;
      cursor: pointer;
    }
    canvas-operation-card button:hover:not(:disabled),
    canvas-operation-card a:hover {
      background: var(--affine-hover-color);
    }
    canvas-operation-card button:focus-visible,
    canvas-operation-card a:focus-visible {
      outline: 2px solid var(--affine-primary-color);
      outline-offset: 2px;
    }
    canvas-operation-card button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
  `;

  @property({ attribute: false })
  accessor data!: Extract<StreamObject, { type: 'tool-call' | 'tool-result' }>;

  @property({ attribute: false })
  accessor onCanvasAction: CanvasOperationActionCallback | undefined;

  @state()
  private accessor actionError: string | undefined;

  @state()
  private accessor pending = false;

  @state()
  private accessor actionResult: unknown;

  private async run(action: CanvasOperationAction | undefined) {
    if (this.pending || !action || !this.onCanvasAction) return;
    this.pending = true;
    this.actionError = undefined;
    try {
      const response = await dispatchCanvasOperationAction(
        this.onCanvasAction,
        action
      );
      if (action.tool === 'canvas_operation' && record(response))
        this.actionResult = response;
    } catch (error) {
      this.actionError =
        error instanceof Error
          ? error.message
          : 'No se pudo ejecutar la acción. Inténtalo de nuevo.';
    } finally {
      this.pending = false;
    }
  }

  protected override render() {
    if (this.data.type === 'tool-call') {
      return html`<div class="canvas-operation-card" aria-live="polite">
        <div class="title">Procesando operación del lienzo…</div>
      </div>`;
    }
    const model = canvasOperationCardModel(
      this.actionResult ?? this.data.result
    );
    const previewUrl = permittedArtifactUrl(
      model.artifact?.dataUrl ?? model.artifact?.url
    );
    const preview =
      previewUrl && model.artifact?.mimeType?.startsWith('image/')
        ? html`<img src=${previewUrl} alt="Vista previa del lienzo" />`
        : nothing;
    return html`<section class="canvas-operation-card" aria-live="polite">
      <div class="title">${model.title}</div>
      ${model.detail ? html`<div class="detail">${model.detail}</div>` : nothing}
      ${model.error ? html`<div class="error">${model.error}</div>` : nothing}
      ${preview}
      ${this.actionError ? html`<div class="error" role="alert">${this.actionError}</div>` : nothing}
      <div class="actions">
        ${model.focus ? html`<button type="button" ?disabled=${this.pending || !this.onCanvasAction} @click=${() => this.run(model.focus)}>Enfocar</button>` : nothing}
        ${model.revert ? html`<button type="button" ?disabled=${this.pending || !this.onCanvasAction} @click=${() => this.run(model.revert)}>Deshacer</button>` : nothing}
        ${model.redo ? html`<button type="button" ?disabled=${this.pending || !this.onCanvasAction} @click=${() => this.run(model.redo)}>Rehacer</button>` : nothing}
        ${model.resume ? html`<button type="button" ?disabled=${this.pending || !this.onCanvasAction} @click=${() => this.run(model.resume)}>Continuar importación</button>` : nothing}
        ${model.cancel ? html`<button type="button" ?disabled=${this.pending || !this.onCanvasAction} @click=${() => this.run(model.cancel)}>Detener importación</button>` : nothing}
        ${model.downloadUrl ? html`<a href=${model.downloadUrl} download=${model.downloadName} target="_blank" rel="noopener noreferrer">Descargar</a>` : nothing}
      </div>
    </section>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'canvas-operation-card': CanvasOperationCard;
  }
}
