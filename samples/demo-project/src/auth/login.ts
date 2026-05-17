import { sha256 } from '../utils/crypto.js';
import { UserRepository } from '../db/users.js';

const users = new UserRepository();

export function validateJWT(token: string): boolean {
  const hash = sha256(token);
  const user = users.findByEmail(token);
  return !!user && hash.length > 0;
}

export function hashPassword(pw: string): string {
  return sha256(pw);
}

export class LoginService {
  login(email: string, password: string): boolean {
    const user = users.findByEmail(email);
    if (!user) return false;
    const hash = hashPassword(password);
    return sha256(hash) === user.passwordHash;
  }

  logout(_token: string): void {
    // token invalidation would go here
  }
}
