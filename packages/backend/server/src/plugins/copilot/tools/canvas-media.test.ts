import { describe, expect, it } from 'vitest';

import type { LlmToolCallbackResponse } from '../../../native';
import { normalizeCanvasRenderToolResponse } from './canvas-media';

describe('native canvas tool callback serialization', () => {
  it('keeps a capabilities response in the Rust callback shape', () => {
    const response: LlmToolCallbackResponse = {
      callId: 'call-capabilities',
      name: 'canvas_capabilities',
      args: { destination: { type: 'existing', documentId: 'doc' } },
      output: { ok: true, data: { tools: ['canvas_read'] } },
    };

    const serialized = JSON.parse(
      JSON.stringify(normalizeCanvasRenderToolResponse(response))
    );

    expect(serialized).toEqual(response);
    expect(serialized).not.toHaveProperty('response');
  });

  it('serializes render media beside output and preserves tool errors', () => {
    const image = Buffer.from('canvas preview').toString('base64');
    const render: LlmToolCallbackResponse = {
      callId: 'call-render',
      name: 'canvas_render',
      args: {},
      output: {
        ok: true,
        data: {
          artifact: {
            mimeType: 'image/png',
            dataUrl: `data:image/png;base64,${image}`,
          },
        },
      },
    };
    const failure: LlmToolCallbackResponse = {
      callId: 'call-failure',
      name: 'canvas_capabilities',
      args: {},
      output: { message: 'editor unavailable' },
      isError: true,
    };

    const rendered = JSON.parse(
      JSON.stringify(normalizeCanvasRenderToolResponse(render))
    );
    const errored = JSON.parse(
      JSON.stringify(normalizeCanvasRenderToolResponse(failure))
    );

    expect(rendered).toMatchObject({
      callId: 'call-render',
      name: 'canvas_render',
      args: {},
      output: {
        ok: true,
        data: {
          artifact: { mimeType: 'image/png' },
          visualVerificationDeliveredToModel: false,
        },
      },
      media: [{ mimeType: 'image/png', data: image }],
    });
    expect(JSON.stringify(rendered.output)).not.toContain(image);
    expect(rendered).not.toHaveProperty('response');
    expect(errored).toEqual(failure);
    expect(errored).not.toHaveProperty('response');
  });
});
