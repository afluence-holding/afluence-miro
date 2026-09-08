import type { CanvasNode } from '@affine/realtime/canvas';
import { describe, expect, it } from 'vitest';

import {
  NATIVE_PRIMITIVE_REGISTRY,
  nativePrimitiveCreateProps,
  remapNativePrimitiveRelations,
  snapshotNativePrimitive,
  validateNativePrimitiveNode,
} from './native-primitives';

function node(
  kind: CanvasNode['kind'],
  props: CanvasNode['props']
): CanvasNode {
  return {
    id: `draft-${kind}`,
    kind,
    bounds: { x: 100, y: 100, w: 160, h: 80 },
    props,
  };
}

describe('native canvas primitives', () => {
  it('declares the seven native primitives and validates finite brush points', () => {
    expect(NATIVE_PRIMITIVE_REGISTRY.map(entry => entry.kind)).toEqual([
      'shape',
      'text',
      'brush',
      'highlighter',
      'connector',
      'group',
      'mindmap',
    ]);
    expect(
      NATIVE_PRIMITIVE_REGISTRY.find(entry => entry.kind === 'connector')
        ?.editableProps
    ).toContain('routing');
    expect(
      validateNativePrimitiveNode(
        node('brush', {
          points: [
            [100, 100],
            [180, 140, 0.5],
            [260, 100],
          ],
          color: '#1677ff',
          lineWidth: 4,
        })
      )
    ).toEqual({ ok: true, errors: [] });
    expect(
      validateNativePrimitiveNode(
        node('highlighter', {
          points: [[100, Number.NaN]],
          color: '#ffff00',
          lineWidth: 12,
        })
      )
    ).toMatchObject({ ok: false });
  });

  it('creates native brush/highlighter props without changing world points', () => {
    const brush = node('brush', {
      points: [
        [100, 100],
        [180, 140],
        [260, 100],
      ],
      color: '#1677ff',
      lineWidth: 4,
    });
    expect(nativePrimitiveCreateProps(brush)).toEqual({
      type: 'brush',
      points: brush.props.points,
      color: '#1677ff',
      lineWidth: 4,
    });
    expect(
      nativePrimitiveCreateProps(
        node('highlighter', {
          points: [
            [100, 220],
            [240, 220],
          ],
          color: '#fff200',
          lineWidth: 12,
        })
      )
    ).toMatchObject({ type: 'highlighter', lineWidth: 12 });
    expect(
      snapshotNativePrimitive({
        type: 'brush',
        x: 96,
        y: 96,
        props: {
          points: [
            [4, 4],
            [84, 44],
          ],
          color: '#1677ff',
          lineWidth: 4,
        },
      })
    ).toMatchObject({
      points: [
        [100, 100],
        [180, 140],
      ],
    });
  });

  it('round-trips a semantic mindmap tree and remaps group children', () => {
    const mindmap = node('mindmap', {
      tree: {
        text: 'Canales',
        children: [
          { text: 'Orgánico', children: [{ text: 'Instagram' }] },
          { text: 'Pagado' },
        ],
      },
      layoutType: 1,
      style: 2,
    });
    expect(nativePrimitiveCreateProps(mindmap)).toMatchObject({
      type: 'mindmap',
      children: mindmap.props.tree,
      layoutType: 1,
      style: 2,
    });
    expect(
      snapshotNativePrimitive({
        type: 'mindmap',
        layoutType: 1,
        style: 2,
        tree: {
          element: { props: { text: 'Canales' } },
          children: [
            { element: { props: { text: 'Orgánico' } }, children: [] },
          ],
        },
      })
    ).toEqual({
      tree: { text: 'Canales', children: [{ text: 'Orgánico' }] },
      layoutType: 1,
      style: 2,
    });
    expect(
      remapNativePrimitiveRelations(['draft-a', 'native-b'], {
        'draft-a': 'a1',
      })
    ).toEqual(['a1', 'native-b']);
  });
});
