import { CATEGORY_GROUPS, type CategoryId } from './index';

interface Props {
  active: CategoryId;
  onSelect: (cat: CategoryId) => void;
  highlightedPages?: Set<string>;
}

export function SettingsCategoryTree({ active, onSelect, highlightedPages }: Props) {
  return (
    <div className="bg-elevation-1 border-r border-[var(--ij-divider-soft)] overflow-y-auto py-2 text-[12px]">
      {CATEGORY_GROUPS.map((group) => {
        const groupHasMatch =
          !highlightedPages || group.pages.some((p) => highlightedPages.has(`${group.id}.${p.id}`));
        return (
          <div key={group.id} className={groupHasMatch ? '' : 'opacity-40'}>
            <div className="px-3 pt-2 pb-1 text-text-tertiary uppercase tracking-[0.06em] text-[9.5px] font-semibold">
              {group.label}
            </div>
            {group.pages.map((page) => {
              const isActive = active.group === group.id && active.page === page.id;
              const isHighlighted = highlightedPages?.has(`${group.id}.${page.id}`);
              return (
                <button
                  key={page.id}
                  onClick={() => onSelect({ group: group.id, page: page.id })}
                  className={`relative w-full text-left px-6 py-1 transition-colors ${
                    isActive
                      ? 'bg-accent-primary/15 text-text-primary'
                      : 'text-text-secondary hover:bg-white/[0.04] hover:text-text-primary'
                  } ${isHighlighted ? 'ring-1 ring-inset ring-yellow-400/40' : ''}`}
                >
                  {isActive && (
                    <span className="absolute left-0 top-1 bottom-1 w-[2px] bg-[var(--ij-stripe)] rounded-r" />
                  )}
                  {page.label}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
