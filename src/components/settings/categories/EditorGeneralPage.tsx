import { useAppStore } from '../../../store/appStore';
import { PageHeader, PageSection, SettingRow, Toggle } from '../SettingRow';
import { registerSetting } from '../index';

const cat = { group: 'editor', page: 'general' } as const;
['tab-size', 'whitespace', 'word-wrap', 'minimap', 'auto-save'].forEach((id) =>
  registerSetting({ category: cat, id, label: id.replace(/-/g, ' '), keywords: ['monaco', 'editor', id] })
);

export default function EditorGeneralPage() {
  const editorTabSize = useAppStore((s) => s.editorTabSize);
  const editorRenderWhitespace = useAppStore((s) => s.editorRenderWhitespace);
  const editorWordWrap = useAppStore((s) => s.editorWordWrap);
  const editorMinimap = useAppStore((s) => s.editorMinimap);
  const editorAutoSaveOnBlur = useAppStore((s) => s.editorAutoSaveOnBlur);
  const {
    setEditorTabSize, setEditorRenderWhitespace, setEditorWordWrap,
    setEditorMinimap, setEditorAutoSaveOnBlur,
  } = useAppStore.getState();

  return (
    <div>
      <PageHeader title="Editor - General" description="Settings for the in-app file editor (Monaco)." />
      <PageSection title="Layout">
        <SettingRow label="Tab size">
          <input
            type="number" min={1} max={8} value={editorTabSize}
            onChange={(e) => setEditorTabSize(parseInt(e.target.value, 10) || 2)}
            className="w-20 bg-elevation-0 text-text-primary text-right text-[12px] px-2 py-1 rounded ring-1 ring-border-light"
          />
        </SettingRow>
        <SettingRow label="Word wrap">
          <Toggle value={editorWordWrap} onChange={setEditorWordWrap} />
        </SettingRow>
        <SettingRow label="Render whitespace">
          <Toggle value={editorRenderWhitespace} onChange={setEditorRenderWhitespace} />
        </SettingRow>
        <SettingRow label="Minimap">
          <Toggle value={editorMinimap} onChange={setEditorMinimap} />
        </SettingRow>
        <SettingRow label="Auto-save on blur" description="Save the file when its tab loses focus.">
          <Toggle value={editorAutoSaveOnBlur} onChange={setEditorAutoSaveOnBlur} />
        </SettingRow>
      </PageSection>
    </div>
  );
}
