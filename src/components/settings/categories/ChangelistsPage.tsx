import { useAppStore } from '../../../store/appStore';
import { PageHeader, PageSection, SettingRow, Toggle } from '../SettingRow';
import { registerSetting } from '../index';

registerSetting({
  category: { group: 'vcs', page: 'changelists' },
  id: 'confirm-delete',
  label: 'Confirm changelist delete',
  keywords: ['changelist', 'confirm', 'delete'],
});

export default function ChangelistsPage() {
  const vcsChangelistsConfirmDelete = useAppStore((s) => s.vcsChangelistsConfirmDelete);
  const { setVcsChangelistsConfirmDelete } = useAppStore.getState();

  return (
    <div>
      <PageHeader
        title="Version Control — Changelists"
        description="IntelliJ-style local file grouping. New in v1.22.0."
      />

      <PageSection title="Safety">
        <SettingRow
          label="Confirm before deleting a changelist"
          description="Files in the deleted list revert to Default."
        >
          <Toggle value={vcsChangelistsConfirmDelete} onChange={setVcsChangelistsConfirmDelete} />
        </SettingRow>
      </PageSection>
    </div>
  );
}
