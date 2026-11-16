import { BrowserWindow, WebContents, app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { DesktopPrinter, DesktopPrintHtmlOptions } from '../shared/bridge';
import { log } from './logger';

const PAPER_MICRONS: Record<DesktopPrintHtmlOptions['paperWidth'], number> = {
  '80mm': 80_000,
  '58mm': 58_000,
};
const MICRONS_PER_CSS_PX = 25_400 / 96;

/** Janela escondida, sem preload nem Node, para render de talões/PDF. */
function hiddenWindow(): BrowserWindow {
  return new BrowserWindow({
    show: false,
    width: 400,
    height: 800,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // O HTML do talão não tem scripts (versão "não interactiva" do
      // ThermalPrintService); JS só é preciso para medir a altura.
      javascript: true,
    },
  });
}

function tempFile(prefix: string, ext: string): string {
  const dir = path.join(os.tmpdir(), 'seedsbss-pos');
  fs.mkdirSync(dir, { recursive: true });
  const safe = prefix.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'doc';
  return path.join(dir, `${safe}-${Date.now()}.${ext}`);
}

export async function listPrinters(contents: WebContents): Promise<DesktopPrinter[]> {
  const printers = await contents.getPrintersAsync();
  return printers.map((p) => {
    const raw = p as unknown as { isDefault?: boolean; options?: Record<string, string> };
    return {
      name: p.name,
      displayName: p.displayName || p.name,
      isDefault: raw.isDefault === true || raw.options?.['printer-is-default'] === 'true',
    };
  });
}

/** Nome da impressora por omissão (ou null se o sistema não indicar). */
export async function defaultPrinterName(contents: WebContents): Promise<string | null> {
  const printers = await listPrinters(contents);
  return printers.find((p) => p.isDefault)?.name ?? null;
}

/**
 * Imprime um documento HTML completo sem diálogo. A altura da página é a
 * do conteúdo (papel de rolo), a largura a do papel escolhido.
 */
export async function printHtmlSilently(html: string, options: DesktopPrintHtmlOptions): Promise<void> {
  const file = tempFile('talao', 'html');
  fs.writeFileSync(file, html, 'utf8');
  const win = hiddenWindow();
  try {
    await win.loadURL(pathToFileURL(file).toString());
    const heightPx = Number(
      await win.webContents.executeJavaScript('Math.ceil(document.documentElement.scrollHeight)', true),
    );
    const width = PAPER_MICRONS[options.paperWidth] ?? PAPER_MICRONS['80mm'];
    // Margem de segurança de ~5 mm para o corte.
    const height = Math.max(50_000, Math.ceil(heightPx * MICRONS_PER_CSS_PX) + 5_000);

    await new Promise<void>((resolve, reject) => {
      win.webContents.print(
        {
          silent: true,
          printBackground: false,
          deviceName: options.printer || undefined,
          margins: { marginType: 'none' },
          pageSize: { width, height },
        },
        (success, failureReason) => {
          if (success) resolve();
          else reject(new Error(failureReason || 'a impressora recusou o trabalho'));
        },
      );
    });
    log.info('Talão impresso', { printer: options.printer ?? '(omissão)', width: options.paperWidth });
  } catch (err) {
    log.error('Falha a imprimir talão', err);
    throw err;
  } finally {
    if (!win.isDestroyed()) win.destroy();
    fs.rm(file, { force: true }, () => undefined);
  }
}

/** Abre um PDF numa janela da app, com o visualizador do Chromium (que
 * tem botão de imprimir e de guardar). */
export async function openPdfWindow(data: ArrayBuffer, title: string, parent?: BrowserWindow): Promise<void> {
  const file = tempFile(title || 'documento', 'pdf');
  fs.writeFileSync(file, Buffer.from(data));
  const win = new BrowserWindow({
    width: 900,
    height: 1000,
    title: title || 'Documento',
    parent,
    autoHideMenuBar: true,
    icon: path.join(app.getAppPath(), 'build', 'icon.png'),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      plugins: true, // visualizador de PDF do Chromium
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('page-title-updated', (event) => event.preventDefault());
  win.on('closed', () => fs.rm(file, { force: true }, () => undefined));
  await win.loadURL(pathToFileURL(file).toString());
}
