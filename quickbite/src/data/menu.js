const mode = require('../mode');

const MENU = [
  { id: 'm1', name: 'Margherita Pizza', price: 12.5, image: '/img/pizza.svg', category: 'Mains', available: true },
  { id: 'm2', name: 'Paneer Tikka Wrap', price: 9.0, image: '/img/wrap.svg', category: 'Mains', available: true },
  { id: 'm3', name: 'Garden Salad', price: 7.25, image: '/img/salad.svg', category: 'Starters', available: true },
  { id: 'm4', name: 'Masala Fries', price: 4.5, image: '/img/fries.svg', category: 'Sides', available: true },
  { id: 'm5', name: 'Mango Lassi', price: 3.75, image: '/img/lassi.svg', category: 'Drinks', available: true },
  { id: 'm6', name: 'Chocolate Brownie', price: 5.0, image: '/img/brownie.svg', category: 'Desserts', available: true },
];

function getMenu() {
  return MENU.map((item) => {
    // BUG (menu): the wrap image was renamed during a redesign but the data
    // still points to the old PNG path, so the menu renders a broken image.
    if (item.id === 'm2' && !mode.isFixed()) {
      return { ...item, image: '/img/paneer-tikka-wrap.png' };
    }
    return item;
  });
}

function findItem(id) {
  return getMenu().find((m) => m.id === id);
}

module.exports = { getMenu, findItem };
