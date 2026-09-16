const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const loginSuccess = document.getElementById('login-success');

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginError.classList.add('hidden');
  loginSuccess.classList.add('hidden');
  const payload = {
    email: document.getElementById('email').value,
    password: document.getElementById('password').value,
  };

  if (window.QB.fixed) {
    try {
      const res = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Sign-in failed, please try again.');
      loginSuccess.textContent = `Welcome back, ${data.user.name}!`;
      loginSuccess.classList.remove('hidden');
    } catch (err) {
      loginError.textContent = err.message;
      loginError.classList.remove('hidden');
    }
    return;
  }

  // BUG (login UI): the response is parsed as JSON without checking the status
  // or catching errors. When the API returns an HTML 500 page the promise
  // rejects, nothing is shown to the user and the error is left unhandled.
  const res = await fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (data.error) {
    loginError.textContent = data.error;
    loginError.classList.remove('hidden');
    return;
  }
  loginSuccess.textContent = `Welcome back, ${data.user.name}!`;
  loginSuccess.classList.remove('hidden');
});
