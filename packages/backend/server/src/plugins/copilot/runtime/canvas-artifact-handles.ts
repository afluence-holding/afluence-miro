import {
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { Config } from '../../../base';
import { CryptoHelper } from '../../../base/helpers/crypto';
import { BackendRuntimeProvider } from '../../../core/backend-runtime';
import { PermissionAccess } from '../../../core/permission';
import { StorageRuntimeProvider } from '../../../core/storage-runtime';

const HANDLE_PREFIX = 'cah_';
const HANDLE_VERSION = 1;
const HANDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

export async function readCanvasArtifactBody(
  request: AsyncIterable<Uint8Array | Buffer>
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.byteLength;
    if (size > MAX_ARTIFACT_BYTES) {
      throw new PayloadTooLargeException('Canvas artifact exceeds 64 MiB');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

type HandlePayload = {
  v: 1;
  kind: 'import' | 'export';
  workspaceId: string;
  sessionId: string;
  artifactId: string;
  docId?: string;
  expiresAt: number;
};

export type CanvasArtifactHandle = {
  handle: string;
  mimeType: string;
  fileName?: string;
  size: number;
};

@Injectable()
export class CanvasArtifactHandleService {
  constructor(
    private readonly access: PermissionAccess,
    private readonly artifacts: BackendRuntimeProvider,
    private readonly crypto: CryptoHelper,
    private readonly db: PrismaClient,
    private readonly storage: StorageRuntimeProvider,
    private readonly config: Config
  ) {}

  private assertPersistentSigningKey() {
    // CryptoHelper intentionally makes an ephemeral development key when this
    // is unset. A 30-day handle signed with that key would silently fail after
    // a restart, so handles require the server's configured durable key.
    if (!this.config.crypto.privateKey) {
      throw new ServiceUnavailableException(
        'Canvas artifact handles require AFFINE_PRIVATE_KEY to remain available after restart.'
      );
    }
  }

  private sign(payload: HandlePayload) {
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString(
      'base64url'
    );
    return `${HANDLE_PREFIX}${this.crypto.sign(encoded)}`;
  }

  private parse(handle: string): HandlePayload {
    if (!handle.startsWith(HANDLE_PREFIX))
      throw new NotFoundException('Canvas artifact not found');
    const signed = handle.slice(HANDLE_PREFIX.length);
    if (!this.crypto.verify(signed))
      throw new NotFoundException('Canvas artifact not found');
    try {
      const [encoded] = signed.split(',', 1);
      const payload = JSON.parse(
        Buffer.from(encoded, 'base64url').toString('utf8')
      ) as HandlePayload;
      if (
        payload.v !== HANDLE_VERSION ||
        (payload.kind !== 'import' && payload.kind !== 'export') ||
        !payload.workspaceId ||
        !payload.sessionId ||
        !payload.artifactId ||
        !Number.isSafeInteger(payload.expiresAt) ||
        payload.expiresAt < Date.now()
      ) {
        throw new Error('invalid canvas artifact handle');
      }
      return payload;
    } catch {
      throw new NotFoundException('Canvas artifact not found');
    }
  }

  private async assertSession(
    userId: string,
    workspaceId: string,
    sessionId: string
  ) {
    const session = await this.db.aiSession.findFirst({
      where: { id: sessionId, userId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!session) throw new NotFoundException('Canvas artifact not found');
  }

  private async assertDocRead(
    userId: string,
    workspaceId: string,
    docId: string
  ) {
    await this.access
      .user(userId)
      .workspace(workspaceId)
      .doc(docId)
      .assert('Doc.Read');
  }

  private async artifactFor(payload: HandlePayload, userId: string) {
    await this.assertSession(userId, payload.workspaceId, payload.sessionId);
    if (payload.docId) {
      await this.assertDocRead(userId, payload.workspaceId, payload.docId);
    } else {
      await this.access
        .user(userId)
        .workspace(payload.workspaceId)
        .allowLocal()
        .assert('Workspace.Read');
    }
    if (payload.kind === 'import') {
      const reference = await this.db.aiMessageArtifact.findFirst({
        where: {
          workspaceId: payload.workspaceId,
          artifactId: payload.artifactId,
          role: 'attachment',
          message: { sessionId: payload.sessionId },
        },
        select: { artifactId: true },
      });
      if (!reference) throw new NotFoundException('Canvas artifact not found');
    }
    const artifact = await this.db.workspaceArtifact.findFirst({
      where: {
        id: payload.artifactId,
        workspaceId: payload.workspaceId,
        status: 'ready',
        storageScope: 'copilot',
      },
      select: {
        canonicalMediaType: true,
        fileName: true,
        sizeBytes: true,
        storageKey: true,
      },
    });
    if (!artifact || artifact.sizeBytes > BigInt(MAX_ARTIFACT_BYTES)) {
      throw new NotFoundException('Canvas artifact not found');
    }
    return artifact;
  }

  async issueImportHandle(input: {
    userId: string;
    workspaceId: string;
    sessionId: string;
    artifactId: string;
  }): Promise<CanvasArtifactHandle> {
    this.assertPersistentSigningKey();
    await this.assertSession(input.userId, input.workspaceId, input.sessionId);
    await this.access
      .user(input.userId)
      .workspace(input.workspaceId)
      .allowLocal()
      .assert('Workspace.Read');
    const artifact = await this.db.workspaceArtifact.findFirst({
      where: {
        id: input.artifactId,
        workspaceId: input.workspaceId,
        status: 'ready',
        storageScope: 'copilot',
      },
      select: { canonicalMediaType: true, fileName: true, sizeBytes: true },
    });
    if (!artifact || artifact.sizeBytes > BigInt(MAX_ARTIFACT_BYTES)) {
      throw new NotFoundException('Canvas artifact not found');
    }
    const payload: HandlePayload = {
      v: HANDLE_VERSION,
      kind: 'import',
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      artifactId: input.artifactId,
      expiresAt: Date.now() + HANDLE_TTL_MS,
    };
    return {
      handle: this.sign(payload),
      mimeType: artifact.canonicalMediaType,
      fileName: artifact.fileName ?? undefined,
      size: Number(artifact.sizeBytes),
    };
  }

  async persistExport(input: {
    userId: string;
    workspaceId: string;
    sessionId: string;
    docId: string;
    body: Buffer;
    mimeType: string;
    fileName: string;
  }): Promise<CanvasArtifactHandle> {
    this.assertPersistentSigningKey();
    if (
      input.body.byteLength === 0 ||
      input.body.byteLength > MAX_ARTIFACT_BYTES
    ) {
      throw new NotFoundException('Canvas artifact not found');
    }
    await this.assertSession(input.userId, input.workspaceId, input.sessionId);
    await this.assertDocRead(input.userId, input.workspaceId, input.docId);
    const artifact = await this.artifacts.putWorkspaceArtifact(
      {
        workspaceId: input.workspaceId,
        mimeType: input.mimeType,
        fileName: input.fileName,
        libraryOwned: false,
      },
      input.body
    );
    const payload: HandlePayload = {
      v: HANDLE_VERSION,
      kind: 'export',
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      artifactId: artifact.id,
      docId: input.docId,
      expiresAt: Date.now() + HANDLE_TTL_MS,
    };
    return {
      handle: this.sign(payload),
      mimeType: artifact.canonicalMediaType,
      fileName: artifact.fileName ?? input.fileName,
      size: Number(artifact.size),
    };
  }

  async read(userId: string, handle: string) {
    this.assertPersistentSigningKey();
    const payload = this.parse(handle);
    const artifact = await this.artifactFor(payload, userId);
    const object = await this.storage.getObject('copilot', artifact.storageKey);
    if (
      !object.body ||
      (object.metadata?.contentLength !== undefined &&
        object.metadata.contentLength > MAX_ARTIFACT_BYTES)
    ) {
      throw new NotFoundException('Canvas artifact not found');
    }
    return {
      body: object.body,
      mimeType: artifact.canonicalMediaType,
      fileName: artifact.fileName ?? `${payload.kind}-canvas`,
      size: Number(artifact.sizeBytes),
    };
  }
}
