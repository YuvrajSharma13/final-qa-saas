const express = require('express');
const crypto = require('crypto');
const mode = require('../mode');
const { findItem } = require('../data/menu');

const router = express.Router();
const ORDERS = new Map();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateOrder(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return ['Body must be a JSON object'];
  const c = body.customer;
  if (!c || typeof c !== 'object') errors.push('customer is required');
  else {
    if (typeof c.name !== 'string' || !c.name.trim()) errors.push('customer.name is required');
    if (typeof c.email !== 'string' || !EMAIL_RE.test(c.email)) errors.push('customer.email must be a valid email');
    if (typeof c.phone !== 'string' || c.phone.replace(/\D/g, '').length < 7) errors.push('customer.phone is invalid');
    if (typeof c.address !== 'string' || !c.address.trim()) errors.push('customer.address is required');
  }
  if (!Array.isArray(body.items) || body.items.length === 0) errors.push('items must be a non-empty array');
  else {
    body.items.forEach((it, i) => {
      if (!it || !findItem(it.id)) errors.push(`items[${i}].id is unknown`);
      if (!Number.isInteger(it && it.quantity) || it.quantity < 1 || it.quantity > 50) errors.push(`items[${i}].quantity must be 1-50`);
    });
  }
  return errors;
}

function priceItems(items) {
  return items.map((it) => {
    const menuItem = findItem(it.id);
    return { id: it.id, name: menuItem.name, price: menuItem.price, quantity: it.quantity };
  });
}

router.post('/orders', (req, res) => {
  const body = req.body;

  if (mode.isFixed()) {
    const errors = validateOrder(body);
    if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });
  }

  // BUG (checkout API): without validation, malformed payloads crash below
  // (e.g. body.customer.name.trim() on a missing customer, or an unknown item
  // id) and surface as unhandled 500 responses instead of 400.
  const customer = {
    name: body.customer.name.trim(),
    email: body.customer.email.toLowerCase(),
    phone: body.customer.phone,
    address: body.customer.address.trim(),
  };
  const items = priceItems(body.items);
  const total = Math.round(items.reduce((s, it) => s + it.price * it.quantity, 0) * 100) / 100;
  const id = crypto.randomBytes(4).toString('hex');
  ORDERS.set(id, { id, customer, items, total, createdAt: new Date().toISOString() });
  return res.status(201).json({ id, total });
});

function buildReceipt(order) {
  if (mode.isFixed()) {
    return { greeting: `Thanks ${order.customer.name}!`, total: order.total };
  }
  // BUG (order confirmation): receipt JSON is assembled by string
  // concatenation, so names containing a double quote or backslash produce
  // invalid JSON and the confirmation endpoint throws.
  return JSON.parse(`{"greeting":"Thanks ${order.customer.name}!","total":${order.total}}`);
}

router.get('/orders/:id', (req, res) => {
  const order = ORDERS.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const receipt = buildReceipt(order);
  return res.json({ ...order, receipt });
});

module.exports = router;
