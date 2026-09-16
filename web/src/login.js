import { fontsReady } from './fonts.js';
import './styles.css';
import { Desk } from './desk.js';
import { passkeysSupported, signInWithPasskey } from './webauthn.js';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
Desk.create(document.getElementById('desk'), { reduced })?.lampOn();

const $ = (id) => document.getElementById(id);
const form = $('pass');
const password = $('password');
const code = $('code');
const codeField = $('code-field');
const error = $('error');
const note = $('note');
const submit = $('password-submit');
const passkeyBlock = $('passkey-block');
const passkeyBtn = $('passkey-btn');
const passwordBlock = $('password-block');
const usePassword = $('use-password');

const next = () => {
  const n = new URLSearchParams(location.search).get('next');
  return n && /^\/e\/\d{4}-\d{2}-\d{2}$/.test(n) ? n : '/';
};

const enter = () => {
  form.classList.add('is-opening');
  setTimeout(() => location.replace(next()), reduced ? 0 : 650);
};

const fail = (message) => {
  error.textContent = message;
  form.classList.remove('is-shaking');
  void form.offsetWidth;
  form.classList.add('is-shaking');
};

(async () => {
  fontsReady();
  try {
    const state = await fetch('/api/auth/state', { credentials: 'same-origin' }).then((r) => r.json());
    if (state.authenticated) return location.replace(next());
    codeField.hidden = !state.totp;
    if (!state.configured) note.textContent = 'No subscriber yet — run `python -m dailytimes auth set-password` on the server.';
    if (state.passkeys && passkeysSupported()) {
      passkeyBlock.hidden = false;
      passwordBlock.hidden = true;
      usePassword.hidden = false;
      passkeyBtn.focus();
    } else {
      password.focus();
    }
  } catch {
    note.textContent = 'The press room is unreachable right now.';
  }
})();

usePassword.addEventListener('click', () => {
  passwordBlock.hidden = false;
  usePassword.hidden = true;
  passkeyBlock.classList.add('is-secondary');
  error.textContent = '';
  password.focus();
});

passkeyBtn.addEventListener('click', async () => {
  error.textContent = '';
  passkeyBtn.disabled = true;
  try {
    await signInWithPasskey();
    enter();
  } catch (err) {
    fail(err.name === 'NotAllowedError'
      ? 'Passkey sign-in was cancelled or timed out.'
      : err.message || 'Passkey sign-in failed.');
  } finally {
    passkeyBtn.disabled = false;
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (passwordBlock.hidden) return;
  error.textContent = '';
  submit.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password.value, code: code.value }),
    });
    if (res.ok) return enter();
    const body = await res.json().catch(() => ({}));
    fail(body.error || 'Sign-in failed.');
    password.select();
  } catch {
    error.textContent = 'Could not reach the press room.';
  } finally {
    submit.disabled = false;
  }
});
