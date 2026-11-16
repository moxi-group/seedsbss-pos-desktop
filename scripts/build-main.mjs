// Empacota o processo principal e o preload com esbuild. O preload tem de
// ser um único ficheiro: corre em sandbox e não pode fazer require() de
// ficheiros locais.
import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
  logLevel: 'info',
};

await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.js', external: ['electron', 'electron-updater'] });
await build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.js' });
