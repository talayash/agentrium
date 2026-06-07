import { useAppStore } from '../../../store/appStore';
import { PageHeader, PageSection, SettingRow, Segmented } from '../SettingRow';
import { registerSetting } from '../index';

const cat = { group: 'vcs', page: 'git' } as const;
['commit-template', 'auto-stage', 'merge-strategy'].forEach((id) =>
  registerSetting({ category: cat, id, label: id.replace(/-/g, ' '), keywords: ['git', 'commit', 'merge'] })
);

export default function GitPage() {
  const vcsCommitMessageTemplate = useAppStore((s) => s.vcsCommitMessageTemplate);
  const vcsDefaultAutoStage = useAppStore((s) => s.vcsDefaultAutoStage);
  const vcsDefaultMergeStrategy = useAppStore((s) => s.vcsDefaultMergeStrategy);
  const { setVcsCommitMessageTemplate, setVcsDefaultAutoStage, setVcsDefaultMergeStrategy } = useAppStore.getState();

  return (
    <div>
      <PageHeader title="Version Control - Git" />

      <PageSection title="Commits">
        <SettingRow
          label="Commit message template"
          description="Pre-fills the commit textarea. Supports {branch} and {date} placeholders."
          align="start"
        >
          <textarea
            rows={3}
            value={vcsCommitMessageTemplate}
            onChange={(e) => setVcsCommitMessageTemplate(e.target.value)}
            placeholder="e.g. [{branch}] "
            className="w-72 bg-elevation-0 text-text-primary text-[12px] px-2 py-1 rounded ring-1 ring-border-light font-mono resize-y"
          />
        </SettingRow>
        <SettingRow label="Default auto-stage">
          <Segmented
            value={vcsDefaultAutoStage}
            onChange={setVcsDefaultAutoStage}
            options={[
              { value: 'none',    label: 'None' },
              { value: 'tracked', label: 'Tracked' },
              { value: 'all',     label: 'All' },
            ]}
          />
        </SettingRow>
      </PageSection>

      <PageSection title="Pull / Merge">
        <SettingRow label="Default merge strategy">
          <Segmented
            value={vcsDefaultMergeStrategy}
            onChange={setVcsDefaultMergeStrategy}
            options={[
              { value: 'merge',   label: 'Merge' },
              { value: 'rebase',  label: 'Rebase' },
              { value: 'ff-only', label: 'FF only' },
            ]}
          />
        </SettingRow>
      </PageSection>
    </div>
  );
}
