// Material Icon Theme bridge - resolves filenames and folder names to the SVG
// asset URLs shipped by the `material-icon-theme` npm package.
//
// `generateManifest()` returns the same maps the VS Code extension consumes
// (file extensions, exact filenames, folder names). The actual SVGs live at
// `node_modules/material-icon-theme/icons/<icon-name>.svg`; Vite glob-imports
// them eagerly as URLs so each becomes a hashed asset in the bundle that the
// browser can load on demand via <img src=...>.
import { generateManifest } from 'material-icon-theme';

const manifest = generateManifest();

const iconUrls = import.meta.glob<string>(
  '/node_modules/material-icon-theme/icons/*.svg',
  { eager: true, query: '?url', import: 'default' }
);

const urlByIconName: Record<string, string> = {};
for (const [path, url] of Object.entries(iconUrls)) {
  const file = path.split('/').pop();
  if (!file) continue;
  const name = file.replace(/\.svg$/i, '');
  urlByIconName[name] = url;
}

function urlFor(iconName: string | undefined | null): string | undefined {
  if (!iconName) return undefined;
  return urlByIconName[iconName];
}

const DEFAULT_FILE_URL = urlFor(manifest.file) ?? urlFor('file') ?? '';
const DEFAULT_FOLDER_URL = urlFor(manifest.folder) ?? urlFor('folder') ?? '';
const DEFAULT_FOLDER_OPEN_URL =
  urlFor(manifest.folderExpanded) ?? urlFor('folder-open') ?? DEFAULT_FOLDER_URL;

export function getFileIconUrl(filename: string): string {
  if (!filename) return DEFAULT_FILE_URL;
  const lower = filename.toLowerCase();

  const exact = manifest.fileNames?.[lower];
  const exactUrl = urlFor(exact);
  if (exactUrl) return exactUrl;

  // Multi-segment extension match: foo.test.ts → try "test.ts" then "ts".
  const parts = lower.split('.');
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join('.');
    const name = manifest.fileExtensions?.[ext];
    const u = urlFor(name);
    if (u) return u;
  }

  return DEFAULT_FILE_URL;
}

/**
 * When true, folder icons come from material-icon-theme's per-folder-name
 * palette (green .git, orange .config, red .idea, etc.). When false (default,
 * matches the sketch), all folders render with the same yellow folder icon.
 * Toggled from Settings via {@link setColorfulFolderIcons}.
 */
let useColorfulFolders = false;
export function setColorfulFolderIcons(v: boolean): void {
  useColorfulFolders = v;
}

export function getFolderIconUrl(folderName: string, expanded = false): string {
  const fallback = expanded ? DEFAULT_FOLDER_OPEN_URL : DEFAULT_FOLDER_URL;
  if (!useColorfulFolders || !folderName) return fallback;
  const lower = folderName.toLowerCase();
  const map = expanded ? manifest.folderNamesExpanded : manifest.folderNames;
  const u = urlFor(map?.[lower]);
  return u ?? fallback;
}
