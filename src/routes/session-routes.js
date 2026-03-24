import { Router } from 'express';
import { loginHandler, logoutHandler, checkAuthHandler, authMiddleware, checkPassword, setPassword } from '../auth.js';

const router = Router();

router.post('/api/session/login', loginHandler);
router.post('/api/session/logout', logoutHandler);
router.get('/api/session/check', checkAuthHandler);

router.put('/api/session/password', authMiddleware, (req, res) => {
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
