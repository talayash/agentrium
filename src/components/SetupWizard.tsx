import { useState, useEffect, useRef } from 'react';
import { AnimatePresence } from 'framer-motion';
import { CheckCircle, XCircle, Download, ExternalLink, Loader2, Terminal, Box, RefreshCw } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { reportInvokeFailure } from '../lib/errorReporter';
import appIcon from '../assets/app-icon.png';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { LatestRequest } from '../lib/latestRequest';

interface SystemStatus {
  node_installed: boolean;
  node_version: string | null;
  npm_installed: boolean;
  npm_version: string | null;
  claude_installed: boolean;
  claude_version: string | null;
}

interface SetupWizardProps {
  onComplete: () => void;
}

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [isChecking, setIsChecking] = useState(true);
  const [isInstalling, setIsInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const requirementsRequestRef = useRef(new LatestRequest());
  const completionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkRequirements = async () => {
    const requestId = requirementsRequestRef.current.begin();
    setIsChecking(true);
    try {
      const result = await invoke<SystemStatus>('check_system_requirements');
      if (!mountedRef.current || !requirementsRequestRef.current.isCurrent(requestId)) return;
      setStatus(result);

      if (result.claude_installed) {
        if (completionTimerRef.current) clearTimeout(completionTimerRef.current);
        completionTimerRef.current = setTimeout(() => {
          if (mountedRef.current) onComplete();
        }, 1500);
      }
    } catch (error) {
      reportInvokeFailure('check_system_requirements', error);
    }
    if (mountedRef.current && requirementsRequestRef.current.isCurrent(requestId)) {
      setIsChecking(false);
    }
  };

  useEffect(() => {
    // React StrictMode intentionally runs effect setup -> cleanup -> setup in
    // development. Re-arm the mounted guard for that second setup.
    mountedRef.current = true;
    checkRequirements();
    return () => {
      mountedRef.current = false;
      requirementsRequestRef.current.invalidate();
      if (completionTimerRef.current) clearTimeout(completionTimerRef.current);
    };
  }, []);

  const handleInstallClaude = async () => {
    setIsInstalling(true);
    setInstallError(null);
    try {
      await invoke('install_claude_code');
      await checkRequirements();
    } catch (error) {
      setInstallError(String(error));
    }
    setIsInstalling(false);
  };

  const openUrl = async (url: string) => {
    await invoke('open_external_url', { url });
  };

  const steps = [
    {
      title: 'Node.js',
      description: 'JavaScript runtime required for Claude Code',
      installed: status?.node_installed,
      version: status?.node_version,
      downloadUrl: 'https://nodejs.org/',
      icon: Box,
    },
    {
      title: 'npm',
      description: 'Package manager (comes with Node.js)',
      installed: status?.npm_installed,
      version: status?.npm_version,
      downloadUrl: 'https://nodejs.org/',
      icon: Box,
    },
    {
      title: 'Claude Code',
      description: 'Anthropic\'s CLI tool for AI-powered coding',
      installed: status?.claude_installed,
      version: status?.claude_version,
      downloadUrl: 'https://docs.anthropic.com/en/docs/claude-code',
      icon: Terminal,
      canAutoInstall: status?.npm_installed,
    },
  ];

  const allInstalled = status?.node_installed && status?.npm_installed && status?.claude_installed;

  return (
    <Modal
      onClose={onComplete}
      closeOn="none"
      closeOnEscape={false}
      scrimClassName="bg-bg-primary z-50"
      panelClassName="w-full max-w-2xl"
    >
      <>
        {/* Header */}
        <div className="p-6 border-b border-[var(--seam)] text-center">
          <img src={appIcon} alt="" className="w-16 h-16 mx-auto mb-4 select-none drop-shadow-[0_8px_28px_var(--accent-glow-md)]" draggable={false} />
          <h1 className="text-[24px] font-bold text-text-primary mb-1 tracking-display">Welcome to Agentrium</h1>
          <p className="text-text-secondary text-[13px]">Let's make sure everything is set up correctly</p>
        </div>

        {/* Content */}
        <div className="p-6">
          {isChecking ? (
            <div className="flex flex-col items-center py-8">
              <Loader2 size={32} className="text-text-secondary animate-spin mb-4" />
              <p className="text-text-tertiary text-[13px]">Checking system requirements...</p>
            </div>
          ) : (
            <div className="space-y-3">
              {steps.map((step) => {
                const Icon = step.icon;
                return (
                  <div
                    key={step.title}
                    className={`p-4 rounded-xl ring-1 transition-all ${
                      step.installed
                        ? 'bg-success/5 ring-success/25'
                        : 'bg-elevation-2 ring-seam'
                    }`}
                  >
                    <div className="flex items-center gap-4">
                      <div className={`w-10 h-10 rounded-[10px] flex items-center justify-center ${
                        step.installed ? 'bg-success/12' : 'bg-elevation-3'
                      }`}>
                        <Icon size={20} className={step.installed ? 'text-success' : 'text-text-tertiary'} />
                      </div>

                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <h3 className="text-text-primary text-[13px] font-medium">{step.title}</h3>
                          {step.installed ? (
                            <CheckCircle size={14} className="text-success" />
                          ) : (
                            <XCircle size={14} className="text-error" />
                          )}
                        </div>
                        <p className="text-text-tertiary text-[12px]">{step.description}</p>
                        {step.version && (
                          <p className="text-text-secondary text-[11px] mt-0.5">Version: {step.version}</p>
                        )}
                      </div>

                      {!step.installed && (
                        <div className="flex gap-2">
                          {step.canAutoInstall && (
                            <Button
                              variant="primary"
                              onClick={handleInstallClaude}
                              loading={isInstalling}
                              icon={<Download size={14} />}
                            >
                              {isInstalling ? 'Installing...' : 'Install'}
                            </Button>
                          )}
                          <Button
                            variant="secondary"
                            onClick={() => openUrl(step.downloadUrl)}
                            icon={<ExternalLink size={14} />}
                          >
                            Download
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {installError && (
                <div className="p-3 rounded-md bg-error/5 ring-1 ring-error/20">
                  <p className="text-error text-[12px]">
                    <strong>Installation Error:</strong> {installError}
                  </p>
                  <p className="text-text-tertiary text-[11px] mt-1.5">
                    Try running manually: <code className="bg-bg-primary px-1.5 py-0.5 rounded text-[11px]">npm install -g @anthropic-ai/claude-code</code>
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-border flex justify-between items-center">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => checkRequirements()}
            disabled={isChecking}
            icon={<RefreshCw size={14} className={isChecking ? 'animate-spin' : ''} />}
          >
            Recheck
          </Button>

          <AnimatePresence mode="wait">
            {allInstalled ? (
              <Button
                variant="success"
                onClick={onComplete}
                icon={<CheckCircle size={16} />}
              >
                Get Started
              </Button>
            ) : (
              <span className="text-text-tertiary text-[12px]">
                Install missing requirements to continue
              </span>
            )}
          </AnimatePresence>
        </div>
      </>
    </Modal>
  );
}
