import { BrowserWindow, Menu, app, ipcMain, net, protocol, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DesktopAppInfo,
  DesktopDrawerOptions,
  DesktopPrintHtmlOptions,
  IPC,
  OfflineEnqueueInput,
  TERMINAL_CONFIG_KEY,
} from './shared/bridge';
import { openCashDrawer } from './main/cash-drawer';
import {
  APP_HOST,
  APP_ORIGIN,
  APP_SCHEME,
  apiUrlOverride,
  debugEnabled,
  devRendererUrl,
  effectiveApiUrl,
  rendererDir,
} from './main/config';
import { log } from './main/logger';
import { defaultPrinterName, listPrinters, openPdfWindow, printHtmlSilently } from './main/printing';
import { secureStore } from './main/secure-store';
import { enqueueMutation, listMutations, startSyncEngine } from './main/sync-engine';
import { checkForUpdates, installAndRestart, setupAutoUpdates } from './main/updater';

// O Angular é servido em app://pos/ (origem estável, "secure", com fetch e
// CORS) em vez de file:// — o router com URLs normais funciona e a API vê
// sempre a mesma origem.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

let mainWindow: BrowserWindow | null = null;

if (!app.requestSingleInstanceLock()) {
  // Já há uma instância aberta neste PC: foca-a em vez de abrir outra caixa.
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(start).catch((err) => {
    log.error('Falha no arranque', err);
    app.quit();
  });
}

app.on('window-all-closed', () => app.quit());

process.on('uncaughtException', (err) => log.error('uncaughtException', err));
process.on('unhandledRejection', (err) => log.error('unhandledRejection', err));

async function start(): Promise<void> {
  log.info(`Arranque v${app.getVersion()} (${process.platform}) api=${effectiveApiUrl()}`);
  if (!debugEnabled()) Menu.setApplicationMenu(null);

  const csp = contentSecurityPolicy();
  registerAppProtocol(csp);
  lockDownSession(csp);
  registerIpc();
  createMainWindow();
  setupAutoUpdates(() => mainWindow);
  startSyncEngine(() => mainWindow);
}

// --- Renderer: protocolo app:// ------------------------------------------

function registerAppProtocol(csp: string): void {
  const root = rendererDir();
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return new Response('Not found', { status: 404 });

    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    let file = path.normalize(path.join(root, relative));
    // Nunca sair da pasta do renderer (../).
    if (!file.startsWith(root)) return new Response('Forbidden', { status: 403 });
    // Rotas do Angular (sem ficheiro) -> index.html.
    if (!relative || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(root, 'index.html');
    }
    const response = await net.fetch(pathToFileURL(file).toString());
    if (!file.endsWith('.html')) return response;
    const headers = new Headers(response.headers);
    headers.set('Content-Type', 'text/html; charset=utf-8');
    headers.set('Content-Security-Policy', csp);
    return new Response(response.body, { status: 200, headers });
  });
}

function contentSecurityPolicy(): string {
  const api = new URL(effectiveApiUrl()).origin;
  return [
    "default-src 'self'",
    "script-src 'self'",
    // Angular e SweetAlert injectam <style>; Google Fonts como no web.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    // QR da AGT vem em data: URI; o logo da empresa pode vir de https.
    "img-src 'self' data: blob: https:",
    `connect-src 'self' ${api}${devRendererUrl() ? ' ws: http://localhost:*' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function lockDownSession(csp: string): void {
  // Em desenvolvimento (ng serve) a CSP vai pelos cabeçalhos da resposta.
  const dev = devRendererUrl();
  if (dev) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      if (details.resourceType !== 'mainFrame' || !details.url.startsWith(dev)) {
        callback({});
        return;
      }
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
    });
  }

  // Nenhuma permissão do browser (câmara, notificações, geolocalização…).
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
}

// --- Janela principal ------------------------------------------------------

function readTerminalKiosk(): boolean {
  try {
    const raw = secureStore.get(TERMINAL_CONFIG_KEY);
    return raw ? JSON.parse(raw).kioskMode === true : false;
  } catch {
    return false;
  }
}

function createMainWindow(): void {
  const kiosk = readTerminalKiosk();
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 768,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'SeedsBSS POS',
    backgroundColor: '#f3f4f9',
    autoHideMenuBar: true,
    fullscreen: kiosk,
    icon: path.join(app.getAppPath(), 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: debugEnabled(),
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!kiosk) mainWindow?.maximize();
    mainWindow?.show();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Links externos abrem no browser do sistema; nada abre janelas novas.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Nunca navegar para fora da app.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = url.startsWith(`${APP_ORIGIN}/`) || (devRendererUrl() && url.startsWith(devRendererUrl()!));
    if (!allowed) {
      event.preventDefault();
      log.warn('Navegação bloqueada', { url });
    }
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log.error('Renderer terminou', details);
    if (details.reason !== 'clean-exit') mainWindow?.reload();
  });

  if (debugEnabled()) {
    mainWindow.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') mainWindow?.webContents.toggleDevTools();
    });
  }

  const target = devRendererUrl() ?? `${APP_ORIGIN}/`;
  void mainWindow.loadURL(target);
}

// --- IPC ----------------------------------------------------------------------

/** Só aceita chamadas da janela principal, com a app carregada. */
function fromApp(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  const ok =
    event.sender === mainWindow?.webContents &&
    (url.startsWith(`${APP_ORIGIN}/`) || (!!devRendererUrl() && url.startsWith(devRendererUrl()!)));
  if (!ok) log.warn('IPC recusado', { url });
  return ok;
}

function registerIpc(): void {
  // Síncronos (store e override da API).
  ipcMain.on(IPC.storeGet, (event, key: string) => {
    event.returnValue = fromApp(event) ? secureStore.get(String(key)) : null;
  });
  ipcMain.on(IPC.storeSet, (event, key: string, value: string) => {
    if (fromApp(event)) secureStore.set(String(key), String(value));
    event.returnValue = null;
  });
  ipcMain.on(IPC.storeRemove, (event, key: string) => {
    if (fromApp(event)) secureStore.remove(String(key));
    event.returnValue = null;
  });
  ipcMain.on(IPC.apiOverride, (event) => {
    event.returnValue = fromApp(event) ? apiUrlOverride() : null;
  });

  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R> | R) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!fromApp(event)) throw new Error('Pedido recusado.');
      return fn(...(args as A));
    });
  };

  handle(IPC.appInfo, (): DesktopAppInfo => ({
    version: app.getVersion(),
    platform: `${process.platform} ${process.arch}`,
    apiUrl: effectiveApiUrl(),
  }));

  handle(IPC.listPrinters, () => listPrinters(mainWindow!.webContents));

  handle(IPC.printHtml, (html: string, options: DesktopPrintHtmlOptions) => {
    if (typeof html !== 'string' || html.length > 5_000_000) throw new Error('Documento inválido.');
    return printHtmlSilently(html, options);
  });

  handle(IPC.openPdf, (data: ArrayBuffer, title: string) => {
    if (!(data instanceof ArrayBuffer) || data.byteLength > 50_000_000) throw new Error('PDF inválido.');
    return openPdfWindow(data, title, mainWindow ?? undefined);
  });

  handle(IPC.openDrawer, async (options: DesktopDrawerOptions) => {
    const printer = options?.printer || (await defaultPrinterName(mainWindow!.webContents));
    return openCashDrawer(printer);
  });

  handle(IPC.updateCheck, () => checkForUpdates());
  handle(IPC.updateInstall, () => installAndRestart());

  handle(IPC.kiosk, (enabled: boolean) => {
    mainWindow?.setFullScreen(!!enabled);
    if (!enabled) mainWindow?.maximize();
  });

  handle(IPC.offlineEnqueue, (input: OfflineEnqueueInput) => {
    if (typeof input?.id !== 'string' || typeof input?.companyId !== 'string') {
      throw new Error('Mutação offline inválida.');
    }
    return enqueueMutation(input);
  });

  handle(IPC.offlineList, (companyId: string) => listMutations(String(companyId)));
}
