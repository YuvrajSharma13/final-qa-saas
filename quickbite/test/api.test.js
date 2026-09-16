// QuickBite API tests (node:test). Run with `npm test`.
// Some of these fail on purpose while the intentional bugs are present.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../server');

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('menu lists items with prices', async () => {
  const res = await fetch(`${base}/api/menu`);
  assert.equal(res.status, 200);
  const { items } = await res.json();
  assert.ok(items.length >= 5);
  assert.ok(items.every((i) => typeof i.price === 'number'));
});

test('valid login succeeds', async () => {
  const res = await post('/api/login', { email: 'demo@quickbite.test', password: 'quickbite123' });
  assert.equal(res.status, 200);
});

test('login with an unknown email returns 401 JSON', async () => {
  const res = await post('/api/login', { email: 'nobody@example.com', password: 'nope' });
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /invalid/i);
});

test('placing a valid order returns 201', async () => {
  const res = await post('/api/orders', {
    customer: { name: 'Asha Rao', email: 'asha@example.com', phone: '+1 555 010 2020', address: '12 Market Street' },
    items: [{ id: 'm1', quantity: 2 }],
  });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).total, 25);
});
