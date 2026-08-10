import { Preferences } from '@capacitor/preferences';

const KEY = 'sdrServerUrl';

const formView = document.getElementById('form-view');
const connectView = document.getElementById('connect-view');
const input = document.getElementById('server-input');
const targetUrl = document.getElementById('target-url');
const changeBtn = document.getElementById('change-btn');

// Native "Server settings" navigation loads the shell with ?settings=1 so it
// always shows the form instead of auto-connecting.
const forcedSettings = new URLSearchParams(window.location.search).get('settings') === '1';

let saved = '';

function normalise(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  u = u.replace(/\/+$/, '');
  if (!u.replace(/^https?:\/\//i, '').includes(':')) u += ':8080';
  return u;
}

function show(view) {
  formView.classList.remove('show');
  connectView.classList.remove('show');
  view.classList.add('show');
}

async function connect(url) {
  const target = normalise(url);
  if (!target) return;
  await Preferences.set({ key: KEY, value: target });
  window.location.replace(target);
}

document.getElementById('connect-btn').addEventListener('click', (e) => {
  e.preventDefault();
  connect(input.value);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    connect(input.value);
  }
});

changeBtn.addEventListener('click', async () => {
  await Preferences.remove({ key: KEY });
  input.value = '';
  show(formView);
});

async function init() {
  const stored = await Preferences.get({ key: KEY });
  saved = stored.value || '';
  if (!forcedSettings && saved) {
    targetUrl.textContent = saved;
    show(connectView);
    window.setTimeout(() => window.location.replace(saved), 700);
  } else {
    input.value = saved;
    show(formView);
    input.focus();
  }
}

init();
