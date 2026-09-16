const express = require('express');
const { getMenu, findItem } = require('../data/menu');

const router = express.Router();

router.get('/menu', (_req, res) => {
  res.json({ items: getMenu() });
});

router.get('/menu/:id', (req, res) => {
  const item = findItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Menu item not found' });
  return res.json(item);
});

module.exports = router;
