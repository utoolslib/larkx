import { createHash, randomBytes } from 'crypto';

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export function compareHash(a: string, b: string): boolean {
  return a === b;
}
