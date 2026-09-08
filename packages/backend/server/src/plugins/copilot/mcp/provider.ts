import { validateCanvasToolArgs } from '@affine/realtime/canvas';
import { Injectable } from '@nestjs/common';
import { McpAccessMode } from '@prisma/client';
import z from 'zod/v3';

import { DocReader, DocWriter } from '../../../core/doc';
import { PermissionAccess } from '../../../core/permission';
import { DelegatedEditorService } from '../delegated/service';
import { DocumentRetrievalService } from '../retrieval/document';
import { type CanvasToolName, CanvasToolSchemas } from '../tools/canvas';
import { toToolJsonSchema } from '../tools/json-schema';
import {
  mcpCanvasRequestAllowed,
  restrictCanvasCapabilitiesForReadOnlyMcp,
} from './canvas-policy';

type McpTextContent = {
  type: 'text';
  text: string;
};

export type WorkspaceMcpToolResult = {
  content: McpTextContent[];
  isError?: boolean;
};

export type WorkspaceMcpToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    options: { signal: AbortSignal }
  ) => Promise<WorkspaceMcpToolResult>;
};

export type WorkspaceMcpServer = {
  name: string;
  version: string;
  tools: WorkspaceMcpToolDefinition[];
};

type ToolExecutorInput<T extends z.ZodTypeAny> = {
  name: string;
  title: string;
  description: string;
  parser: T;
  inputSchema: Record<string, unknown>;
  execute: (
    args: z.infer<T>,
    options: { signal: AbortSignal }
  ) => Promise<WorkspaceMcpToolResult>;
};

function toolText(text: string): WorkspaceMcpToolResult {
  return {
    content: [{ type: 'text', text }],
  };
}

function toolError(message: string): WorkspaceMcpToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

function toInputError(error: z.ZodError) {
  const details = error.issues
    .map(issue => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
  return toolError(`Invalid arguments: ${details || 'Invalid input'}`);
}

function abortIfNeeded(
  signal: AbortSignal
): WorkspaceMcpToolResult | undefined {
  if (signal.aborted) return toolError('Request aborted.');
  return;
}

function canvasInputSchema(tool: CanvasToolName): Record<string, unknown> {
  const schema = toToolJsonSchema(CanvasToolSchemas[tool]);
  const properties =
    schema.properties && typeof schema.properties === 'object'
      ? (schema.properties as Record<string, unknown>)
      : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === 'string')
    : [];
  return {
    ...schema,
    type: 'object',
    properties: {
      clientId: {
        type: 'string',
        description:
          'Explicit live Edgeless editor client ID returned by the application.',
      },
      docId: {
        type: 'string',
        description:
          'Explicit document ID currently bound to that live editor.',
      },
      ...properties,
    },
    required: ['clientId', 'docId', ...required],
    additionalProperties: false,
  };
}

function canvasResult(result: unknown): WorkspaceMcpToolResult {
  const json = JSON.stringify(result);
  if (
    result &&
    typeof result === 'object' &&
    'error' in result &&
    (result as { error?: unknown }).error
  ) {
    return { isError: true, content: [{ type: 'text', text: json }] };
  }
  return toolText(json);
}

const CanvasMcpTools: ReadonlyArray<{
  name: CanvasToolName;
  title: string;
  description: string;
}> = [
  {
    name: 'canvas_capabilities',
    title: 'Canvas Capabilities',
    description:
      'Read the versioned capabilities of one explicitly selected live Edgeless editor.',
  },
  {
    name: 'canvas_read',
    title: 'Canvas Read',
    description:
      'Read a bounded, revisioned projection from one explicitly selected live Edgeless editor.',
  },
  {
    name: 'canvas_validate',
    title: 'Canvas Validate',
    description:
      'Validate a typed native canvas operation batch and return an immutable plan without writing.',
  },
  {
    name: 'canvas_layout',
    title: 'Canvas Layout',
    description:
      'Prepare an exact canvas-unit layout plan without moving objects.',
  },
  {
    name: 'canvas_render',
    title: 'Canvas Render',
    description:
      'Render an explicit live-canvas scope or plan preview with its real revision metadata.',
  },
  {
    name: 'canvas_apply',
    title: 'Canvas Apply',
    description:
      'Apply a previously validated plan with an idempotent requestId and return its receipt.',
  },
  {
    name: 'canvas_operation',
    title: 'Canvas Operation',
    description:
      'Read or control one named canvas operation. Cancel, revert, and redo may write.',
  },
  {
    name: 'canvas_focus',
    title: 'Canvas Focus',
    description:
      'Focus or select an explicit scope in the selected live editor without changing document content.',
  },
  {
    name: 'canvas_import',
    title: 'Canvas Import',
    description:
      'Prepare an import plan from typed content for the selected live canvas; apply it separately.',
  },
  {
    name: 'canvas_export',
    title: 'Canvas Export',
    description:
      'Export an explicit live-canvas scope and return an authorized artifact report.',
  },
];

function defineTool<T extends z.ZodTypeAny>(
  config: ToolExecutorInput<T>
): WorkspaceMcpToolDefinition {
  return {
    name: config.name,
    title: config.title,
    description: config.description,
    inputSchema: config.inputSchema,
    execute: async (args, options) => {
      const aborted = abortIfNeeded(options.signal);
      if (aborted) return aborted;

      const parsed = config.parser.safeParse(args ?? {});
      if (!parsed.success) return toInputError(parsed.error);
      return await config.execute(parsed.data, options);
    },
  };
}

@Injectable()
export class WorkspaceMcpProvider {
  constructor(
    private readonly ac: PermissionAccess,
    private readonly reader: DocReader,
    private readonly writer: DocWriter,
    private readonly retrieval: DocumentRetrievalService,
    private readonly delegated: DelegatedEditorService
  ) {}

  async for(
    userId: string,
    workspaceId: string,
    accessMode: McpAccessMode = McpAccessMode.READ_ONLY
  ): Promise<WorkspaceMcpServer> {
    await this.ac.user(userId).workspace(workspaceId).assert('Workspace.Read');

    const readDocument = defineTool({
      name: 'read_document',
      title: 'Read Document',
      description: 'Read a document with given ID',
      parser: z.object({ docId: z.string() }),
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
        },
        required: ['docId'],
        additionalProperties: false,
      },
      execute: async ({ docId }, options) => {
        const notFoundError = toolError(`Doc with id ${docId} not found.`);

        const accessible = await this.ac
          .user(userId)
          .workspace(workspaceId)
          .doc(docId)
          .can('Doc.Read');
        if (!accessible) return notFoundError;

        const abortedAfterPermission = abortIfNeeded(options.signal);
        if (abortedAfterPermission) return abortedAfterPermission;

        const content = await this.reader.getDocMarkdown(
          workspaceId,
          docId,
          false
        );
        if (!content) return notFoundError;

        const abortedAfterRead = abortIfNeeded(options.signal);
        if (abortedAfterRead) return abortedAfterRead;

        return toolText(content.markdown);
      },
    });

    const docSearch = defineTool({
      name: 'doc_search',
      title: 'Document Search',
      description:
        'Search persisted workspace documents and return bounded passages with Page or canvas locators. Retrieval strategy is selected by the server and never includes files, blobs, attachments, or the web.',
      parser: z.object({
        query: z.string().trim().min(1).max(2000),
        doc_ids: z.array(z.string().min(1).max(128)).max(50).optional(),
        limit: z.number().int().min(1).max(20).optional(),
      }),
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          doc_ids: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 50,
          },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      execute: async ({ query, doc_ids, limit }, options) => {
        const result = await this.retrieval.search(
          { user: userId, workspace: workspaceId },
          query,
          doc_ids,
          limit ?? 10,
          options.signal
        );
        return toolText(
          JSON.stringify({
            retrieval_mode: result.retrievalMode,
            degraded_reason: result.degradedReason,
            hits: result.hits.map(hit => ({
              doc_id: hit.docId,
              title: hit.title,
              excerpt: hit.excerpt,
              visibility: hit.visibility,
              block_id: hit.blockId,
              element_id: hit.elementId,
              frame_id: hit.frameId,
            })),
          })
        );
      },
    });

    const canvasEditors = defineTool({
      name: 'canvas_editors',
      title: 'Available Canvas Editors',
      description:
        'List live Edgeless editors registered by an open chat in this workspace. Use one returned clientId/docId pair explicitly; never infer an editor.',
      parser: z.object({}).strict(),
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      execute: async (_input, options) => {
        const result = await this.delegated.listCanvasEditors(
          userId,
          workspaceId
        );
        const aborted = abortIfNeeded(options.signal);
        if (aborted) return aborted;
        return toolText(JSON.stringify(result));
      },
    });

    const canvasTools = CanvasMcpTools.filter(tool =>
      this.delegated.canvasToolEnabled(tool.name, { tool: tool.name }, 'mcp')
    ).map(tool =>
      defineTool({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        parser: z
          .object({ clientId: z.string().min(1), docId: z.string().min(1) })
          .passthrough(),
        inputSchema: canvasInputSchema(tool.name),
        execute: async ({ clientId, docId, ...canvasArgs }, options) => {
          const parsed = CanvasToolSchemas[tool.name].safeParse(canvasArgs);
          if (!parsed.success) {
            return toolError(
              `Invalid canvas arguments: ${parsed.error.issues
                .map(
                  issue =>
                    `${issue.path.join('.') || 'input'}: ${issue.message}`
                )
                .join('; ')}`
            );
          }

          const shared = validateCanvasToolArgs(tool.name, canvasArgs);
          if (!shared.ok) {
            return toolError(
              JSON.stringify({ ok: false, error: shared.error })
            );
          }
          const canvasData = shared.value as unknown as Record<string, unknown>;
          if (
            !mcpCanvasRequestAllowed(
              accessMode === McpAccessMode.READ_WRITE,
              tool.name,
              canvasData
            )
          ) {
            return toolError(
              JSON.stringify({
                ok: false,
                error: {
                  code: 'PERMISSION_DENIED',
                  message: 'This MCP credential is read-only.',
                },
              })
            );
          }
          const destination =
            canvasData.destination &&
            typeof canvasData.destination === 'object' &&
            !Array.isArray(canvasData.destination)
              ? (canvasData.destination as Record<string, unknown>)
              : undefined;
          if (
            destination &&
            destination.type === 'existing' &&
            destination.documentId !== docId
          ) {
            return toolError(
              'Invalid canvas arguments: destination.documentId must equal the explicit docId editor binding.'
            );
          }
          if (
            destination &&
            destination.type === 'new_document' &&
            destination.workspaceId !== workspaceId
          ) {
            return toolError(
              'Invalid canvas arguments: destination.workspaceId must equal the MCP workspace.'
            );
          }

          const result = await this.delegated.executeCanvasFromMcp(
            userId,
            workspaceId,
            clientId,
            docId,
            { tool: tool.name, ...canvasData },
            options.signal,
            undefined,
            accessMode === McpAccessMode.READ_WRITE
          );
          return canvasResult(
            tool.name === 'canvas_capabilities' &&
              accessMode !== McpAccessMode.READ_WRITE
              ? restrictCanvasCapabilitiesForReadOnlyMcp(result)
              : result
          );
        },
      })
    );

    const tools = [readDocument, docSearch, canvasEditors, ...canvasTools];

    if (
      accessMode === McpAccessMode.READ_WRITE &&
      (env.dev || env.namespaces.canary)
    ) {
      const createDocument = defineTool({
        name: 'create_document',
        title: 'Create Document',
        description:
          'Create a new document in the workspace with the given title and markdown content. Returns the ID of the created document. This tool not support insert or update database block and image yet.',
        parser: z.object({
          title: z.string().min(1),
          content: z.string(),
        }),
        inputSchema: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description: 'The title of the new document',
            },
            content: {
              type: 'string',
              description: 'The markdown content for the document body',
            },
          },
          required: ['title', 'content'],
          additionalProperties: false,
        },
        execute: async ({ title, content }, options) => {
          try {
            await this.ac
              .user(userId)
              .workspace(workspaceId)
              .assert('Workspace.CreateDoc');

            const abortedAfterPermission = abortIfNeeded(options.signal);
            if (abortedAfterPermission) return abortedAfterPermission;

            const sanitizedTitle = title.replace(/[\r\n]+/g, ' ').trim();
            if (!sanitizedTitle) throw new Error('Title cannot be empty');
            const strippedContent = content.replace(
              /^[ \t]{0,3}#\s+[^\n]*#*\s*\n*/,
              ''
            );
            const result = await this.writer.createDoc(
              workspaceId,
              sanitizedTitle,
              strippedContent,
              userId
            );

            return toolText(
              JSON.stringify({
                success: true,
                docId: result.docId,
                message: `Document "${title}" created successfully`,
              })
            );
          } catch (error) {
            return toolError(
              `Failed to create document: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }
        },
      });

      const updateDocument = defineTool({
        name: 'update_document',
        title: 'Update Document',
        description:
          'Update an existing document with new markdown content (body only). Uses structural diffing to apply minimal changes, preserving document history and enabling real-time collaboration. This does NOT update the document title. This tool not support insert or update database block and image yet.',
        parser: z.object({
          docId: z.string(),
          content: z.string(),
        }),
        inputSchema: {
          type: 'object',
          properties: {
            docId: {
              type: 'string',
              description: 'The ID of the document to update',
            },
            content: {
              type: 'string',
              description:
                'The complete new markdown content for the document body (do NOT include a title H1)',
            },
          },
          required: ['docId', 'content'],
          additionalProperties: false,
        },
        execute: async ({ docId, content }, options) => {
          const notFoundError = toolError(`Doc with id ${docId} not found.`);

          const accessible = await this.ac
            .user(userId)
            .workspace(workspaceId)
            .doc(docId)
            .can('Doc.Update');
          if (!accessible) return notFoundError;

          const abortedBeforeWrite = abortIfNeeded(options.signal);
          if (abortedBeforeWrite) return abortedBeforeWrite;

          try {
            await this.writer.updateDoc(workspaceId, docId, content, userId);
            return toolText(
              JSON.stringify({
                success: true,
                docId,
                message: 'Document updated successfully',
              })
            );
          } catch (error) {
            return toolError(
              `Failed to update document: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }
        },
      });

      const updateDocumentMeta = defineTool({
        name: 'update_document_meta',
        title: 'Update Document Metadata',
        description: 'Update document metadata (currently title only).',
        parser: z.object({
          docId: z.string(),
          title: z.string().min(1),
        }),
        inputSchema: {
          type: 'object',
          properties: {
            docId: {
              type: 'string',
              description: 'The ID of the document to update',
            },
            title: {
              type: 'string',
              description: 'The new document title',
            },
          },
          required: ['docId', 'title'],
          additionalProperties: false,
        },
        execute: async ({ docId, title }, options) => {
          const notFoundError = toolError(`Doc with id ${docId} not found.`);

          const accessible = await this.ac
            .user(userId)
            .workspace(workspaceId)
            .doc(docId)
            .can('Doc.Update');
          if (!accessible) return notFoundError;

          const abortedAfterPermission = abortIfNeeded(options.signal);
          if (abortedAfterPermission) return abortedAfterPermission;

          try {
            const sanitizedTitle = title.replace(/[\r\n]+/g, ' ').trim();
            if (!sanitizedTitle) throw new Error('Title cannot be empty');

            await this.writer.updateDocMeta(
              workspaceId,
              docId,
              { title: sanitizedTitle },
              userId
            );

            return toolText(
              JSON.stringify({
                success: true,
                docId,
                message: 'Document title updated successfully',
              })
            );
          } catch (error) {
            return toolError(
              `Failed to update document metadata: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }
        },
      });

      tools.push(createDocument, updateDocument, updateDocumentMeta);
    }

    return {
      name: `AFFiNE MCP Server for Workspace ${workspaceId}`,
      version: '1.0.1',
      tools,
    };
  }
}
