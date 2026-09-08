import 'reflect-metadata';

import { Readable } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../native', () => ({}));
vi.mock('../../../base', () => ({ Config: class {}, OneMinute: 60_000 }));
vi.mock('../../../base/helpers/crypto', () => ({ CryptoHelper: class {} }));
vi.mock('../../../core/backend-runtime', () => ({
  BackendRuntimeProvider: class {},
}));
vi.mock('../../../core/permission', () => ({ PermissionAccess: class {} }));
vi.mock('../../../core/storage-runtime', () => ({
  StorageRuntimeProvider: class {},
}));

import {
  CanvasArtifactHandleService,
  readCanvasArtifactBody,
} from '../runtime/canvas-artifact-handles';

const MAX_BYTES = 64 * 1024 * 1024;

type FixtureState = {
  session: boolean;
  association: boolean;
  artifactSize: bigint;
  denyDocRead: boolean;
};

function fixture() {
  const state: FixtureState = {
    session: true,
    association: true,
    artifactSize: 12n,
    denyDocRead: false,
  };
  const assert = vi.fn(async (permission: string) => {
    if (permission === 'Doc.Read' && state.denyDocRead) {
      throw new Error('revoked');
    }
  });
  const builder = {
    user: vi.fn(() => builder),
    workspace: vi.fn(() => builder),
    doc: vi.fn(() => builder),
    allowLocal: vi.fn(() => builder),
    assert,
  };
  const db = {
    aiSession: {
      findFirst: vi.fn(async ({ where }: any) =>
        state.session && where.userId === 'owner' && where.workspaceId === 'ws'
          ? { id: 'session' }
          : null
      ),
    },
    aiMessageArtifact: {
      findFirst: vi.fn(async () =>
        state.association ? { artifactId: 'artifact' } : null
      ),
    },
    workspaceArtifact: {
      findFirst: vi.fn(async () => ({
        canonicalMediaType: 'image/png',
        fileName: 'canvas.png',
        sizeBytes: state.artifactSize,
        storageKey: 'artifacts/ws/hash',
      })),
    },
  };
  const crypto = {
    sign: (data: string) => `${data},signature`,
    verify: (value: string) => value.endsWith(',signature'),
  };
  const putWorkspaceArtifact = vi.fn(async () => ({
    id: 'export-artifact',
    canonicalMediaType: 'image/png',
    fileName: 'export.png',
    size: 3,
  }));
  const storage = {
    getObject: vi.fn(async () => ({
      body: Readable.from([Buffer.from('png')]),
      metadata: { contentLength: 3 },
    })),
  };
  const service = new CanvasArtifactHandleService(
    builder as any,
    { putWorkspaceArtifact } as any,
    crypto as any,
    db as any,
    storage as any,
    { crypto: { privateKey: 'persisted-test-key' } } as any
  );
  return { service, state, assert, storage, putWorkspaceArtifact };
}

async function importHandle(service: CanvasArtifactHandleService) {
  return await service.issueImportHandle({
    userId: 'owner',
    workspaceId: 'ws',
    sessionId: 'session',
    artifactId: 'artifact',
  });
}

describe('canvas artifact handles', () => {
  beforeEach(() => vi.useRealTimers());

  it('isolates handles by session owner and workspace', async () => {
    const f = fixture();
    const artifact = await importHandle(f.service);
    await expect(
      f.service.read('other-user', artifact.handle)
    ).rejects.toThrow();
    await expect(
      f.service.read('owner', artifact.handle)
    ).resolves.toMatchObject({
      mimeType: 'image/png',
    });
    expect(f.storage.getObject).toHaveBeenCalledWith(
      'copilot',
      'artifacts/ws/hash'
    );
  });

  it('rejects a handle issued for a different workspace even for the same user', async () => {
    const f = fixture();
    await expect(
      f.service.issueImportHandle({
        userId: 'owner',
        workspaceId: 'other-workspace',
        sessionId: 'session',
        artifactId: 'artifact',
      })
    ).rejects.toThrow();
    expect(f.storage.getObject).not.toHaveBeenCalled();
  });

  it('requires an attachment association before importing bytes', async () => {
    const f = fixture();
    const artifact = await importHandle(f.service);
    f.state.association = false;
    await expect(f.service.read('owner', artifact.handle)).rejects.toThrow();
    expect(f.storage.getObject).not.toHaveBeenCalled();
  });

  it('rechecks Doc.Read for export downloads after permission is revoked', async () => {
    const f = fixture();
    const exported = await f.service.persistExport({
      userId: 'owner',
      workspaceId: 'ws',
      sessionId: 'session',
      docId: 'doc',
      body: Buffer.from('png'),
      mimeType: 'image/png',
      fileName: 'export.png',
    });
    f.state.denyDocRead = true;
    await expect(f.service.read('owner', exported.handle)).rejects.toThrow(
      'revoked'
    );
    expect(f.putWorkspaceArtifact).toHaveBeenCalledOnce();
  });

  it('rejects tampered, expired, and oversized handles before a storage read', async () => {
    const f = fixture();
    const artifact = await importHandle(f.service);
    await expect(
      f.service.read('owner', `${artifact.handle}x`)
    ).rejects.toThrow();

    vi.useFakeTimers();
    vi.advanceTimersByTime(31 * 24 * 60 * 60 * 1000);
    await expect(f.service.read('owner', artifact.handle)).rejects.toThrow();
    vi.useRealTimers();

    const tooLarge = fixture();
    tooLarge.state.artifactSize = BigInt(MAX_BYTES + 1);
    await expect(importHandle(tooLarge.service)).rejects.toThrow();
  });

  it('enforces the binary POST limit from streamed bytes, not Content-Length', async () => {
    async function* chunks() {
      yield Buffer.alloc(MAX_BYTES, 1);
      yield Buffer.from([1]);
    }
    await expect(readCanvasArtifactBody(chunks())).rejects.toMatchObject({
      status: 413,
    });
  });

  it('refuses long-lived handles when the server has no persistent signing key', async () => {
    const f = fixture();
    const service = new CanvasArtifactHandleService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { crypto: { privateKey: '' } } as any
    );
    await expect(
      service.issueImportHandle({
        userId: 'owner',
        workspaceId: 'ws',
        sessionId: 'session',
        artifactId: 'artifact',
      })
    ).rejects.toMatchObject({ status: 503 });
    expect(f.storage.getObject).not.toHaveBeenCalled();
  });
});
