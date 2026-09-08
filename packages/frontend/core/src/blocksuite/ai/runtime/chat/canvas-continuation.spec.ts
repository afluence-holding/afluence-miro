import type { CopilotChatHistoryFragment } from '@affine/graphql';
import { describe, expect, it, vi } from 'vitest';

import type { AIRequestService } from '../request';
import { DocAIChatSessionStrategy } from './session-strategy';

describe('same-chat canvas document continuation', () => {
  const session = {
    sessionId: 'chat',
    workspaceId: 'workspace',
    docId: 'source',
    messages: [{ content: 'Build a new canvas' }],
  } as unknown as CopilotChatHistoryFragment;
  const scope = {
    kind: 'doc' as const,
    workspaceId: 'workspace',
    docId: 'created-doc',
    continuationSessionId: 'chat',
  };
  it('retains the explicitly continued session and history with the target editor scope', async () => {
    const request = {
      getSession: vi.fn().mockResolvedValue(session),
      getSessions: vi.fn(),
    } as unknown as AIRequestService;
    const strategy = new DocAIChatSessionStrategy();
    expect(await strategy.loadInitialSession(scope, request)).toBe(session);
    expect(strategy.openSession(session, scope)).toEqual({
      type: 'opened',
      session,
    });
    expect(request.getSessions).not.toHaveBeenCalled();
    expect(scope.docId).toBe('created-doc');
  });
  it('does not carry a session from another workspace or relax ordinary navigation', async () => {
    const strategy = new DocAIChatSessionStrategy();
    const request = {
      getSession: vi
        .fn()
        .mockResolvedValue({ ...session, workspaceId: 'other' }),
    } as unknown as AIRequestService;
    expect(await strategy.loadInitialSession(scope, request)).toBeNull();
    expect(
      strategy.canOpenAsTab({ ...session, workspaceId: 'other' }, scope)
    ).toBe(false);
    expect(
      strategy.openSession(session, {
        ...scope,
        continuationSessionId: undefined,
      }).type
    ).toBe('navigate');
  });
});
