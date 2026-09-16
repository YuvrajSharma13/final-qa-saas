async function loadMenu() {
  const container = document.getElementById('menu');
  const res = await fetch('/api/menu');
  const { items } = await res.json();
  container.innerHTML = '';
  for (const item of items) {
    const card = document.createElement('article');
    card.className = 'menu-card';
    card.dataset.itemId = item.id;
    card.innerHTML = `
      <img src="${item.image}" alt="${item.name}" loading="eager">
      <div class="body">
        <h3>${item.name}</h3>
        <span class="muted">${item.category}</span>
        <span class="price">${money(item.price)}</span>
        <button class="btn btn-primary add-to-cart" type="button">Add to cart</button>
      </div>`;
    card.querySelector('button').addEventListener('click', (e) => {
      addToCart(item);
      e.target.textContent = 'Added ✓';
      setTimeout(() => { e.target.textContent = 'Add to cart'; }, 1200);
    });
    container.appendChild(card);
  }
}
loadMenu();
