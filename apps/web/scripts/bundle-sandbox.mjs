import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = join(root, 'sandbox');
mkdirSync(outdir, { recursive: true });

await build({
  stdin: {
    contents: "export * from '@vercel/sandbox';",
    resolveDir: root,
    sourcefile: 'sandbox-entry.mjs',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: join(outdir, 'sandbox.mjs'),
  legalComments: 'none',
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
