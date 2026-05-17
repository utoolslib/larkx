// Legacy encryption — nothing in the project uses this anymore
export function oldEncrypt(data: string): string {
  return Buffer.from(data).toString('base64');
}
