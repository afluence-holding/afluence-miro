import type { CanvasToolName } from '@affine/realtime/canvas';

const MCP_CANVAS_MUTATING_OPERATIONS = new Set([
  'cancel',
  'revert',
  'redo',
  'resume',
]);

export function isMcpCanvasMutation(
  tool: CanvasToolName,
  args: Readonly<Record<string, unknown>>
) {
  return (
    tool === 'canvas_apply' ||
    tool === 'canvas_import' ||
    (tool === 'canvas_operation' &&
      typeof args.action === 'string' &&
      MCP_CANVAS_MUTATING_OPERATIONS.has(args.action))
  );
}

/**
 * A read-only credential may inspect and render a linked canvas, including
 * operation status, but cannot cause a canvas mutation regardless of document
 * permissions held by its owner.
 */
export function mcpCanvasRequestAllowed(
  readWrite: boolean,
  tool: CanvasToolName,
  args: Readonly<Record<string, unknown>>
) {
  return readWrite || !isMcpCanvasMutation(tool, args);
}

export function restrictCanvasCapabilitiesForReadOnlyMcp(result: unknown) {
  if (
    !result ||
    typeof result !== 'object' ||
    !('ok' in result) ||
    result.ok !== true ||
    !('data' in result) ||
    !result.data ||
    typeof result.data !== 'object'
  ) {
    return result;
  }
  const data = result.data as Record<string, unknown>;
  const tools = Array.isArray(data.tools)
    ? data.tools.filter(
        tool =>
          tool !== 'canvas_apply' &&
          tool !== 'canvas_import' &&
          tool !== 'canvas_operation'
      )
    : data.tools;
  return {
    ...result,
    data: {
      ...data,
      tools,
      authorization: {
        ...(data.authorization &&
        typeof data.authorization === 'object' &&
        !Array.isArray(data.authorization)
          ? data.authorization
          : {}),
        canWrite: false,
      },
    },
  };
}
