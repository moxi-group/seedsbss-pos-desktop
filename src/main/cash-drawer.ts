import { execFile } from 'node:child_process';

import { log } from './logger';

/**
 * Comando ESC/POS "pulso para a gaveta": ESC p m t1 t2.
 * m = 0 (pino 2, o mais comum); t1/t2 = tempos de ligar/desligar
 * (25 ms / 250 ms em unidades de 2 ms). Funciona com a generalidade das
 * térmicas ESC/POS (Epson, Xprinter, Bixolon, Sewoo, …) com a gaveta na
 * ficha RJ11 da impressora.
 */
export const DRAWER_KICK = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);

/**
 * Envia bytes "RAW" para uma impressora instalada no Windows, pelo
 * spooler (winspool.drv), sem driver gráfico pelo meio. Usa PowerShell
 * com um pequeno helper C# para não precisar de módulos nativos (que
 * obrigam a recompilar para cada versão do Electron).
 *
 * O nome da impressora e os bytes passam por variáveis de ambiente, nunca
 * interpolados no script.
 */
const RAW_PRINT_PS = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SeedsRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool OpenPrinter(string name, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool StartDocPrinter(IntPtr h, int level, [In] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool WritePrinter(IntPtr h, byte[] buf, int count, out int written);
  public static void Send(string printer, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("OpenPrinter falhou (" + Marshal.GetLastWin32Error() + ")");
    try {
      var di = new DOCINFO { pDocName = "SeedsBSS POS", pDataType = "RAW" };
      if (!StartDocPrinter(h, 1, di)) throw new Exception("StartDocPrinter falhou (" + Marshal.GetLastWin32Error() + ")");
      try {
        StartPagePrinter(h);
        int written;
        if (!WritePrinter(h, bytes, bytes.Length, out written)) throw new Exception("WritePrinter falhou (" + Marshal.GetLastWin32Error() + ")");
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
"@
$printer = $env:SEEDS_PRINTER
if ([string]::IsNullOrWhiteSpace($printer)) {
  Add-Type -AssemblyName System.Drawing
  $printer = (New-Object System.Drawing.Printing.PrinterSettings).PrinterName
}
[SeedsRawPrinter]::Send($printer, [Convert]::FromBase64String($env:SEEDS_BYTES))
`;

function run(command: string, args: string[], env: NodeJS.ProcessEnv, input?: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { env: { ...process.env, ...env }, timeout: 15_000, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).toString().trim().split('\n').pop() || err.message));
      else resolve();
    });
    if (input) {
      child.stdin?.end(input);
    }
  });
}

export async function sendRawToPrinter(printer: string | null, bytes: Buffer): Promise<void> {
  if (process.platform === 'win32') {
    await run(
      'powershell.exe',
      // -EncodedCommand (UTF-16LE em base64): o powershell.exe estraga aspas
      // passadas em -Command pela linha de comandos do Windows.
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(RAW_PRINT_PS, 'utf16le').toString('base64'),
      ],
      { SEEDS_PRINTER: printer ?? '', SEEDS_BYTES: bytes.toString('base64') },
    );
    return;
  }
  // macOS/Linux (desenvolvimento): CUPS em modo raw.
  const args = ['-o', 'raw'];
  if (printer) args.unshift('-d', printer);
  await run('lp', args, {}, bytes);
}

export async function openCashDrawer(printer: string | null): Promise<void> {
  try {
    await sendRawToPrinter(printer, DRAWER_KICK);
    log.info('Gaveta aberta', { printer: printer ?? '(omissão)' });
  } catch (err) {
    log.error('Falha a abrir gaveta', err);
    throw err;
  }
}
