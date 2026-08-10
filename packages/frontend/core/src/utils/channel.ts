import { z } from 'zod';

export const appSchemes = z.enum([
  'affine',
  'affine-canary',
  'affine-beta',
  'affine-internal',
  'affine-dev',
]);

export type Scheme = z.infer<typeof appSchemes>;
export type Channel = 'stable' | 'canary' | 'beta' | 'internal';

export const schemeToChannel = {
  affine: 'stable',
  'affine-canary': 'canary',
  'affine-beta': 'beta',
  'affine-internal': 'internal',
  'affine-dev': 'canary', // dev does not have a dedicated app. use canary as the placeholder.
} as Record<Scheme, Channel>;

export const channelToScheme = {
  stable: 'affine',
  canary: BUILD_CONFIG.debug ? 'affine-dev' : 'affine-canary',
  beta: 'affine-beta',
  internal: 'affine-internal',
} as Record<Channel, Scheme>;

export const appIconMap = {
  stable: '/imgs/app-icon-stable.png',
  canary: '/imgs/app-icon-canary.png',
  beta: '/imgs/app-icon-beta.png',
  internal: '/imgs/app-icon-internal.png',
} satisfies Record<Channel, string>;

export const appNames = {
  stable: 'Afluence Miro',
  canary: 'Afluence Miro Canary',
  beta: 'Afluence Miro Beta',
  internal: 'Afluence Miro Internal',
} satisfies Record<Channel, string>;

export const appSchemaUrl = z.custom<string>(
  (url: string) => {
    try {
      return appSchemes.safeParse(new URL(url).protocol.replace(':', ''))
        .success;
    } catch {
      return false;
    }
  },
  { message: 'Invalid URL or protocol' }
);
