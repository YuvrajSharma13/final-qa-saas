async function loadOrder() {
  const id = new URLSearchParams(window.location.search).get('id');
  const loading = document.getElementById('order-loading');
  try {
    if (!id) throw new Error('Missing order id');
    const res = await fetch(`/api/orders/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`Order lookup failed with status ${res.status}`);
    const order = await res.json();
    document.getElementById('order-greeting').textContent = order.receipt.greeting;
    document.getElementById('order-id').textContent = order.id;
    document.getElementById('order-total').textContent = money(order.total);
    document.getElementById('order-success').classList.remove('hidden');
  } catch (err) {
    console.error('[order] confirmation failed:', err.message);
    document.getElementById('order-error').classList.remove('hidden');
  } finally {
    loading.classList.add('hidden');
  }
}
loadOrder();
