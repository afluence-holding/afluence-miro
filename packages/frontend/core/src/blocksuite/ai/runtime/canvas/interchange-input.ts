import type {
  CanvasBounds,
  CanvasInterchangeFormat,
  CanvasJsonValue,
  CanvasNode,
  CanvasXmlElement,
  CanvasXmlParser,
} from '@affine/realtime/canvas';

const MAX_TEXT_BYTES = 8 * 1024 * 1024;

/** A handle is data, never a URL or code to evaluate. Resolution remains authenticated. */
export async function readInterchangeInput(
  format: CanvasInterchangeFormat,
  content: CanvasJsonValue,
  resolve: (handle: string) => Promise<Blob>
): Promise<CanvasJsonValue> {
  let value = content;
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'kind' in value &&
    value.kind === 'artifact_handle'
  ) {
    if (typeof value.handle !== 'string')
      throw new Error('INVALID_PLAN: Artifact handle is missing.');
    const blob = await resolve(value.handle);
    if (blob.size > MAX_TEXT_BYTES)
      throw new Error('BUDGET_EXCEEDED: Canvas text import exceeds 8 MiB.');
    value = await blob.text();
  }
  if (typeof value === 'string') {
    if (new TextEncoder().encode(value).length > MAX_TEXT_BYTES)
      throw new Error('BUDGET_EXCEEDED: Canvas text import exceeds 8 MiB.');
    if (format === 'recipe' || format === 'excalidraw') {
      try {
        return JSON.parse(value) as CanvasJsonValue;
      } catch {
        throw new Error('INVALID_PLAN: Canvas JSON could not be parsed.');
      }
    }
  }
  return value;
}

export const canvasXmlParser: CanvasXmlParser = {
  parse(xml) {
    if (/<!DOCTYPE|<!ENTITY/i.test(xml))
      throw new Error('DTD and entities are forbidden.');
    if (typeof DOMParser === 'undefined')
      throw new Error('XML parser is unavailable.');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('Malformed XML.');
    let count = 0;
    const convert = (element: Element, depth: number): CanvasXmlElement => {
      if (++count > 10000 || depth > 64)
        throw new Error('XML structure exceeds limits.');
      return {
        name: element.localName,
        attributes: Object.fromEntries(
          [...element.attributes].map(attribute => [
            attribute.name,
            attribute.value,
          ])
        ),
        children: [...element.children].map(child => convert(child, depth + 1)),
      };
    };
    return convert(doc.documentElement, 0);
  },
};

/** Importing an editable copy always allocates fresh identities, even in its source doc. */
export function placeImportedCanvas(
  nodes: readonly CanvasNode[],
  placement?: CanvasBounds,
  allocate = () => `canvas_${crypto.randomUUID()}`
) {
  const idMap = Object.fromEntries(nodes.map(node => [node.id, allocate()]));
  const bodies = nodes.filter(node => node.kind !== 'connector');
  const x = Math.min(
    ...(bodies.length ? bodies : nodes).map(node => node.bounds.x)
  );
  const y = Math.min(
    ...(bodies.length ? bodies : nodes).map(node => node.bounds.y)
  );
  const dx = placement && nodes.length ? placement.x - x : 0;
  const dy = placement && nodes.length ? placement.y - y : 0;
  const remap = (id: string | undefined) =>
    id === undefined ? undefined : (idMap[id] ?? id);
  return {
    idMap,
    nodes: nodes.map(node => ({
      ...node,
      id: idMap[node.id],
      ref: undefined,
      bounds: { ...node.bounds, x: node.bounds.x + dx, y: node.bounds.y + dy },
      ...(node.parentId ? { parentId: remap(node.parentId) } : {}),
      ...(node.sourceId ? { sourceId: remap(node.sourceId) } : {}),
      ...(node.targetId ? { targetId: remap(node.targetId) } : {}),
    })),
  };
}
