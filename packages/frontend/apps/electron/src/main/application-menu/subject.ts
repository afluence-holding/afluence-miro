import { Subject } from 'rxjs';

export type NewPageAction = 'page' | 'edgeless' | 'default';

export const applicationMenuSubjects = {
  newPageAction$: new Subject<NewPageAction>(),
  openInSettingModal$: new Subject<{
    activeTab: string;
    scrollAnchor?: string;
  }>(),
};
