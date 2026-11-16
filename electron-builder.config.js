/**
 * Configuração do instalador Windows (NSIS) e do feed de actualizações.
 *
 *   SEEDS_UPDATE_URL  URL pública onde ficam latest.yml + o .exe
 *                     (ex.: https://downloads.seeds.ao/pos-desktop/)
 *   CSC_LINK / CSC_KEY_PASSWORD  certificado de assinatura de código
 *                     (.pfx em base64) — sem ele o Windows mostra o aviso
 *                     do SmartScreen.
 *
 * @type {import('electron-builder').Configuration}
 */
module.exports = {
  appId: 'ao.seeds.pos',
  productName: 'SeedsBSS POS',
  copyright: 'Moxi Group',
  directories: { output: 'release', buildResources: 'build' },
  files: ['dist/**/*', 'renderer/**/*', 'build/icon.png', 'package.json', '!dist/**/*.map'],
  asar: true,
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.png',
    artifactName: 'SeedsBSS-POS-Setup-${version}.${ext}',
    // Assinatura: electron-builder usa CSC_LINK/CSC_KEY_PASSWORD se existirem.
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: 'always',
    createStartMenuShortcut: true,
    shortcutName: 'SeedsBSS POS',
    deleteAppDataOnUninstall: false,
  },
  publish: [
    {
      provider: 'generic',
      url: process.env.SEEDS_UPDATE_URL || 'https://downloads.seeds.ao/pos-desktop/',
      channel: 'latest',
    },
  ],
};
