import { describe, expect, it, vi } from 'vitest';

import { canvasArtifactClient } from './canvas-artifacts';

describe('authenticated canvas artifacts', () => {
  it('resolves handles only through the server and never fetches model URLs', async () => {
    const fetch = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response('native-bytes', {
          headers: { 'content-type': 'application/zip' },
        })
    );
    const client = canvasArtifactClient(
      fetch,
      'https://canvas.example',
      'workspace',
      'session'
    );
    await expect(
      client.resolveArtifact({ handle: 'https://untrusted.example/file.zip' })
    ).rejects.toThrow('INVALID_PLAN');
    expect(fetch).not.toHaveBeenCalled();
    const blob = await client.resolveArtifact({ handle: 'cah_ZGF0YQ,c2ln/==' });
    expect(await blob.text()).toBe('native-bytes');
    expect(fetch.mock.calls[0]?.[0]).toContain(
      '/api/copilot/canvas-artifact?handle=cah_'
    );
  });
  it('binds exports to the authorized workspace, preserves file names and constructs its own URL', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({
        handle: 'cah_ZGF0YQ,c2ln/==',
        mimeType: 'application/zip',
        fileName: 'canvas.bs.zip',
        url: 'javascript:alert(1)',
      })
    );
    const client = canvasArtifactClient(
      fetch,
      'https://canvas.example',
      'workspace',
      'session'
    );
    const input = {
      workspaceId: 'workspace',
      docId: 'doc',
      blob: new Blob(['data']),
      fileName: 'canvas.bs.zip',
      mimeType: 'application/zip',
    };
    await expect(
      client.createArtifact({ ...input, workspaceId: 'other' })
    ).rejects.toThrow('INVALID_PLAN');
    expect(fetch).not.toHaveBeenCalled();
    const artifact = await client.createArtifact(input);
    expect(artifact.fileName).toBe('canvas.bs.zip');
    expect(artifact.url).toMatch(
      /^https:\/\/canvas\.example\/api\/copilot\/canvas-artifact\?/
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
      body: input.blob,
    });
  });
  it('rejects an oversized response before consuming its body', async () => {
    const fetch = vi.fn(
      async () =>
        new Response('data', {
          headers: { 'content-length': String(64 * 1024 * 1024 + 1) },
        })
    );
    await expect(
      canvasArtifactClient(
        fetch,
        'https://canvas.example',
        'workspace',
        'session'
      ).resolveArtifact({ handle: 'cah_data,sig' })
    ).rejects.toThrow('BUDGET_EXCEEDED');
  });
});
