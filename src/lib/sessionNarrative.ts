// Session goal / progress text shared by the handoff brief and the PR
// description. Deliberately import-free: appStore depends on the PR module,
// so anything that module pulls in must not import a store back.

export type SessionNarrative = {
  sessionContext?: { goal?: string | null; latest?: string | null } | null;
  sessionSummary?: string | null;
};

/** The session's stated goal, if the context extractor found one. */
export function handoffTaskText(terminal: SessionNarrative): string | null {
  return terminal.sessionContext?.goal || null;
}

/** Latest progress: extracted context first, then the agent's own summary. */
export function handoffLatestText(terminal: SessionNarrative): string | null {
  return terminal.sessionContext?.latest || terminal.sessionSummary || null;
}
