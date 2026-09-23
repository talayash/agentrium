import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { isCancellationError, reportError } from './lib/errorReporter';
import { installConfirmShim } from './lib/confirmDialog';

// Known-benign browser warnings that fire constantly during layout work
// (e.g. xterm.js + Framer Motion resizing). Filtering here avoids polluting
// telemetry with non-actionable noise.
const BENIGN_ERROR_PATTERNS = [
  /ResizeObserver loop/i,
];

function isBenign(message: string | undefined): boolean {
  if (!message) return false;
  return BENIGN_ERROR_PATTERNS.some((re) => re.test(message));
}

window.addEventListener('error', (e) => {
  if (isBenign(e.message)) return;
  const err = e.error as Error | undefined;
  reportError(err?.name ?? 'Error', e.message ?? 'Unknown error', err?.stack);
});

window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  if (isCancellationError(r)) return;
  const name = r?.name ?? 'UnhandledRejection';
  const message =
    typeof r === 'string' ? r : r?.message ?? (r === undefined ? 'undefined' : String(r));
  reportError(name, message, r?.stack);
});

// Before anything can render an editor: tauri-plugin-dialog's injected
// window.confirm invokes a command the plugin no longer registers.
installConfirmShim();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
