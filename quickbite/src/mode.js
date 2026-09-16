// Demo switch between the buggy and the fixed implementation.
let fixed = process.env.QUICKBITE_FIXED === '1';

module.exports = {
  isFixed: () => fixed,
  set: (value) => { fixed = value; },
  get: () => ({ fixed, mode: fixed ? 'fixed' : 'buggy' }),
};
