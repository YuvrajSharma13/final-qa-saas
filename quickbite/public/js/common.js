// Shared helpers: cart storage, money formatting and the site header.
const CART_KEY = 'quickbite_cart';

function getCart() {
  try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch { return []; }
}
function saveCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  renderCartCount();
}
function addToCart(item) {
  const cart = getCart();
  const existing = cart.find((c) => c.id === item.id);
  if (existing) existing.quantity += 1;
  else cart.push({ id: item.id, name: item.name, price: item.price, quantity: 1 });
  saveCart(cart);
}
function money(n) {
  return `$${Number(n).toFixed(2)}`;
}
function renderCartCount() {
  const el = document.getElementById('cart-count');
  if (el) el.textContent = String(getCart().reduce((s, c) => s + c.quantity, 0));
}
function renderHeader(active) {
  const header = document.createElement('header');
  header.className = 'site-header';
  header.innerHTML = `
    <a class="brand" href="/"><img src="/img/logo.svg" alt="" width="28" height="28">QuickBite</a>
    <nav class="site-nav" aria-label="Main">
      <a href="/menu" class="${active === 'menu' ? 'active' : ''}">Menu</a>
      <a href="/cart" class="${active === 'cart' ? 'active' : ''}">Cart (<span id="cart-count">0</span>)</a>
      <a href="/checkout" class="${active === 'checkout' ? 'active' : ''}">Checkout</a>
      <a href="/login" class="${active === 'login' ? 'active' : ''}">Sign in</a>
    </nav>`;
  document.body.prepend(header);
  renderCartCount();
}
