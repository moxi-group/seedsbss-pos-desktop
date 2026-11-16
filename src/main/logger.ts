import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 2 * 1024 * 1024;

function logFile(): string {
  const dir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'main.log');
}

/** Log simples em ficheiro (userData/logs/main.log), rodado aos 2 MB.
 * Serve para o suporte pedir ao cliente quando algo falha no balcão. */
function write(level: string, message: string, extra?: unknown): void {
  const line = `${new Date().toISOString()} ${level} ${message}${
    extra === undefined ? '' : ' ' + (extra instanceof Error ? extra.stack ?? extra.message : JSON.stringify(extra))
  }\n`;
  if (!app.isPackaged) process.stdout.write(line);
  try {
    const file = logFile();
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) {
      fs.renameSync(file, file + '.1');
    }
    fs.appendFileSync(file, line);
  } catch {
    // nunca deixar o log derrubar a app
  }
}

export const log = {
  info: (message: string, extra?: unknown) => write('INFO', message, extra),
  warn: (message: string, extra?: unknown) => write('WARN', message, extra),
  error: (message: string, extra?: unknown) => write('ERROR', message, extra),
};
