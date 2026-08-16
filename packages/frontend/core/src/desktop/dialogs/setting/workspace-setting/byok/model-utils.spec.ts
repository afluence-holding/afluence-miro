import {
  ByokAttachmentKind,
  ByokAttachmentSource,
  ByokModelFeature,
  ByokModelInput,
  ByokModelOutput,
  ByokProvider,
} from '@affine/graphql';
import { describe, expect, test } from 'vitest';

import {
  capabilitiesForUseCases,
  defaultModels,
  type ModelDeclaration,
  modelUseCases,
} from './model-utils';
import type { ByokSettings } from './types';

describe('BYOK model capabilities', () => {
  test('defaults OpenAI profiles to the current Afluence model set', () => {
    const settings = {
      catalog: {
        providers: [
          {
            provider: ByokProvider.openai,
            models: [
              'gpt-4.1',
              'gpt-5.6-terra',
              'text-embedding-3-small',
              'gpt-image-2',
              'gpt-5.6-luna',
              'gpt-5.6-sol',
            ].map(modelId => ({
              modelId,
              displayName: modelId,
              recommended: modelId === 'gpt-4.1',
              capabilities: [],
            })),
          },
        ],
      },
    } as ByokSettings;

    expect(
      defaultModels(settings, ByokProvider.openai).map(model => model.modelId)
    ).toEqual([
      'gpt-5.6-luna',
      'gpt-image-2',
      'text-embedding-3-small',
    ]);
  });

  test('maps richer catalog capabilities by minimum requirements', () => {
    const model: ModelDeclaration = {
      modelId: 'multimodal-tools',
      enabled: true,
      capabilities: [
        {
          input: [ByokModelInput.text, ByokModelInput.image],
          output: [ByokModelOutput.text],
          features: [ByokModelFeature.tool_calling],
          attachmentKinds: [ByokAttachmentKind.image],
          attachmentSources: [
            ByokAttachmentSource.url,
            ByokAttachmentSource.data,
            ByokAttachmentSource.bytes,
            ByokAttachmentSource.file_handle,
          ],
        },
      ],
    };

    expect(modelUseCases(model)).toEqual(['chat', 'actions', 'vision']);
  });

  test('preserves a rich capability when its represented uses stay selected', () => {
    const capability = {
      input: [ByokModelInput.text, ByokModelInput.image],
      output: [ByokModelOutput.text],
      features: [ByokModelFeature.tool_calling],
      attachmentKinds: [ByokAttachmentKind.image],
      attachmentSources: [
        ByokAttachmentSource.url,
        ByokAttachmentSource.data,
        ByokAttachmentSource.bytes,
        ByokAttachmentSource.file_handle,
      ],
    };
    const model: ModelDeclaration = {
      modelId: 'multimodal-tools',
      enabled: true,
      capabilities: [capability],
    };

    expect(
      capabilitiesForUseCases(model, ['chat', 'actions', 'vision'])
    ).toEqual([capability]);
  });
});
