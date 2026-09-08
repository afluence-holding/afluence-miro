import type { CanvasRuntimeOptions } from '../canvas/runtime';

const MAX_BYTES = 64 * 1024 * 1024;
const endpoint = '/api/copilot/canvas-artifact';
type Fetch = (
  url: string,
  init?: RequestInit & { timeout?: number }
) => Promise<Response>;

/** Only signed handles reach the network; model-provided URLs are never fetched. */
export function canvasArtifactClient(
  fetch: Fetch,
  serverUrl: string,
  workspaceId: string,
  sessionId: string
) {
  const path = (handle: string) => {
    if (!/^cah_[A-Za-z0-9_=,./+%-]+$/.test(handle) || handle.length > 8192)
      throw new Error('INVALID_PLAN: El handle de archivo no es válido.');
    return `${endpoint}?${new URLSearchParams({ handle })}`;
  };
  const resolveArtifact = async ({
    handle,
    signal,
  }: {
    handle: string;
    signal?: AbortSignal;
  }) => {
    const response = await fetch(path(handle), {
      signal,
      credentials: 'include',
      timeout: 45000,
    });
    if (!response.ok)
      throw new Error(
        `ASSET_MISSING: No se pudo recuperar el archivo (${response.status}).`
      );
    if (Number(response.headers.get('content-length')) > MAX_BYTES)
      throw new Error('BUDGET_EXCEEDED: El archivo supera 64 MiB.');
    if (!response.body)
      throw new Error('ASSET_MISSING: El archivo está vacío.');
    const reader = response.body.getReader();
    const chunks: ArrayBuffer[] = [];
    let size = 0;
    try {
      for (;;) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES)
          throw new Error('BUDGET_EXCEEDED: El archivo supera 64 MiB.');
        chunks.push(new Uint8Array(value).buffer);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    return new Blob(chunks, {
      type: response.headers.get('content-type') ?? 'application/octet-stream',
    });
  };
  const createArtifact: NonNullable<
    CanvasRuntimeOptions['createArtifact']
  > = async input => {
    if (
      input.workspaceId !== workspaceId ||
      input.blob.size > MAX_BYTES ||
      !input.blob.size
    )
      throw new Error(
        'INVALID_PLAN: El archivo o su espacio de trabajo no es válido.'
      );
    const query = new URLSearchParams({
      workspaceId,
      sessionId,
      docId: input.docId,
      fileName: input.fileName,
    });
    const response = await fetch(`${endpoint}?${query}`, {
      method: 'POST',
      credentials: 'include',
      timeout: 45000,
      signal: input.signal,
      headers: { 'Content-Type': input.mimeType },
      body: input.blob,
    });
    if (!response.ok)
      throw new Error(
        `No se pudo guardar el archivo exportado (${response.status}).`
      );
    const artifact = (await response.json()) as {
      handle?: unknown;
      mimeType?: unknown;
      fileName?: unknown;
    };
    if (typeof artifact.handle !== 'string')
      throw new Error('El servidor no devolvió un handle de archivo.');
    return {
      handle: artifact.handle,
      url: new URL(path(artifact.handle), serverUrl).toString(),
      mimeType:
        typeof artifact.mimeType === 'string'
          ? artifact.mimeType
          : input.mimeType,
      fileName:
        typeof artifact.fileName === 'string'
          ? artifact.fileName
          : input.fileName,
    };
  };
  return { createArtifact, resolveArtifact };
}
