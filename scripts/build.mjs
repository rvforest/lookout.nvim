import { build } from 'esbuild';
await build({ entryPoints: ['helper/main.ts'], bundle: true, platform: 'node', target: 'node24', format: 'esm', outfile: 'dist/helper.mjs', sourcemap: false });
await build({ entryPoints: ['helper/review.ts'], bundle: true, platform: 'node', target: 'node24', format: 'esm', outfile: 'dist/review.mjs' });
await build({ entryPoints: ['helper/controller.ts'], bundle: true, platform: 'node', target: 'node24', format: 'esm', outfile: 'dist/controller.mjs' });
