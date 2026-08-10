import type { useI18n } from '@affine/i18n';
import { track } from '@affine/track';
import { ContactWithUsIcon } from '@blocksuite/icons/rc';

import type { WorkspaceDialogService } from '../modules/dialogs';
import { registerAffineCommand } from './registry';

export function registerAffineHelpCommands({
  t,
  workspaceDialogService,
}: {
  t: ReturnType<typeof useI18n>;
  workspaceDialogService: WorkspaceDialogService;
}) {
  const unsubs: Array<() => void> = [];
  unsubs.push(
    registerAffineCommand({
      id: 'affine:help-contact-us',
      category: 'affine:help',
      icon: <ContactWithUsIcon />,
      label: t['com.affine.cmdk.affine.contact-us'](),
      run() {
        track.$.cmdk.help.contactUs();
        workspaceDialogService.open('setting', {
          activeTab: 'about',
        });
      },
    })
  );

  return () => {
    unsubs.forEach(unsub => unsub());
  };
}
