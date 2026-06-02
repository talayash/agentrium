import { motion } from 'framer-motion';
import { X, Sparkles } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import changelog from '../changelog.json';

interface ChangelogFeature {
  title: string;
  description?: string;
}

interface ChangelogEntry {
  version: string;
  date: string;
  features: ChangelogFeature[];
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

export function WhatsNewModal() {
  const { closeWhatsNew, lastSeenVersion, setLastSeenVersion } = useAppStore();

  const entries = (changelog as ChangelogEntry[]).filter((entry) => {
    if (!lastSeenVersion) return true;
    return compareVersions(entry.version, lastSeenVersion) > 0;
  }).sort((a, b) => compareVersions(b.version, a.version));

  const handleClose = () => {
    const latest = (changelog as ChangelogEntry[])[0]?.version;
    if (latest) {
      setLastSeenVersion(latest);
    }
    closeWhatsNew();
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50"
      onDoubleClick={handleClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.15 }}
        onDoubleClick={(e) => e.stopPropagation()}
        className="bg-bg-elevated ring-1 ring-white/[0.08] rounded-lg shadow-2xl w-full max-w-lg overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-accent-primary" />
            <h2 className="text-text-primary text-[14px] font-semibold">What's New</h2>
          </div>
          <button
            onClick={handleClose}
            className="p-1 rounded hover:bg-white/[0.06] text-text-tertiary transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto max-h-[70vh] p-4 space-y-4">
          {entries.map((entry) => (
            <div key={entry.version} className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="bg-accent-primary/20 text-accent-primary text-[11px] font-semibold px-2 py-0.5 rounded-full">
                  v{entry.version}
                </span>
                <span className="text-text-tertiary text-[11px]">{entry.date}</span>
              </div>
              <ul className="space-y-1.5 pl-1">
                {entry.features.map((feature, i) => (
                  <li key={i} className="flex items-start gap-2 text-[12px]">
                    <span className="text-accent-primary mt-1 flex-shrink-0">&#8226;</span>
                    <div>
                      <span className="text-text-primary font-medium">{feature.title}</span>
                      {feature.description && (
                        <span className="text-text-secondary"> - {feature.description}</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex justify-end p-4 border-t border-border">
          <button
            onClick={handleClose}
            className="bg-accent-primary hover:bg-accent-secondary text-white h-8 px-4 rounded-md text-[12px] font-medium transition-colors"
          >
            Got it
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
