import { useAppStore } from '../../../store/appStore';
import { PageHeader, PageSection, SettingRow } from '../SettingRow';
import { registerSetting } from '../index';

const cat = { group: 'editor', page: 'font' } as const;
['font-family', 'font-size', 'line-height'].forEach((id) =>
  registerSetting({ category: cat, id, label: id.replace(/-/g, ' '), keywords: ['monaco', 'editor', 'font'] })
);

export default function EditorFontPage() {
  const editorFontFamily = useAppStore((s) => s.editorFontFamily);
  const editorFontSize = useAppStore((s) => s.editorFontSize);
  const editorLineHeight = useAppStore((s) => s.editorLineHeight);
  const { setEditorFontFamily, setEditorFontSize, setEditorLineHeight } = useAppStore.getState();

  return (
    <div>
      <PageHeader title="Editor - Font" />
      <PageSection title="Font">
        <SettingRow label="Family">
          <input
            type="text" value={editorFontFamily}
            onChange={(e) => setEditorFontFamily(e.target.value)}
            className="w-72 bg-elevation-0 text-text-primary text-[12px] px-2 py-1 rounded ring-1 ring-border-light font-mono"
          />
        </SettingRow>
        <SettingRow label="Size">
          <input
            type="number" min={8} max={32} value={editorFontSize}
            onChange={(e) => setEditorFontSize(parseInt(e.target.value, 10) || 13)}
            className="w-20 bg-elevation-0 text-text-primary text-right text-[12px] px-2 py-1 rounded ring-1 ring-border-light"
          />
        </SettingRow>
        <SettingRow label="Line height">
          <input
            type="number" min={1} max={2} step={0.1} value={editorLineHeight}
            onChange={(e) => setEditorLineHeight(parseFloat(e.target.value) || 1.5)}
            className="w-20 bg-elevation-0 text-text-primary text-right text-[12px] px-2 py-1 rounded ring-1 ring-border-light"
          />
        </SettingRow>
      </PageSection>
    </div>
  );
}
