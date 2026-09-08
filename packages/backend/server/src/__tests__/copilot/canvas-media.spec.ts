import ava from 'ava';

import type { LlmToolCallbackResponse } from '../../native';
import {
  CanvasRenderMediaLimits,
  normalizeCanvasRenderToolResponse,
} from '../../plugins/copilot/tools/canvas-media';

const test = ava;

function renderResponse(dataUrl: string): LlmToolCallbackResponse {
  return {
    callId: 'call-1',
    name: 'canvas_render',
    args: {},
    output: {
      ok: true,
      data: {
        visualVerificationAvailable: true,
        artifact: { dataUrl, mimeType: 'image/png' },
      },
    },
  };
}

test('canvas render serializes as the native callback response with a bounded image part', t => {
  const source = Buffer.from('small canvas image').toString('base64');
  const normalized = normalizeCanvasRenderToolResponse(
    renderResponse(`data:image/png;base64,${source}`)
  );

  t.deepEqual(normalized.media, [{ mimeType: 'image/png', data: source }]);
  t.is('response' in normalized, false);
  t.like(normalized.output, {
    ok: true,
    data: {
      artifact: { mimeType: 'image/png' },
      visualVerificationDeliveredToModel: false,
    },
  });
  t.false(JSON.stringify(normalized.output).includes(source));
  t.deepEqual(JSON.parse(JSON.stringify(normalized)), {
    callId: 'call-1',
    name: 'canvas_render',
    args: {},
    output: {
      ok: true,
      data: {
        visualVerificationAvailable: true,
        artifact: { mimeType: 'image/png' },
        visualVerificationDeliveredToModel: false,
      },
    },
    media: [{ mimeType: 'image/png', data: source }],
  });
});

test('canvas render defers vision delivery to the selected native route and rejects payloads over budget', t => {
  const source = Buffer.alloc(CanvasRenderMediaLimits.maxBytes + 1, 7).toString(
    'base64'
  );
  const tooLarge = normalizeCanvasRenderToolResponse(
    renderResponse(`data:image/png;base64,${source}`)
  );

  t.is(tooLarge.media, undefined);
  t.like(tooLarge.output, {
    data: { visualVerificationDeliveredToModel: false },
  });
});

test('non-render tool callbacks keep the canonical top-level output shape', t => {
  const response: LlmToolCallbackResponse = {
    callId: 'call-capabilities',
    name: 'canvas_capabilities',
    args: { destination: { type: 'existing', documentId: 'doc' } },
    output: { ok: true, data: { tools: ['canvas_read'] } },
  };

  const normalized = normalizeCanvasRenderToolResponse(response);

  t.deepEqual(JSON.parse(JSON.stringify(normalized)), response);
  t.is('response' in normalized, false);
});
