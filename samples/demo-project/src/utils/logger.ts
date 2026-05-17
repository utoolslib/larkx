export function log(msg: string): void {
  console.log(`[INFO]  ${new Date().toISOString()} ${msg}`);
}

export function warn(msg: string): void {
  console.warn(`[WARN]  ${new Date().toISOString()} ${msg}`);
}

export function error(msg: string): void {
  console.error(`[ERROR] ${new Date().toISOString()} ${msg}`);
}
