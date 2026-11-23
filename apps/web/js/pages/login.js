import { api } from '../api.js';

export function render(root, { onLogin }) {
  root.innerHTML = `
    <form class="card login" novalidate>
      <h1>เข้าสู่ระบบ</h1>
      <div class="muted small">SFF Smart Shrimp — ระบบฟาร์มกุ้งขาว</div>
      <label for="u">ชื่อผู้ใช้</label>
      <input id="u" class="input" name="username" autocomplete="username" autocapitalize="none" required>
      <label for="p">รหัสผ่าน</label>
      <input id="p" class="input" name="password" type="password" autocomplete="current-password" required>
      <button class="btn btn-primary" type="submit">เข้าสู่ระบบ</button>
      <div class="error" role="alert"></div>
    </form>`;
  const form = root.querySelector('form');
  const err = root.querySelector('.error');
  const btn = form.querySelector('button');
  form.username.focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    btn.disabled = true;
    try {
      await api.login(form.username.value.trim(), form.password.value);
      await onLogin();
    } catch (ex) {
      err.textContent = navigator.onLine ? ex.message : 'ไม่มีอินเทอร์เน็ต';
      btn.disabled = false;
    }
  });
  return () => {};
}
