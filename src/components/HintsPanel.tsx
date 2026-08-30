import { useState, useEffect } from 'react';
import { Search, Copy, Check, ChevronDown, ChevronRight, Rocket, Folder, GitBranch, Code, Bug, Terminal, Star } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from '../store/toastStore';
import { copyText } from '../lib/clipboard';
import { reportInvokeFailure } from '../lib/errorReporter';

interface Hint {
  title: string;
  command: string;
  description: string;
}

interface HintCategory {
  name: string;
  icon: string;
  hints: Hint[];
}

const iconMap: Record<string, React.ReactNode> = {
  star: <Star size={14} />,
  rocket: <Rocket size={14} />,
  folder: <Folder size={14} />,
  'git-branch': <GitBranch size={14} />,
  code: <Code size={14} />,
  bug: <Bug size={14} />,
  terminal: <Terminal size={14} />,
};

export function HintsPanel() {
  const [categories, setCategories] = useState<HintCategory[]>([]);
  const [search, setSearch] = useState('');
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);

  useEffect(() => {
    invoke<HintCategory[]>('get_hints')
      .then(setCategories)
      .catch((err) => reportInvokeFailure('get_hints', err));
  }, []);

  const filteredCategories = categories.map(cat => ({
    ...cat,
    hints: cat.hints.filter(
      h => h.title.toLowerCase().includes(search.toLowerCase()) ||
           h.command.toLowerCase().includes(search.toLowerCase())
    )
  })).filter(cat => cat.hints.length > 0);

  const copyToClipboard = async (command: string) => {
    // copyText survives WebView2's focus gating; bare navigator.clipboard
    // rejects with NotAllowedError whenever the document isn't focused.
    if (await copyText(command)) {
      setCopiedCommand(command);
      toast.success('Copied', command);
    } else {
      toast.error('Copy failed', 'Could not write to the clipboard.');
    }
  };

  // Clear copied state after timeout
  useEffect(() => {
    if (!copiedCommand) return;
    const timer = setTimeout(() => setCopiedCommand(null), 2000);
    return () => clearTimeout(timer);
  }, [copiedCommand]);

  return (
    <div className="h-full bg-bg-secondary border-l border-border flex flex-col">
      {/* Header */}
      <div className="p-3 border-b border-border">
        <h3 className="text-text-primary text-[13px] font-semibold mb-2">Commands</h3>
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <input
            type="text"
            placeholder="Search commands..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-bg-primary ring-1 ring-border-light rounded-md py-1.5 pl-8 pr-3 text-[12px] text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-[3px] focus:ring-accent-primary/45 transition-colors"
          />
        </div>
      </div>

      {/* Categories */}
      <div className="flex-1 overflow-y-auto p-1.5">
        {filteredCategories.map((category) => (
          <div key={category.name} className="mb-1">
            <button
              onClick={() => setExpandedCategory(
                expandedCategory === category.name ? null : category.name
              )}
              className="w-full flex items-center gap-2 p-2 rounded-md hover:bg-fill-hover transition-colors"
            >
              <span className="text-text-secondary">{iconMap[category.icon] || <Terminal size={14} />}</span>
              <span className="flex-1 text-left text-text-primary text-[12px] font-medium">
                {category.name}
              </span>
              {expandedCategory === category.name ? (
                <ChevronDown size={14} className="text-text-tertiary" />
              ) : (
                <ChevronRight size={14} className="text-text-tertiary" />
              )}
            </button>

            {expandedCategory === category.name && (
              <div>
                {category.hints.map((hint) => (
                  <div
                    key={hint.title}
                    className="ml-3 p-2 rounded-md hover:bg-fill-hover group cursor-pointer"
                    onClick={() => copyToClipboard(hint.command)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-text-primary text-[12px] font-medium">{hint.title}</p>
                        <code className="text-accent-primary text-[11px] bg-accent-primary/10 px-1.5 py-0.5 rounded mt-1 inline-block">
                          {hint.command}
                        </code>
                        <p className="text-text-tertiary text-[11px] mt-1">{hint.description}</p>
                      </div>
                      <button className="p-1 rounded hover:bg-fill-hover opacity-0 group-hover:opacity-100 transition-opacity">
                        {copiedCommand === hint.command ? (
                          <Check size={12} className="text-success" />
                        ) : (
                          <Copy size={12} className="text-text-tertiary" />
                        )}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

    </div>
  );
}
