import type { LlmToolCallbackResponse } from '../../../native';

const MAX_RENDER_IMAGE_BYTES = 512 * 1024;
const IMAGE_DATA_URL =
  /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

export type CanvasToolResultMedia = {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  data: string;
};

export type NativeToolCallbackResponseWithMedia = LlmToolCallbackResponse & {
  media?: CanvasToolResultMedia[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDataUrl(value: unknown): CanvasToolResultMedia | undefined {
  if (typeof value !== 'string') return;
  const match = IMAGE_DATA_URL.exec(value);
  if (!match) return;
  const [, mimeType, data] = match;
  const decoded = Buffer.from(data, 'base64');
  if (!decoded.byteLength || decoded.byteLength > MAX_RENDER_IMAGE_BYTES)
    return;
  // Buffer accepts malformed base64 permissively. Round-trip it to ensure the
  // bytes sent to a provider are exactly the bounded data URL payload.
  if (decoded.toString('base64') !== data) return;
  return {
    mimeType: mimeType as CanvasToolResultMedia['mimeType'],
    data,
  };
}

function withoutInlineRenderData(
  response: LlmToolCallbackResponse,
  deliveredToModel: boolean
): LlmToolCallbackResponse {
  if (!isRecord(response.output) || !isRecord(response.output.data)) {
    return response;
  }
  const artifact = response.output.data.artifact;
  if (!isRecord(artifact) || typeof artifact.dataUrl !== 'string') {
    return response;
  }
  const { dataUrl: _dataUrl, ...artifactMetadata } = artifact;
  return {
    ...response,
    output: {
      ...response.output,
      data: {
        ...response.output.data,
        artifact: artifactMetadata,
        visualVerificationDeliveredToModel: deliveredToModel,
      },
    },
  };
}

/**
 * Keeps binary canvas renders out of tool-result JSON and exposes a bounded
 * image part only to the native tool-loop transport. The model receives an
 * explicit delivery marker, so a render artifact alone is never evidence that
 * it inspected pixels.
 */
export function normalizeCanvasRenderToolResponse(
  response: LlmToolCallbackResponse
): NativeToolCallbackResponseWithMedia {
  if (response.name !== 'canvas_render' || response.isError) {
    return response;
  }
  const output = response.output;
  const artifact =
    isRecord(output) && output.ok === true && isRecord(output.data)
      ? output.data.artifact
      : undefined;
  // Candidate selection happens inside the native routed tool loop. Extract
  // bounded media here, then let that loop decide from the selected model.
  const media = isRecord(artifact) ? parseDataUrl(artifact.dataUrl) : undefined;
  return {
    ...withoutInlineRenderData(response, false),
    ...(media ? { media: [media] } : {}),
  };
}

export const CanvasRenderMediaLimits = {
  maxBytes: MAX_RENDER_IMAGE_BYTES,
  mimeTypes: ['image/png', 'image/jpeg', 'image/webp'] as const,
};
