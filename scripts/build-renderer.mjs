// Usa o seedsbss-client como dependência: corre o build "desktop" do
// client e copia o resultado para ./renderer (que vai dentro da app).
//
//   CLIENT_DIR  pasta do repo seedsbss-client (omissão: ../seedsbss-client)
//   SKIP_CLIENT_INSTALL=1  não corre `npm ci` no client
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientDir = path.resolve(root, process.env.CLIENT_DIR ?? '../seedsbss-client');
const outDir = path.join(root, 'renderer');

if (!fs.existsSync(path.join(clientDir, 'angular.json'))) {
  console.error(`seedsbss-client não encontrado em ${clientDir}. Define CLIENT_DIR.`);
  process.exit(1);
}

const run = (cmd) => {
  console.log(`\n> ${cmd}  (em ${clientDir})`);
  execSync(cmd, { cwd: clientDir, stdio: 'inherit', shell: true });
};

if (process.env.SKIP_CLIENT_INSTALL !== '1' && !fs.existsSync(path.join(clientDir, 'node_modules'))) {
  run('npm ci --legacy-peer-deps --no-audit --no-fund');
}
run('npx ng build --configuration desktop');

const built = path.join(clientDir, 'dist', 'seedsbss-pos-desktop', 'browser');
if (!fs.existsSync(path.join(built, 'index.html'))) {
  console.error(`Build do client sem index.html em ${built}`);
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.cpSync(built, outDir, { recursive: true });

// Regista que versão do client foi empacotada (útil no suporte).
let clientRev = 'desconhecida';
try {
  clientRev = execSync('git rev-parse --short HEAD', { cwd: clientDir }).toString().trim();
} catch {}
fs.writeFileSync(path.join(outDir, 'client-version.txt'), `${clientRev}\n`);
console.log(`\nRenderer copiado para ${outDir} (client ${clientRev})`);
