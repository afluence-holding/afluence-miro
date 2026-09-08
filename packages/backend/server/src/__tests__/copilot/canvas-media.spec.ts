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

test('canvas render media becomes a bounded native image part and never tool-result text', t => {
  const source = Buffer.from('small canvas image').toString('base64');
  const normalized = normalizeCanvasRenderToolResponse(
    renderResponse(`data:image/png;base64,${source}`)
  );

  t.deepEqual(normalized.media, [{ mimeType: 'image/png', data: source }]);
  t.like(normalized.response.output, {
    ok: true,
    data: {
      artifact: { mimeType: 'image/png' },
      visualVerificationDeliveredToModel: false,
    },
  });
  t.false(JSON.stringify(normalized.response.output).includes(source));
});

test('canvas render defers vision delivery to the selected native route and rejects payloads over budget', t => {
  const source = Buffer.alloc(CanvasRenderMediaLimits.maxBytes + 1, 7).toString(
    'base64'
  );
  const tooLarge = normalizeCanvasRenderToolResponse(
    renderResponse(`data:image/png;base64,${source}`)
  );

  t.is(tooLarge.media, undefined);
  t.like(tooLarge.response.output, {
    data: { visualVerificationDeliveredToModel: false },
  });
});
