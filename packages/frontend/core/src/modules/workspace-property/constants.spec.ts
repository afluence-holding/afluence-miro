import { describe, expect, test } from 'vitest';

import {
  BUILT_IN_CUSTOM_PROPERTY_TYPE,
  filterEnabledWorkspaceProperties,
  isEnabledWorkspacePropertyType,
} from './constants';

describe('workspace properties', () => {
  test('does not expose the retired journal property', () => {
    expect(isEnabledWorkspacePropertyType('journal')).toBe(false);
    expect(
      BUILT_IN_CUSTOM_PROPERTY_TYPE.some(
        property => property.type === 'journal'
      )
    ).toBe(false);
  });

  test('filters a persisted journal property out of explorer data', () => {
    expect(
      filterEnabledWorkspaceProperties([
        { id: 'journal', type: 'journal' },
        { id: 'tags', type: 'tags' },
      ])
    ).toEqual([{ id: 'tags', type: 'tags' }]);
  });
});
