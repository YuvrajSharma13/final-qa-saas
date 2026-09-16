const express = require('express');
const mode = require('../mode');

const router = express.Router();

const USERS = [
  { id: 'u1', email: 'demo@quickbite.test', password: 'quickbite123', name: 'Demo Diner' },
];

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};

  if (mode.isFixed()) {
    if (typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const user = USERS.find((u) => u.email === email.toLowerCase());
    if (!user || user.password !== password) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    return res.json({ token: `demo-${user.id}`, user: { id: user.id, name: user.name, email: user.email } });
  }

  // BUG (login): the lookup result is used without a null check, so an unknown
  // email throws "Cannot read properties of undefined" -> unhandled 500.
  const user = USERS.find((u) => u.email === String(email).toLowerCase());
  if (user.password !== password) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  return res.json({ token: `demo-${user.id}`, user: { id: user.id, name: user.name, email: user.email } });
});

module.exports = router;
