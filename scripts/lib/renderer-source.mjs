// The renderer's source as one string.
//
// Several suites assert that a piece of UI exists, is wired to a particular IPC
// call, or never renders something. Those are claims about the renderer, not
// about which file happens to hold it -- and src/App.tsx is being split into
// src/pages/*. Reading the whole tree keeps every one of those assertions
// meaningful while letting code move between files.
//
// Note the direction each kind of assertion moves as the tree grows: a positive
// match ("this exists") stays exactly as strong, and a doesNotMatch ("this is
// never rendered") gets STRONGER, because it now covers the whole renderer
// rather than one file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/** Every renderer source file, sorted, so the result is stable across machines. */
export const rendererFiles = (dir = SRC) => fs.readdirSync(dir, { withFileTypes: true })
  .sort((a, b) => (a.name < b.name ? -1 : 1))
  .flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return rendererFiles(full);
    return SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [full] : [];
  });

/** All renderer source concatenated, each file preceded by a locating comment. */
export const rendererSource = () => rendererFiles()
  .map((file) => `// ---- ${path.relative(path.join(SRC, '..'), file)} ----\n${fs.readFileSync(file, 'utf8')}`)
  .join('\n');
