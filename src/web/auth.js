import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE = 'stark_dashboard';
const TTL = 12 * 60 * 60 * 1000;
function equal(a, b) {
  const first = Buffer.from(a), second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}
export function createDashboardAuth({ password, secret, logger }) {
  const activePassword = password || randomBytes(18).toString('base64url');
  const key = secret || activePassword;
  if (!password) logger.info(`كلمة مرور لوحة التحكم المؤقتة: ${activePassword} — لتثبيتها أضف DASHBOARD_PASSWORD في Railway.`);
  const attempts = new Map();
  const sign = payload => createHmac('sha256', key).update(payload).digest('base64url');
  function validSession(req) {
    const value = req.headers.cookie?.split(';').map(c => c.trim()).find(c => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!value || value.length > 512) return false;
    const [payload, signature, extra] = value.split('.');
    if (extra || !payload || !signature || !equal(sign(payload), signature)) return false;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
      return Number.isFinite(data.expires) && data.expires > Date.now() && data.expires <= Date.now() + TTL;
    } catch { return false; }
  }
  function sameOrigin(req, res, next) {
    const origin = req.get('origin');
    if (origin && origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({ message: 'هذا الطلب يجب أن يأتي من لوحة التحكم نفسها.' });
    next();
  }
  function requireSession(req, res, next) {
    if (!validSession(req)) return res.status(401).json({ message: 'سجّل الدخول إلى لوحة التحكم.' });
    next();
  }
  function login(req, res) {
    const now = Date.now();
    const ip = req.ip;
    let entry = attempts.get(ip);
    if (!entry || now > entry.until) entry = { count: 0, until: now + 15 * 60 * 1000 };
    if (entry.count >= 10) {
      res.set('Retry-After', String(Math.ceil((entry.until - now) / 1000)));
      return res.status(429).json({ message: 'محاولات كثيرة. انتظر 15 دقيقة ثم أعد المحاولة.' });
    }
    if (typeof req.body?.password !== 'string' || !equal(req.body.password, activePassword)) {
      entry.count++;
      if (attempts.size > 10000) attempts.delete(attempts.keys().next().value);
      attempts.set(ip, entry);
      return res.status(401).json({ message: 'كلمة المرور غير صحيحة.' });
    }
    attempts.delete(ip);
    const payload = Buffer.from(JSON.stringify({ expires: now + TTL, nonce: randomBytes(12).toString('hex') })).toString('base64url');
    res.cookie(COOKIE, `${payload}.${sign(payload)}`, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: TTL, path: '/' });
    res.json({ ok: true });
  }
  function logout(req, res) {
    res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/' });
    res.json({ ok: true });
  }
  return { validSession, sameOrigin, requireSession, login, logout };
}
