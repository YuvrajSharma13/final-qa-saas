function renderSummary() {
  const cart = getCart();
  const list = document.getElementById('summary-items');
  list.innerHTML = cart.length ? '' : '<li>Your cart is empty</li>';
  for (const line of cart) {
    const li = document.createElement('li');
    li.textContent = `${line.quantity} × ${line.name}`;
    list.appendChild(li);
  }
  const total = cart.reduce((s, l) => s + l.price * l.quantity, 0);
  document.getElementById('summary-total').textContent = money(total);
}

document.getElementById('checkout-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorBox = document.getElementById('checkout-error');
  errorBox.classList.add('hidden');
  const form = event.target;
  const payload = {
    customer: {
      name: form.name.value,
      email: form.email.value,
      phone: form.phone.value,
      address: form.address.value,
    },
    items: getCart().map((l) => ({ id: l.id, quantity: l.quantity })),
  };
  try {
    const res = await fetch('/api/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not place your order.');
    localStorage.removeItem(CART_KEY);
    window.location.href = `/order?id=${encodeURIComponent(data.id)}`;
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.classList.remove('hidden');
  }
});

renderSummary();
