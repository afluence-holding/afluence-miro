import { describe, expect, it } from 'vitest';

import {
  mcpCanvasRequestAllowed,
  restrictCanvasCapabilitiesForReadOnlyMcp,
} from '../mcp/canvas-policy';

describe('read-only MCP canvas policy', () => {
  it('rejects every mutating canvas action before delegation', () => {
    for (const [tool, args] of [
      ['canvas_apply', { planId: 'plan', requestId: 'request' }],
      ['canvas_import', { format: 'recipe' }],
      ['canvas_operation', { action: 'cancel', operationId: 'operation' }],
      ['canvas_operation', { action: 'revert', operationId: 'operation' }],
      ['canvas_operation', { action: 'redo', operationId: 'operation' }],
      [
        'canvas_operation',
        { action: 'resume', operationId: 'operation', requestId: 'resume' },
      ],
    ] as const) {
      expect(mcpCanvasRequestAllowed(false, tool, args)).toBe(false);
      expect(mcpCanvasRequestAllowed(true, tool, args)).toBe(true);
    }
  });

  it('allows read-only inspection, render previews, focus, and status', () => {
    for (const [tool, args] of [
      ['canvas_capabilities', {}],
      ['canvas_read', {}],
      ['canvas_render', {}],
      ['canvas_focus', {}],
      ['canvas_export', {}],
      ['canvas_operation', { action: 'status', requestId: 'request' }],
    ] as const) {
      expect(mcpCanvasRequestAllowed(false, tool, args)).toBe(true);
    }
  });

  it('removes unavailable mutable tools from a read-only capability manifest', () => {
    const result = restrictCanvasCapabilitiesForReadOnlyMcp({
      ok: true,
      data: {
        tools: [
          'canvas_capabilities',
          'canvas_read',
          'canvas_apply',
          'canvas_operation',
          'canvas_import',
          'canvas_render',
        ],
        authorization: { canWrite: true, canCreateDoc: true },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        tools: ['canvas_capabilities', 'canvas_read', 'canvas_render'],
        authorization: { canWrite: false, canCreateDoc: true },
      },
    });
  });
});
