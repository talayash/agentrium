# Restore sessions from History

With no terminal tabs open, History shows up to five recent sessions for each saved profile, followed by other folders previously used in Agentrium. Folder groups combine Claude, Codex, and Cursor sessions, newest first, and label each session with its agent. Equivalent Windows paths are grouped together.

Click a session to open a terminal and resume it. Profile sessions use the profile's arguments, environment, credential bindings, and preview settings. Other folder sessions use that agent's default arguments and CLI authentication. A missing or inaccessible folder produces an error without opening a terminal.

Profiles sharing an agent and working directory share the same session history. The other-folder list excludes agent/folder combinations already represented by profiles. Profiles and folders with no resumable sessions are omitted, including profiles whose agents have no local session index. Failed lookups remain visible with an error so they are not mistaken for empty history.

Folder discovery uses Agentrium's persisted terminal history, including closed terminals and records older than the log viewer's 100-entry limit. It does not discover folders used exclusively outside Agentrium or old records without a working directory. Clearing those history records also removes their folders from discovery unless a profile or another history record still references them.

Once a terminal opens, History returns to the existing active-terminal/pinned-folder view. Closing all terminal tabs returns to the grouped view. Refresh reloads saved profiles and session indexes.
