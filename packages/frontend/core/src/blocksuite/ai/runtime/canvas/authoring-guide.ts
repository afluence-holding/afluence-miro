import {
  ConnectorMode,
  FontFamily,
  FontStyle,
  FontWeight,
  LayoutType,
  MindmapStyle,
  PointStyle,
  ShapeStyle,
  ShapeType,
  TextAlign,
  TextVerticalAlign,
} from '@blocksuite/affine/model';

/** Small, discoverable native recipes keep models from guessing enum values or Yjs structures. */
export const CANVAS_AUTHORING_GUIDE = {
  coordinates:
    'All bounds and gaps are world units, independent of zoom. Inline blocks flow inside a note; their bounds do not position them independently.',
  semantics:
    'Read existing colors/fonts first. Use a restrained palette already in the board. design.order defines reading order; design.role selects hierarchy; layout:fixed/preserve protects explicit geometry. Pass nodes and connectors together to canvas_layout for graph structure.',
  constraints:
    'Use parentId for native note/block hierarchy or a frame/group, never for a process dependency. Connector direction is sourceId → targetId. frontEndpointStyle decorates the source/start; rearEndpointStyle decorates the target/end. For a standard forward arrow use frontEndpointStyle:None and rearEndpointStyle:Arrow. Do not put IDs, children, source or target inside arbitrary props. A page and surface are created only by document lifecycle.',
  connectorDirection: {
    flow: 'sourceId → targetId',
    frontEndpointStyle: 'marker at sourceId (the start)',
    rearEndpointStyle: 'marker at targetId (the end)',
    standardArrow: {
      frontEndpointStyle: PointStyle.None,
      rearEndpointStyle: PointStyle.Arrow,
    },
  },
  nativeHierarchy: {
    note: 'Use kind:"note" for the recommended spatial rich-content container; the document page parent is assigned automatically.',
    children:
      'Create inline block:* children with parentId set to the local note ID, for example note → block:affine:paragraph → block:affine:list.',
  },
  enumValues: {
    shapeType: Object.values(ShapeType),
    shapeStyle: Object.values(ShapeStyle),
    fontFamily: Object.values(FontFamily),
    fontWeight: Object.values(FontWeight),
    fontStyle: Object.values(FontStyle),
    textAlign: Object.values(TextAlign),
    textVerticalAlign: Object.values(TextVerticalAlign),
    connectorMode: {
      straight: ConnectorMode.Straight,
      orthogonal: ConnectorMode.Orthogonal,
      curve: ConnectorMode.Curve,
    },
    connectorEndpoints: Object.values(PointStyle),
    mindmapLayout: {
      right: LayoutType.RIGHT,
      left: LayoutType.LEFT,
      balanced: LayoutType.BALANCE,
    },
    mindmapStyle: [
      MindmapStyle.ONE,
      MindmapStyle.TWO,
      MindmapStyle.THREE,
      MindmapStyle.FOUR,
    ],
  },
  examples: {
    shape: {
      id: 'stage',
      kind: 'shape',
      bounds: { x: 0, y: 0, w: 240, h: 96 },
      layout: 'auto',
      design: { role: 'body', order: 0 },
      props: {
        shapeType: ShapeType.Rect,
        text: 'Etapa',
        fontFamily: FontFamily.Inter,
        fontSize: 20,
        fontWeight: FontWeight.Regular,
        textAlign: TextAlign.Center,
      },
    },
    connector: {
      id: 'edge',
      kind: 'connector',
      sourceId: 'stage',
      targetId: 'next',
      bounds: { x: 0, y: 0, w: 1, h: 1 },
      props: {
        mode: ConnectorMode.Orthogonal,
        routing: 'avoid-obstacles',
        frontEndpointStyle: PointStyle.None,
        rearEndpointStyle: PointStyle.Arrow,
        text: 'Sí',
      },
    },
    note: {
      id: 'note',
      kind: 'note',
      bounds: { x: 0, y: 0, w: 480, h: 240 },
      props: { background: '--affine-palette-shape-yellow' },
    },
    paragraph: {
      id: 'paragraph',
      kind: 'block:affine:paragraph',
      parentId: 'note',
      bounds: { x: 0, y: 0, w: 1, h: 1 },
      props: {
        type: 'text',
        richText: [
          { insert: 'Contenido ', attributes: {} },
          { insert: 'editable', attributes: { bold: true } },
        ],
      },
    },
    table: {
      id: 'table',
      kind: 'block:affine:table',
      parentId: 'note',
      bounds: { x: 0, y: 0, w: 1, h: 1 },
      props: {
        table: {
          rows: [{ id: 'r1' }],
          columns: [{ id: 'c1', width: 200 }],
          cells: { 'r1:c1': 'Dato' },
        },
      },
    },
    mindmap: {
      id: 'map',
      kind: 'mindmap',
      bounds: { x: 0, y: 0, w: 500, h: 300 },
      props: {
        layoutType: LayoutType.RIGHT,
        style: MindmapStyle.ONE,
        tree: {
          text: 'Idea central',
          children: [{ text: 'Primera rama' }, { text: 'Segunda rama' }],
        },
      },
    },
  },
} as const;
