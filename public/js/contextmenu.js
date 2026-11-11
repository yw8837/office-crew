// 우클릭 메뉴: 브라우저 기본 메뉴(새로 고침·인쇄·검사…) 대신 누른 자리에 맞는 앱 메뉴를 띄운다.
// 글 입력칸은 붙여넣기·맞춤법 때문에 브라우저 메뉴를 그대로 두고, Shift+우클릭은 언제나 브라우저 메뉴다.
import { state, changed, toast, agentById } from './state.js';
import { t } from './i18n/index.js';

let menu = null;
let restore = null; // 메뉴를 닫을 때 초점을 돌려줄 곳

function close() {
  if (!menu) return;
  menu.remove();
  menu = null;
  removeEventListener('pointerdown', onOutside, true);
  removeEventListener('keydown', onKey, true);
  removeEventListener('scroll', close, true);
  removeEventListener('resize', close);
  removeEventListener('blur', close);
  try { restore?.focus?.({ preventScroll: true }); } catch { /* 사라진 요소 */ }
  restore = null;
}
const onOutside = (e) => { if (menu && !menu.contains(e.target)) close(); };
function onKey(e) {
  if (!menu) return;
  const items = [...menu.querySelectorAll('button')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') { e.preventDefault(); close(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus(); }
  else if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus(); }
  else if (e.key === 'Tab') { e.preventDefault(); close(); }
}

const copy = (text) => {
  if (!navigator.clipboard) { toast(t('복사하지 못했어'), 'error'); return; }
  navigator.clipboard.writeText(text).then(() => toast(t('복사했어'), 'ok', 1500), () => toast(t('복사하지 못했어'), 'error'));
};
// 인용은 짧게: 6줄·400자까지만 넣고 잘렸으면 … 을 붙인다(입력칸이 인용문으로 가득 차지 않게)
const quote = (text) => {
  const lines = text.trim().split('\n').filter((l) => l.trim());
  let cut = lines.slice(0, 6).join('\n');
  const more = lines.length > 6 || cut.length > 400;
  if (cut.length > 400) cut = cut.slice(0, 400);
  return `${cut.split('\n').map((l) => `> ${l}`).join('\n')}${more ? ' …' : ''}\n\n`;
};

// 누른 자리에서 메뉴 항목을 만든다. [{ label, run }] 또는 null(구분선)
export function itemsFor(target) {
  const items = [];
  const sel = String(getSelection?.() || '').trim();
  if (sel) {
    items.push({ label: t('선택한 글 복사'), run: () => copy(sel) });
    if (state.route.view === 'session') items.push({ label: t('선택한 글을 인용해서 쓰기'), run: () => { state.ui.draft = quote(sel); changed(); } });
  }
  const link = target.closest?.('a[href]');
  if (link) items.push({ label: t('링크 주소 복사'), run: () => copy(link.href) });

  const msg = target.closest?.('.msg');
  if (msg && !msg.classList.contains('system')) {
    const body = (msg.querySelector('.msg-body') || msg).innerText.trim();
    if (body) {
      if (items.length) items.push(null);
      items.push({ label: t('메시지 글 복사'), run: () => copy(body) });
      if (!sel) items.push({ label: t('이 메시지를 인용해서 쓰기'), run: () => { state.ui.draft = quote(body); changed(); } });
    }
  }

  const holder = target.closest?.('[data-agent]');
  const agent = holder && agentById(holder.getAttribute('data-agent'));
  if (agent) {
    if (items.length) items.push(null);
    if (state.route.view === 'session') items.push({ label: t('{name}에게 지시하기', { name: agent.name }), run: () => { state.ui.mentionTo = agent.id; changed(); } });
    items.push({ label: t('{name} 설정 열기', { name: agent.name }), run: () => { state.ui.editAgent = agent.id; changed(); } });
    if (state.route.view === 'session') items.push({ label: t('{name} 상태 보기', { name: agent.name }), run: () => { state.ui.inspector = agent.id; state.ui.right = true; changed(); } });
  }

  if (items.length) items.push(null);
  items.push({ label: t('새로 고침'), run: () => location.reload() });
  return items;
}

function open(x, y, items) {
  close();
  restore = document.activeElement;
  menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.setAttribute('role', 'menu');
  for (const it of items) {
    if (!it) { const hr = document.createElement('div'); hr.className = 'ctx-sep'; hr.setAttribute('role', 'separator'); menu.append(hr); continue; }
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.textContent = it.label;
    b.addEventListener('click', () => { close(); it.run(); });
    menu.append(b);
  }
  document.body.append(menu);
  // 화면 밖으로 나가지 않게 자리를 잡는다
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  menu.querySelector('button')?.focus({ preventScroll: true });
  addEventListener('pointerdown', onOutside, true);
  addEventListener('keydown', onKey, true);
  addEventListener('scroll', close, true);
  addEventListener('resize', close);
  addEventListener('blur', close);
}

const editable = (el) => !!el?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]');

export function installContextMenu() {
  addEventListener('contextmenu', (e) => {
    if (e.shiftKey || e.defaultPrevented || editable(e.target)) return; // 브라우저 메뉴 그대로(이미 다른 곳에서 처리한 것도 건드리지 않는다)
    if (menu && menu.contains(e.target)) { e.preventDefault(); return; }
    e.preventDefault();
    open(e.clientX, e.clientY, itemsFor(e.target));
  });
}
