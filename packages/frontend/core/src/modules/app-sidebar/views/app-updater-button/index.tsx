import { Tooltip } from '@affine/component';
import { UrlService } from '@affine/core/modules/url';
import { Unreachable } from '@affine/env/constant';
import { useI18n } from '@affine/i18n';
import { DownloadIcon, ResetIcon } from '@blocksuite/icons/rc';
import { useService } from '@toeverything/infra';
import clsx from 'clsx';
import { useCallback, useMemo } from 'react';

import * as styles from './index.css';

export interface AddPageButtonProps {
  onQuitAndInstall: () => void;
  onDownloadUpdate: () => void;
  updateReady: boolean;
  updateAvailable: {
    version: string;
    allowAutoUpdate: boolean;
  } | null;
  autoDownload: boolean;
  downloadProgress: number | null;
  appQuitting: boolean;
  className?: string;
  style?: React.CSSProperties;
}

interface ButtonContentProps {
  updateReady: boolean;
  updateAvailable: {
    version: string;
    allowAutoUpdate: boolean;
  } | null;
  autoDownload: boolean;
  downloadProgress: number | null;
  appQuitting: boolean;
}

function DownloadUpdate({ updateAvailable }: ButtonContentProps) {
  const t = useI18n();
  return (
    <div className={styles.updateAvailableWrapper}>
      <div className={styles.installLabelNormal}>
        <DownloadIcon className={styles.icon} />
        <span className={styles.ellipsisTextOverflow}>
          {t['com.affine.appUpdater.downloadUpdate']()}
        </span>
        <span className={styles.versionLabel}>{updateAvailable?.version}</span>
      </div>

      <div className={styles.installLabelHover}>
        <DownloadIcon className={styles.icon} />
        <span className={styles.ellipsisTextOverflow}>
          {t['com.affine.appUpdater.downloadUpdate']()}
        </span>
      </div>
    </div>
  );
}

function UpdateReady({ updateAvailable, appQuitting }: ButtonContentProps) {
  const t = useI18n();
  return (
    <div className={styles.updateAvailableWrapper}>
      <div className={styles.installLabelNormal}>
        <ResetIcon className={styles.icon} />
        <span className={styles.ellipsisTextOverflow}>
          {t['com.affine.appUpdater.updateAvailable']()}
        </span>
        <span className={styles.versionLabel}>{updateAvailable?.version}</span>
      </div>

      <div className={styles.installLabelHover}>
        <ResetIcon className={styles.icon} />
        <span className={styles.ellipsisTextOverflow}>
          {t[appQuitting ? 'Loading' : 'com.affine.appUpdater.installUpdate']()}
        </span>
      </div>
    </div>
  );
}

function DownloadingUpdate({
  updateAvailable,
  downloadProgress,
}: ButtonContentProps) {
  const t = useI18n();
  return (
    <div className={clsx([styles.updateAvailableWrapper])}>
      <div className={clsx([styles.installLabelNormal])}>
        <span className={styles.ellipsisTextOverflow}>
          {t['com.affine.appUpdater.downloading']()}
        </span>
        <span className={styles.versionLabel}>{updateAvailable?.version}</span>
      </div>

      <div className={styles.progress}>
        <div
          className={styles.progressInner}
          style={{ width: `${downloadProgress}%` }}
        />
      </div>
    </div>
  );
}

function OpenDownloadPage({ updateAvailable }: ButtonContentProps) {
  const t = useI18n();
  return (
    <>
      <div className={styles.installLabelNormal}>
        <DownloadIcon className={styles.icon} />
        <span className={styles.ellipsisTextOverflow}>
          {t['com.affine.appUpdater.updateAvailable']()}
        </span>
        <span className={styles.versionLabel}>{updateAvailable?.version}</span>
      </div>

      <div className={styles.installLabelHover}>
        <DownloadIcon className={styles.icon} />
        <span className={styles.ellipsisTextOverflow}>
          {t['com.affine.appUpdater.openDownloadPage']()}
        </span>
      </div>
    </>
  );
}

const getButtonContentRenderer = (props: ButtonContentProps) => {
  if (props.updateReady) {
    return UpdateReady;
  } else if (props.updateAvailable?.allowAutoUpdate) {
    if (props.autoDownload && props.updateAvailable.allowAutoUpdate) {
      return DownloadingUpdate;
    } else {
      return DownloadUpdate;
    }
  } else if (props.updateAvailable && !props.updateAvailable?.allowAutoUpdate) {
    return OpenDownloadPage;
  }
  return null;
};

export function AppUpdaterButton({
  updateReady,
  onDownloadUpdate,
  onQuitAndInstall,
  updateAvailable,
  autoDownload,
  downloadProgress,
  appQuitting,
  className,
  style,
}: AddPageButtonProps) {
  const urlService = useService(UrlService);
  const handleClick = useCallback(() => {
    if (updateReady) {
      onQuitAndInstall();
    } else if (updateAvailable) {
      if (updateAvailable.allowAutoUpdate) {
        if (autoDownload) {
          // wait for download to finish
        } else {
          onDownloadUpdate();
        }
      } else {
        urlService.openPopupWindow('https://byafluence.com');
      }
    } else {
      throw new Unreachable();
    }
  }, [
    updateReady,
    updateAvailable,
    onQuitAndInstall,
    autoDownload,
    onDownloadUpdate,
    urlService,
  ]);

  const contentProps = useMemo(
    () => ({
      updateReady,
      updateAvailable,
      autoDownload,
      downloadProgress,
      appQuitting,
    }),
    [
      updateReady,
      updateAvailable,
      autoDownload,
      downloadProgress,
      appQuitting,
    ]
  );

  const ContentComponent = getButtonContentRenderer(contentProps);

  const wrapWithTooltip = (
    node: React.ReactElement,
    tooltip?: React.ReactElement | string
  ) => {
    if (!tooltip) {
      return node;
    }

    return (
      <Tooltip content={tooltip} side="top">
        {node}
      </Tooltip>
    );
  };

  const disabled = useMemo(() => {
    if (appQuitting) {
      return true;
    }

    if (updateAvailable?.allowAutoUpdate) {
      return !updateReady && autoDownload;
    }

    return false;
  }, [
    appQuitting,
    autoDownload,
    updateAvailable?.allowAutoUpdate,
    updateReady,
  ]);

  if (!updateAvailable) {
    return null;
  }

  return wrapWithTooltip(
    <button
      style={style}
      className={clsx([styles.root, className])}
      data-has-update={!!updateAvailable}
      data-updating={appQuitting}
      data-disabled={disabled}
      onClick={handleClick}
    >
      {ContentComponent ? <ContentComponent {...contentProps} /> : null}
      <div className={styles.particles} aria-hidden="true"></div>
      <span className={styles.halo} aria-hidden="true"></span>
    </button>,
    updateAvailable?.version
  );
}
