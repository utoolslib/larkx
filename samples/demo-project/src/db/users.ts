import { log } from '../utils/logger.js';

export type User = { id: string; email: string; passwordHash: string };

const store: User[] = [];

export class UserRepository {
  findById(id: string): User | undefined {
    log(`findById: ${id}`);
    return store.find(u => u.id === id);
  }

  findByEmail(email: string): User | undefined {
    log(`findByEmail: ${email}`);
    return store.find(u => u.email === email);
  }

  create(email: string, passwordHash: string): User {
    log(`create: ${email}`);
    const user: User = { id: Math.random().toString(36).slice(2), email, passwordHash };
    store.push(user);
    return user;
  }
}
