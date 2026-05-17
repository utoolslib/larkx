import { validateJWT } from './login.js';

type Req = { headers: Record<string, string> };
type Res = { status: (c: number) => { json: (d: object) => void } };
type Next = () => void;

const requestCounts = new Map<string, number>();

export function authMiddleware(req: Req, res: Res, next: Next): void {
  const auth = req.headers['authorization'] ?? '';
  const token = auth.replace(/^Bearer /, '');
  if (!token || !validateJWT(token)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

export function rateLimiter(req: Req, res: Res, next: Next): void {
  const ip = req.headers['x-forwarded-for'] ?? 'unknown';
  const count = (requestCounts.get(ip) ?? 0) + 1;
  requestCounts.set(ip, count);
  if (count > 100) {
    res.status(429).json({ error: 'Too many requests' });
    return;
  }
  next();
}
