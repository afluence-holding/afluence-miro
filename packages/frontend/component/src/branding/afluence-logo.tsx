import { useTheme } from 'next-themes';
import type { CSSProperties, ImgHTMLAttributes } from 'react';

import horizontalDark from './assets/afluence-horizontal-dark.inline.svg';
import horizontalWhite from './assets/afluence-horizontal-white.inline.svg';
import symbolDark from './assets/afluence-symbol-dark.inline.svg';
import symbolWhite from './assets/afluence-symbol-white.inline.svg';

type AfluenceLogoProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  /** Use the mark where space is limited and the complete lockup elsewhere. */
  variant?: 'symbol' | 'horizontal';
  size?: number | string;
};

/** The shared Afluence Miro mark, switched automatically for the active theme. */
export const AfluenceLogo = ({
  alt = 'Afluence Miro',
  className,
  size,
  style,
  variant = 'symbol',
  ...props
}: AfluenceLogoProps) => {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const src =
    variant === 'horizontal'
      ? isDark
        ? horizontalWhite
        : horizontalDark
      : isDark
        ? symbolWhite
        : symbolDark;

  const dimensions: CSSProperties =
    variant === 'horizontal'
      ? { height: size ?? 24, width: 'auto' }
      : { height: size ?? 24, width: size ?? 24 };

  return (
    <img
      {...props}
      alt={alt}
      className={className}
      draggable={false}
      src={src}
      style={{
        display: 'block',
        objectFit: 'contain',
        ...dimensions,
        ...style,
      }}
    />
  );
};
