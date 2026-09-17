// QuickBite — a deliberately small restaurant ordering site.
// It is the demo target for the AI QA SaaS and contains a handful of
// INTENTIONAL bugs. Set QUICKBITE_FIXED=1 (or POST /__demo/mode) to switch
// every bug to its fixed implementation so the "developer fixes and reruns QA"
// loop can be demonstrated.
const express = require('express');
const path = require('path');
const mode = require('./src/mode');
const authRoutes = require('./src/routes/auth');
const menuRoutes = require('./src/routes/menu');
const orderRoutes = require('./src/routes/orders');

const app = express();
app.use(express.json());

// Demo-only control endpoint (not part of the "product").
app.get('/__demo/mode', (_req, res) => res.json(mode.get()));
app.post('/__demo/mode', (req, res) => {
  mode.set(Boolean(req.body && req.body.fixed));
  res.json(mode.get());
});

// Runtime config consumed by the browser scripts.
app.get('/js/config.js', (_req, res) => {
  res.type('application/javascript').send(`window.QB = ${JSON.stringify({ fixed: mode.isFixed() })};`);
});

app.use('/api', authRoutes);
app.use('/api', menuRoutes);
app.use('/api', orderRoutes);

app.get('/openapi.json', (_req, res) => res.sendFile(path.join(__dirname, 'openapi.json'), { dotfiles: 'allow' }));

// Pages get a body class so the stylesheet can switch between buggy/fixed layout.
const PAGES = ['index', 'login', 'menu', 'cart', 'checkout', 'order'];
for (const page of PAGES) {
  const route = page === 'index' ? '/' : `/${page}`;
  const handler = (_req, res) => {
    const fs = require('fs');
    const html = fs.readFileSync(path.join(__dirname, 'public', `${page}.html`), 'utf8');
    res.type('html').send(html.replace('<body>', `<body class="${mode.isFixed() ? 'qb-fixed' : 'qb-legacy'}">`));
  };
  app.get(route, handler);
  if (page !== 'index') app.get(`/${page}.html`, handler);
}

app.use(express.static(path.join(__dirname, 'public')));

// Express default error handler is used on purpose: unhandled exceptions become
// HTML 500 pages, exactly like many small production apps.
if (require.main === module) {
  const PORT = Number(process.env.PORT || 4100);
  app.listen(PORT, () => {
    console.log(`QuickBite listening on http://localhost:${PORT} (mode: ${mode.isFixed() ? 'fixed' : 'buggy'})`);
  });
}

module.exports = app;
