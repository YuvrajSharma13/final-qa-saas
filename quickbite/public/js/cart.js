function calculateCartTotal(cart) {
  if (window.QB.fixed) {
    return cart.reduce((sum, line) => sum + line.price * line.quantity, 0);
  }
  // BUG (cart): the total sums unit prices and ignores the quantity, so it is
  // wrong as soon as a quantity is changed.
  return cart.reduce((sum, line) => sum + line.price, 0);
}

function renderCart() {
  const cart = getCart();
  const rows = document.getElementById('cart-rows');
  document.getElementById('cart-empty').classList.toggle('hidden', cart.length > 0);
  rows.innerHTML = '';
  cart.forEach((line, index) => {
    const tr = document.createElement('tr');
    tr.className = 'cart-line';
    tr.innerHTML = `
      <td>${line.name}</td>
      <td class="unit-price">${money(line.price)}</td>
      <td><input type="number" min="1" max="50" value="${line.quantity}" aria-label="Quantity for ${line.name}"></td>
      <td class="line-subtotal">${money(line.price * line.quantity)}</td>`;
    tr.querySelector('input').addEventListener('change', (e) => updateQuantity(index, e.target.value));
    rows.appendChild(tr);
  });
  document.getElementById('cart-total').textContent = money(calculateCartTotal(cart));
}

function updateQuantity(index, value) {
  const cart = getCart();
  const quantity = Math.max(1, Math.min(50, parseInt(value, 10) || 1));
  cart[index].quantity = quantity;
  saveCart(cart);
  renderCart();
}

renderCart();
