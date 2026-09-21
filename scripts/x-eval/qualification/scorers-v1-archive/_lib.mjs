// Shared helpers for hidden scorers (eval-only). A scorer runs OUTSIDE the
// snapshot, is never part of an x-task-v1, and prints one JSON line:
//   {"checks":[{"name","ok","kind":"api"|"behavior","detail"}]}
// `kind: "api"` marks a failure caused by a missing export/function/module
// rather than by wrong behavior, so the qualification can tell shallow
// discrimination (API absent) from behavioral discrimination.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const API = /does not provide an export named|is not a function|Cannot find module|ERR_MODULE_NOT_FOUND|is not defined|is not exported|not a constructor/;

export const parseRoot = () => {
  const i = process.argv.indexOf('--root');
  if (i < 0 || !process.argv[i + 1]) throw new Error('--root <snapshot> is required');
  return path.resolve(process.argv[i + 1]);
};

export const load = (root, rel) => import(pathToFileURL(path.join(root, rel)).href);

export const createScorer = () => {
  const checks = [];
  return {
    async check(name, fn) {
      try { await fn(); checks.push({ name, ok: true }); }
      catch (error) {
        const message = String(error?.message ?? error);
        checks.push({ name, ok: false, kind: API.test(message) ? 'api' : 'behavior', detail: message.slice(0, 300) });
      }
    },
    finish() {
      process.stdout.write(`${JSON.stringify({ checks })}\n`);
      process.exit(checks.every((c) => c.ok) ? 0 : 1);
    },
  };
};
