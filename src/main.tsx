import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { reportError } from './lib/errorReporter';

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
  const name = r?.name ?? 'UnhandledRejection';
  const message =
    typeof r === 'string' ? r : r?.message ?? (r === undefined ? 'undefined' : String(r));
  reportError(name, message, r?.stack);
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
