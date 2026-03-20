import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { loginHandler, logoutHandler, checkAuthHandler, authMiddleware, checkPassword, setPassword } from '../auth.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
});

router.post('/api/login', loginLimiter, loginHandler);
router.post('/api/logout', logoutHandler);
router.get('/api/auth-check', checkAuthHandler);

router.put('/api/auth/password', authMiddleware, (req, res) => {
  const { current, newPassword } = req.body || {};
  if (!current || !newPassword) {
    return res.status(400).json({ error: 'Both current and newPassword are required' });
  }
  if (!checkPassword(current)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  setPassword(newPassword);
  return res.json({ ok: true });
});

export default router;
