import { initializeApp } from 'firebase/app';
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged
} from 'firebase/auth';
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, addDoc, getDocs, query, orderBy, onSnapshot,
  serverTimestamp, where, arrayUnion, arrayRemove
} from 'firebase/firestore';

import { firebaseConfig, MASTER_CODE } from './firebase-config.js';
import {
  ROLES, ROLES_ORDERED, MAX_STAFF,
  CAN_MANAGE_STAFF, CAN_DELETE_REPORTS,
  WARNING_LEVELS, DOCS, TESTS,
  CAN_RESET_PASSWORDS_FROM_LEVEL
} from './data.js';

/* ==================== ИНИЦИАЛИЗАЦИЯ ==================== */
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

/* ==================== СОСТОЯНИЕ ==================== */
let currentUser = null;
let currentProfile = null;
let reportsUnsub = null;
let invitesUnsub = null;
let cachedUsers = [];
let cachedInvites = [];
let staffSort = 'rank'; // 'rank' | 'name' | 'warnings' | 'status'
let cachedResets = [];
let resetsUnsub = null;
const canResetPasswords = p => p && lvl(p.rank) >= CAN_RESET_PASSWORDS_FROM_LEVEL;

/* ==================== ПРАВА ==================== */
const lvl = role => ROLES[role]?.level ?? 0;
const isPolice = p => p && ROLES[p.rank]?.police === true;
const canReview = p => p && lvl(p.rank) >= 9;
const canDelReports = p => p && CAN_DELETE_REPORTS.includes(p.rank);
const canManageStaff = p => p && CAN_MANAGE_STAFF.includes(p.rank);
const isAdmin = p => p && ['Администратор','Старший администратор'].includes(p.rank);

// Кого может менять me (target): только тех, у кого уровень ниже
function canEditUser(me, target) {
  if (!me || !target) return false;
  if (!canManageStaff(me)) return false;
  if (me.uid === target.uid) return false;
  return lvl(me.rank) > lvl(target.rank);
}

// Какие роли может выдавать me
function rolesIAssign(me) {
  if (!me) return [];
  return ROLES_ORDERED.filter(r => lvl(r) < lvl(me.rank));
}

/* ==================== УТИЛИТЫ ==================== */
const TRANSLIT = {
  'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z',
  'и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r',
  'с':'s','т':'t','у':'u','ф':'f','х':'h','ц':'ts','ч':'ch','ш':'sh','щ':'sch',
  'ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',
  'А':'A','Б':'B','В':'V','Г':'G','Д':'D','Е':'E','Ё':'E','Ж':'Zh','З':'Z',
  'И':'I','Й':'Y','К':'K','Л':'L','М':'M','Н':'N','О':'O','П':'P','Р':'R',
  'С':'S','Т':'T','У':'U','Ф':'F','Х':'H','Ц':'Ts','Ч':'Ch','Ш':'Sh','Щ':'Sch',
  'Ъ':'','Ы':'Y','Ь':'','Э':'E','Ю':'Yu','Я':'Ya'
};
function translit(str) {
  return str.split('').map(ch => TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : ch).join('');
}
function nickToEmail(nick) {
  const lat = translit(nick).toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,'').slice(0,40);
  return lat + '@ppd.local';
}
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
  ));
}
function fmtDate(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
}
function translateErr(code) {
  const map = {
    'auth/email-already-in-use':'Этот ник уже занят',
    'auth/invalid-credential':'Неверный ник или пароль',
    'auth/wrong-password':'Неверный пароль',
    'auth/user-not-found':'Такого пользователя нет',
    'auth/weak-password':'Пароль слишком простой',
    'auth/invalid-email':'Ник содержит недопустимые символы',
    'auth/network-request-failed':'Нет соединения с интернетом',
    'auth/too-many-requests':'Слишком много попыток, подожди'
  };
  return map[code] || ('Ошибка: ' + code);
}
function toast(msg, type='ok') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}
/* ==================== МОДАЛЬНОЕ ОКНО ==================== */
function openModal(html, onMount) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal">${html}</div>`;
  document.body.appendChild(overlay);

  const close = () => {
    overlay.style.transition = 'opacity .15s';
    overlay.style.opacity = '0';
    setTimeout(() => overlay.remove(), 150);
  };
  overlay.addEventListener('click', e => {
    if (e.target === overlay) close();
  });

  if (onMount) onMount(overlay, close);
  return close;
}
function hidePreloader(statusText) {
  const el = document.getElementById('preloader');
  if (!el) return;
  const st = document.getElementById('preloaderStatus');
  if (st && statusText) st.textContent = statusText;
  setTimeout(() => {
    el.classList.add('fade-out');
    setTimeout(() => el.remove(), 500);
  }, 300);
}
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = 'PPD-';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}

/* ==================== АВТОРИЗАЦИЯ ==================== */
async function doRegister() {
  const nick = document.getElementById('reg-nick').value.trim();
  const pass = document.getElementById('reg-pass').value;
  const code = document.getElementById('reg-code').value.trim().toUpperCase();
  const err = document.getElementById('regError');
  err.textContent = '';

  if (nick.length < 3) return err.textContent = 'Имя минимум 3 символа';
  if (!/^[А-Яа-яЁёA-Za-z0-9_\s-]+$/.test(nick)) {
    return err.textContent = 'Можно использовать буквы, цифры, пробел, _ и -';
  }
  if (pass.length < 6) return err.textContent = 'Пароль минимум 6 символов';

  const emailLocal = translit(nick).toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,'');
  if (emailLocal.length < 3) return err.textContent = 'Имя содержит недопустимые символы';

  try {
    const cred = await createUserWithEmailAndPassword(auth, nickToEmail(nick), pass);

    // Определяем роль
    let assignedRole = 'Гражданский';
    let inviteUsedId = null;

    if (code === MASTER_CODE) {
      assignedRole = 'Старший администратор';
    } else if (code) {
      // Ищем в приглашениях
      const invSnap = await getDocs(query(collection(db,'invites'), where('code','==',code)));
      if (!invSnap.empty) {
        const invDoc = invSnap.docs[0];
        const inv = invDoc.data();
        if (inv.usedBy) {
          await signOut(auth);
          return err.textContent = 'Этот код уже использован';
        }
        assignedRole = inv.role;
        inviteUsedId = invDoc.id;
      } else {
        await signOut(auth);
        return err.textContent = 'Неверный код приглашения';
      }
    }

    // Проверка лимита только для полицейских
    const all = await getDocs(collection(db,'users'));
    if (assignedRole !== 'Гражданский' && all.size >= MAX_STAFF + 10) {
      await signOut(auth);
      return err.textContent = 'Достигнут лимит сотрудников';
    }

    await setDoc(doc(db,'users',cred.user.uid), {
      nickname: nick,
      rank: assignedRole,
      status: 'active',
      warnings: [],
      createdAt: serverTimestamp()
    });

    // Помечаем код использованным
    if (inviteUsedId) {
      await updateDoc(doc(db,'invites',inviteUsedId), {
        usedBy: cred.user.uid,
        usedByNick: nick,
        usedAt: serverTimestamp()
      });
    }
  } catch (e) {
    console.error(e);
    err.textContent = translateErr(e.code || e.message);
  }
}

async function doLogin() {
  const nick = document.getElementById('login-nick').value.trim();
  const pass = document.getElementById('login-pass').value;
  const err = document.getElementById('loginError');
  err.textContent = '';
  if (!nick || !pass) return err.textContent = 'Заполни все поля';
  try {
    await signInWithEmailAndPassword(auth, nickToEmail(nick), pass);
  } catch (e) {
    err.textContent = translateErr(e.code || e.message);
  }
}

async function doLogout() {
  if (reportsUnsub) { reportsUnsub(); reportsUnsub = null; }
  if (invitesUnsub) { invitesUnsub(); invitesUnsub = null; }
  await signOut(auth);
}

async function loadProfile(uid) {
  const snap = await getDoc(doc(db,'users',uid));
  return snap.exists() ? { uid, ...snap.data() } : null;
}

/* ==================== РЕАЛТАЙМ ==================== */
function subscribeUsers() {
  onSnapshot(collection(db,'users'), snap => {
    cachedUsers = [];
    snap.forEach(d => cachedUsers.push({ uid: d.id, ...d.data() }));
    cachedUsers.sort((a,b) => lvl(b.rank) - lvl(a.rank));
    if (['#/staff','#/reports'].includes(location.hash)) render();
  });
}
function subscribeInvites() {
  if (invitesUnsub) invitesUnsub();
  invitesUnsub = onSnapshot(collection(db,'invites'), snap => {
    cachedInvites = [];
    snap.forEach(d => cachedInvites.push({ id: d.id, ...d.data() }));
    cachedInvites.sort((a,b) => (b.createdAt?.seconds||0) - (a.createdAt?.seconds||0));
    if (location.hash === '#/invites') render();
  });
}

/* ==================== ОТЧЁТЫ ==================== */
async function submitReport() {
  const type = document.getElementById('r-type').value;
  const partnerUid = document.getElementById('r-partner')?.value || '';
  const desc = document.getElementById('r-desc').value.trim();
  const proof = document.getElementById('r-proof').value.trim();

  if (!desc) return toast('Заполни описание','err');

  let partnerNick = '', partnerRank = '';
  if (partnerUid) {
    const p = cachedUsers.find(u => u.uid === partnerUid);
    if (p) { partnerNick = p.nickname; partnerRank = p.rank; }
  }

  await addDoc(collection(db,'reports'), {
    authorUid: currentUser.uid,
    authorNick: currentProfile.nickname,
    authorRank: currentProfile.rank,
    partnerUid: partnerUid || null,
    partnerNick, partnerRank,
    type, description: desc, proof,
    status: 'pending',
    reviewComment: '',
    reviewedBy: null,
    reviewedAt: null,
    createdAt: serverTimestamp()
  });
  toast('Отчёт отправлен');
  document.getElementById('r-desc').value = '';
  document.getElementById('r-proof').value = '';
}

async function reviewReport(id, status) {
  const comment = prompt(
    status === 'accepted' ? 'Комментарий к принятию (необязательно):' : 'Причина отклонения (необязательно):',
    ''
  );
  if (comment === null) return; // отменил
  await updateDoc(doc(db,'reports',id), {
    status,
    reviewComment: comment.trim(),
    reviewedBy: currentProfile.nickname,
    reviewedAt: serverTimestamp()
  });
  toast(status === 'accepted' ? 'Отчёт принят' : 'Отчёт отклонён');
}

async function deleteReport(id) {
  if (!confirm('Удалить отчёт?')) return;
  await deleteDoc(doc(db,'reports',id));
  toast('Отчёт удалён');
}

/* ==================== КАДРЫ ==================== */
async function saveUserRole(uid, newRole) {
  const target = cachedUsers.find(u => u.uid === uid);
  if (!target) return;
  if (lvl(newRole) >= lvl(currentProfile.rank) && !isAdmin(currentProfile)) {
    return toast('Нельзя выдать роль выше или равную своей','err');
  }
  await updateDoc(doc(db,'users',uid), { rank: newRole });
  toast('Роль обновлена');
}
async function fireUser(uid) {
  if (!confirm('Уволить сотрудника?')) return;
  await updateDoc(doc(db,'users',uid), { status: 'fired' });
  toast('Уволен');
}
async function restoreUser(uid) {
  await updateDoc(doc(db,'users',uid), { status: 'active' });
  toast('Восстановлен');
}
async function deleteUser(uid) {
  if (!confirm('Удалить профиль? (аккаунт Firebase останется, но не сможет войти)')) return;
  await deleteDoc(doc(db,'users',uid));
  toast('Профиль удалён');
}

/* ==================== ВЫГОВОРЫ ==================== */
async function addWarning(uid) {
  const target = cachedUsers.find(u => u.uid === uid);
  if (!target) return;

  if (target.rank === 'Гражданский') {
    return toast('Нельзя выдать выговор гражданскому','err');
  }

  let severity = 'light';

  openModal(`
    <h3>⚠️ Вынести выговор</h3>
    <p class="modal-sub">Сотрудник: <strong style="color:var(--accent)">${escapeHtml(target.nickname)}</strong> · ${escapeHtml(target.rank)}</p>

    <div class="form-group">
      <label>Тяжесть выговора</label>
      <div class="severity-picker">
        <button type="button" class="sev-btn active" data-sev="light">Лёгкий</button>
        <button type="button" class="sev-btn" data-sev="medium">Средний</button>
        <button type="button" class="sev-btn" data-sev="heavy">Тяжёлый</button>
      </div>
    </div>

    <div class="form-group">
      <label>Причина</label>
      <textarea id="warn-reason" placeholder="Опиши причину выговора..." style="min-height:90px"></textarea>
    </div>

    <div class="modal-actions">
      <button class="btn secondary" data-cancel>Отмена</button>
      <button class="btn danger" data-confirm>Вынести выговор</button>
    </div>
  `, (overlay, close) => {
    overlay.querySelectorAll('.sev-btn').forEach(btn => {
      btn.onclick = () => {
        overlay.querySelectorAll('.sev-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        severity = btn.dataset.sev;
      };
    });

    overlay.querySelector('[data-cancel]').onclick = close;

    overlay.querySelector('[data-confirm]').onclick = async () => {
      const reason = overlay.querySelector('#warn-reason').value.trim();
      if (!reason) { toast('Укажи причину','err'); return; }

      const warn = {
        id: Date.now().toString(),
        severity,
        reason,
        from: currentProfile.nickname,
        date: new Date().toISOString()
      };
      await updateDoc(doc(db,'users',uid), { warnings: arrayUnion(warn) });
      close();
      toast('Выговор вынесен');
    };
  });
}

async function removeWarning(uid, warnId) {
  const u = cachedUsers.find(x => x.uid === uid);
  if (!u) return;

  if (u.rank === 'Гражданский') {
    return toast('Гражданским выговоры недоступны','err');
  }

  const warn = (u.warnings || []).find(w => w.id === warnId);
  if (!warn) return toast('Выговор не найден','err');

  openModal(`
    <h3>Снять выговор?</h3>
    <p class="modal-sub">
      Сотрудник: <strong style="color:var(--accent)">${escapeHtml(u.nickname)}</strong><br>
      Выговор: <strong>${WARNING_LEVELS[warn.severity]?.label || warn.severity}</strong><br>
      Причина: ${escapeHtml(warn.reason)}<br>
      Выдал: ${escapeHtml(warn.from)} · ${fmtDate(warn.date)}
    </p>
    <div class="modal-actions">
      <button class="btn secondary" data-cancel>Отмена</button>
      <button class="btn" data-confirm>Снять</button>
    </div>
  `, (overlay, close) => {
    overlay.querySelector('[data-cancel]').onclick = close;
    overlay.querySelector('[data-confirm]').onclick = async () => {
      const newWarnings = (u.warnings || []).filter(w => w.id !== warnId);
      await updateDoc(doc(db,'users',uid), { warnings: newWarnings });
      close();
      toast('Выговор снят');
    };
  });
}
/* ==================== СБРОС ПАРОЛЕЙ ==================== */
function subscribeResets() {
  if (resetsUnsub) resetsUnsub();
  resetsUnsub = onSnapshot(collection(db,'passwordResets'), snap => {
    cachedResets = [];
    snap.forEach(d => cachedResets.push({ id: d.id, ...d.data() }));
    cachedResets.sort((a,b) => (b.createdAt?.seconds||0) - (a.createdAt?.seconds||0));
    if (location.hash === '#/passwords') render();
  });
}

function requestPasswordReset(uid) {
  const target = cachedUsers.find(u => u.uid === uid);
  if (!target) return;

  openModal(`
    <h3>🔑 Сброс пароля</h3>
    <p class="modal-sub">
      Сотрудник: <strong style="color:var(--accent)">${escapeHtml(target.nickname)}</strong> · ${escapeHtml(target.rank)}
    </p>
    <div class="form-group">
      <label>Причина сброса (обязательно)</label>
      <textarea id="reset-reason" placeholder="Например: сотрудник забыл пароль, обратился в дискорд..." style="min-height:100px"></textarea>
    </div>
    <div class="modal-actions">
      <button class="btn secondary" data-cancel>Отмена</button>
      <button class="btn" data-confirm>Создать запрос</button>
    </div>
  `, (overlay, close) => {
    overlay.querySelector('[data-cancel]').onclick = close;
    overlay.querySelector('[data-confirm]').onclick = async () => {
      const reason = overlay.querySelector('#reset-reason').value.trim();
      if (!reason) return toast('Укажи причину','err');

      await addDoc(collection(db,'passwordResets'), {
        targetUid: target.uid,
        targetNick: target.nickname,
        targetRank: target.rank,
        requestedBy: currentUser.uid,
        requestedByNick: currentProfile.nickname,
        reason,
        status: 'pending',
        createdAt: serverTimestamp(),
        resolvedBy: null,
        resolvedAt: null
      });
      close();
      toast('Запрос создан');
    };
  });
}

async function markResetDone(id) {
  await updateDoc(doc(db,'passwordResets',id), {
    status: 'done',
    resolvedBy: currentProfile.nickname,
    resolvedAt: serverTimestamp()
  });
  toast('Отмечено как выполнено');
}

async function deleteReset(id) {
  if (!confirm('Удалить запрос из журнала?')) return;
  await deleteDoc(doc(db,'passwordResets',id));
  toast('Удалено');
}
/* ==================== ПРИГЛАШЕНИЯ ==================== */
async function createInvite() {
  const role = prompt('Какую роль выдаст код? (например: Рядовой, SWAT, Гражданский)', 'Рядовой');
  if (!role || !ROLES[role]) return toast('Неверная роль','err');
  if (lvl(role) >= lvl(currentProfile.rank) && !isAdmin(currentProfile)) {
    return toast('Нельзя создать код на роль выше или равную своей','err');
  }
  const code = genCode();
  await addDoc(collection(db,'invites'), {
    code, role,
    createdBy: currentUser.uid,
    createdByNick: currentProfile.nickname,
    createdAt: serverTimestamp(),
    usedBy: null, usedByNick: null, usedAt: null
  });
  toast('Код создан: ' + code);
}
async function deleteInvite(id) {
  if (!confirm('Удалить код?')) return;
  await deleteDoc(doc(db,'invites',id));
  toast('Код удалён');
}

/* ==================== НАВИГАЦИЯ ==================== */
function buildNav() {
  const nav = document.getElementById('nav');
  const groups = {};
  DOCS.forEach(d => { (groups[d.category] ||= []).push(d); });

  let html = `<div class="nav-group">
    <div class="nav-group-title">Навигация</div>
    <a class="nav-link" data-route="#/home">🏠 Главная</a>
  </div>`;

  for (const [cat, items] of Object.entries(groups)) {
    html += `<div class="nav-group"><div class="nav-group-title">${cat}</div>`;
    items.forEach(d => {
      html += `<a class="nav-link" data-route="#/doc/${d.id}">📄 ${d.title}</a>`;
    });
    html += `</div>`;
  }

  // Рабочие разделы — только для полиции
  if (isPolice(currentProfile)) {
    html += `<div class="nav-group">
      <div class="nav-group-title">Работа</div>
      <a class="nav-link" data-route="#/reports">📝 Отчёты</a>
      <a class="nav-link" data-route="#/tests">🎓 Тесты</a>
      <a class="nav-link" data-route="#/staff">👮 Кадры</a>`;
        if (canManageStaff(currentProfile)) {
      html += `<a class="nav-link" data-route="#/invites">🔑 Приглашения</a>`;
    }
    if (canResetPasswords(currentProfile)) {
      html += `<a class="nav-link" data-route="#/passwords">🔐 Сброс паролей</a>`;
    }
    html += `</div>`;
  }

  // Раздел для начальства не-полиции (губернатор, админы)
  if (!isPolice(currentProfile) && (canReview(currentProfile) || canManageStaff(currentProfile))) {
    html += `<div class="nav-group">
      <div class="nav-group-title">Работа</div>
      <a class="nav-link" data-route="#/reports">📝 Отчёты</a>
      <a class="nav-link" data-route="#/staff">👮 Кадры</a>`;
    if (canManageStaff(currentProfile)) {
      html += `<a class="nav-link" data-route="#/invites">🔑 Приглашения</a>`;
    }
    html += `</div>`;
  }

  nav.innerHTML = html;
  nav.querySelectorAll('.nav-link').forEach(l => {
    l.onclick = () => { location.hash = l.dataset.route; };
  });
}

/* ==================== ОТРИСОВКА ==================== */
function renderHome() {
  const warnings = currentProfile.warnings || [];
  return `
    <h2>Добро пожаловать, ${escapeHtml(currentProfile.nickname)}</h2>
    <p class="doc-meta">Твоя роль: <strong style="color:var(--accent)">${escapeHtml(currentProfile.rank)}</strong></p>

    ${warnings.length ? `
      <div class="warnings-box">
        <h3 style="color:var(--danger);margin-bottom:10px">⚠️ Выговоры (${warnings.length})</h3>
        ${warnings.map(w => `
          <div class="warning-item" style="border-left-color:${WARNING_LEVELS[w.severity]?.color || '#888'}">
            <div><strong>${WARNING_LEVELS[w.severity]?.label || w.severity}</strong> · от ${escapeHtml(w.from)} · ${fmtDate(w.date)}</div>
            <div style="color:var(--muted);margin-top:4px">${escapeHtml(w.reason)}</div>
          </div>
        `).join('')}
      </div>
    ` : ''}

    <div class="cards">
      <div class="card" onclick="location.hash='#/doc/ustav'">
        <h4>📕 Устав</h4><p>Права и обязанности сотрудников.</p></div>
      <div class="card" onclick="location.hash='#/doc/uk'">
        <h4>⚖️ Уголовный Кодекс</h4><p>Преступления и наказания.</p></div>
      ${isPolice(currentProfile) ? `
        <div class="card" onclick="location.hash='#/reports'">
          <h4>📝 Отчёты</h4><p>Сдать рапорт или просмотреть общие.</p></div>
        <div class="card" onclick="location.hash='#/tests'">
          <h4>🎓 Тесты</h4><p>Проверь знание устава.</p></div>
      ` : ''}
    </div>
  `;
}

function renderDoc(id) {
  const d = DOCS.find(x => x.id === id);
  if (!d) return `<h2>Документ не найден</h2>`;
  return `<h2>${d.title}</h2>
    <div class="doc-meta">Раздел: ${d.category}</div>
    <div class="doc-body">${escapeHtml(d.content)}</div>`;
}

function renderReports() {
  if (!isPolice(currentProfile) && !canReview(currentProfile)) {
    return `<h2>Доступ запрещён</h2>`;
  }

  const canSubmit = isPolice(currentProfile);
  const form = canSubmit ? `
    <div class="form-group"><label>Тип отчёта</label>
      <select id="r-type">
        <option>Патруль</option><option>Рейд / Обыск</option>
        <option>Расследование</option><option>Задержание</option><option>Другое</option>
      </select></div>
    <div class="form-group"><label>С кем был патруль</label>
      <select id="r-partner"><option value="">— Один / не указано —</option></select></div>
    <div class="form-group"><label>Описание</label>
      <textarea id="r-desc" placeholder="Что произошло..."></textarea></div>
    <div class="form-group"><label>Доказательства (ссылка)</label>
      <input id="r-proof" type="text" placeholder="https://..."></div>
    <button class="btn" id="btnSubmitReport">Отправить отчёт</button>
  ` : '';

  setTimeout(() => {
    document.getElementById('btnSubmitReport')?.addEventListener('click', submitReport);
    const pSel = document.getElementById('r-partner');
    if (pSel) {
      const opts = ['<option value="">— Один / не указано —</option>'];
      cachedUsers.forEach(u => {
        if (u.status !== 'active') return;
        if (u.uid === currentUser.uid) return;
        if (!isPolice(u)) return;
        opts.push(`<option value="${u.uid}">${escapeHtml(u.nickname)} — ${escapeHtml(u.rank)}</option>`);
      });
      pSel.innerHTML = opts.join('');
    }
  }, 0);

  if (reportsUnsub) reportsUnsub();
  const q = query(collection(db,'reports'), orderBy('createdAt','desc'));
  reportsUnsub = onSnapshot(q, snap => {
    const reports = [];
    snap.forEach(d => reports.push({ id: d.id, ...d.data() }));
    const box = document.getElementById('reportsList');
    if (!box) return;

    const visible = reports.filter(r =>
      canReview(currentProfile) || r.authorUid === currentUser.uid
    );

    if (visible.length === 0) {
      box.innerHTML = '<p class="doc-meta">Отчётов пока нет.</p>';
      return;
    }

    box.innerHTML = `<h3 style="color:var(--accent);margin-bottom:14px">Список отчётов (${visible.length})</h3>` +
      visible.map(r => {
        const cls = 'report-card status-' + r.status;
        const canDel = canDelReports(currentProfile);
        const canRev = canReview(currentProfile);
        const actions = (canRev || canDel) ? `
          <div class="report-actions">
            ${canRev && r.status !== 'accepted' ? `<button class="btn" data-act="accepted" data-id="${r.id}">✓ Принять</button>` : ''}
            ${canRev && r.status !== 'rejected' ? `<button class="btn danger" data-act="rejected" data-id="${r.id}">✗ Отклонить</button>` : ''}
            ${canDel ? `<button class="btn secondary" data-act="del" data-id="${r.id}">🗑 Удалить</button>` : ''}
          </div>` : '';

        return `<div class="${cls}">
          <div class="report-head">
            <div class="report-author">${escapeHtml(r.authorNick)}<span class="rank">${escapeHtml(r.authorRank)}</span></div>
            <div class="report-date">${fmtDate(r.createdAt)}</div>
          </div>
          <div class="report-type">${escapeHtml(r.type)} · ${statusLabel(r.status)}</div>
          ${r.partnerNick ? `<div class="report-type" style="background:#1a2338;color:var(--accent)">👥 С кем: ${escapeHtml(r.partnerNick)} — ${escapeHtml(r.partnerRank || '')}</div>` : ''}
          <div class="report-desc">${escapeHtml(r.description)}</div>
          ${r.proof ? `<div class="report-proof">📎 <a href="${escapeHtml(r.proof)}" target="_blank" rel="noopener">Доказательства</a></div>` : ''}
          ${r.reviewComment ? `<div class="report-comment">💬 <strong>${escapeHtml(r.reviewedBy || '')}:</strong> ${escapeHtml(r.reviewComment)}</div>` : ''}
          ${actions}
        </div>`;
      }).join('');

    box.querySelectorAll('[data-act]').forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.id, act = btn.dataset.act;
        if (act === 'del') deleteReport(id);
        else reviewReport(id, act);
      };
    });
  });

  return `<h2>Отчёты сотрудников</h2>
    <p class="doc-meta">${canReview(currentProfile) ? 'Ты видишь все отчёты и можешь их проверять' : 'Ты видишь только свои отчёты'}</p>
    ${canSubmit ? `<h3 style="color:var(--accent);margin:20px 0 12px">Подать новый</h3>${form}` : ''}
    <div id="reportsList" style="margin-top:24px"><p class="doc-meta">Загрузка...</p></div>`;
}
function statusLabel(s) {
  return {pending:'На рассмотрении',accepted:'Принят',rejected:'Отклонён'}[s] || s;
}

function renderStaff() {
  if (!isPolice(currentProfile) && !canManageStaff(currentProfile)) {
    return `<h2>Доступ запрещён</h2>`;
  }
  const active = cachedUsers.filter(u => u.status === 'active').length;
  const fired  = cachedUsers.filter(u => u.status === 'fired').length;
  const iCanManage = canManageStaff(currentProfile);
  const myRoles = rolesIAssign(currentProfile);

  // Сортируем по выбранному критерию
  const sorted = [...cachedUsers].sort((a, b) => {
    if (staffSort === 'name') {
      return a.nickname.localeCompare(b.nickname, 'ru');
    }
    if (staffSort === 'warnings') {
      return (b.warnings?.length || 0) - (a.warnings?.length || 0);
    }
    if (staffSort === 'status') {
      // активные сверху, уволенные снизу
      if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
      return lvl(b.rank) - lvl(a.rank);
    }
    // по умолчанию — по роли (от старших к младшим)
    return lvl(b.rank) - lvl(a.rank);
  });

  const html = `
    <h2>Кадровый состав</h2>
    <p class="doc-meta">${iCanManage ? 'Ты можешь редактировать сотрудников ниже своего уровня' : 'Просмотр'}</p>
    <div class="counter-bar">
      <span>Активных: <strong>${active}</strong> / ${MAX_STAFF}</span>
      <span>Уволено: <strong>${fired}</strong></span>
      <span>Всего: <strong>${cachedUsers.length}</strong></span>
    </div>

    <div class="staff-toolbar">
      <label>Сортировка:</label>
      <select id="staffSort">
        <option value="rank"     ${staffSort==='rank'?'selected':''}>По роли (старшие сверху)</option>
        <option value="name"     ${staffSort==='name'?'selected':''}>По имени (А→Я)</option>
        <option value="warnings" ${staffSort==='warnings'?'selected':''}>По выговорам (больше сверху)</option>
        <option value="status"   ${staffSort==='status'?'selected':''}>По статусу (активные сверху)</option>
      </select>
    </div>

    ${sorted.map(u => {
      const editable = canEditUser(currentProfile, u);
      const warns = u.warnings || [];
      const heavy = warns.filter(w => w.severity === 'heavy').length;
      const roleOptions = ROLES_ORDERED.map(r => {
        const canAssign = myRoles.includes(r);
        const sel = r === u.rank ? 'selected' : '';
        const dis = canAssign ? '' : 'disabled';
        return `<option value="${r}" ${sel} ${dis}>${r}${canAssign ? '' : ' 🔒'}</option>`;
      }).join('');

      return `<div class="staff-row ${u.status === 'fired' ? 'fired' : ''}">
        <div>
          <div class="name">${escapeHtml(u.nickname)} ${heavy ? `<span style="color:var(--danger)">⚠️×${heavy}</span>` : ''}</div>
          <div class="nick">${u.status === 'fired' ? 'УВОЛЕН' : 'активен'} · выговоров: ${warns.length}</div>
        </div>
        ${editable ? `
          <select data-uid="${u.uid}" data-field="rank">${roleOptions}</select>
        ` : `<div class="role-label">${escapeHtml(u.rank)}</div>`}
        <div class="staff-actions">
          ${editable && u.rank !== 'Гражданский' ? `
           <button class="btn secondary" data-warn="${u.uid}">⚠️</button>
           ${canResetPasswords(currentProfile) ? `<button class="btn secondary" data-reset="${u.uid}" title="Сбросить пароль">🔑</button>` : ''}
            ${u.status === 'active'
              ? `<button class="btn danger" data-fire="${u.uid}">Уволить</button>`
              : `<button class="btn" data-restore="${u.uid}">Вернуть</button>`}
            ${isAdmin(currentProfile) ? `<button class="btn secondary" data-del="${u.uid}">🗑</button>` : ''}
          ` : ''}
        </div>
      </div>
      ${warns.length ? `<div style="padding:0 14px 10px 26px">
        ${warns.map(w => `<div class="warning-item small" style="border-left-color:${WARNING_LEVELS[w.severity]?.color}">
          <span><strong>${WARNING_LEVELS[w.severity]?.label}</strong> · ${escapeHtml(w.reason)} · от ${escapeHtml(w.from)} · ${fmtDate(w.date)}</span>
          ${editable ? `<button class="btn tiny secondary" data-rmwarn="${u.uid}:${w.id}">×</button>` : ''}
        </div>`).join('')}
      </div>` : ''}
    `;
    }).join('')}
  `;

    setTimeout(() => {
    // Сортировка
    const sortSel = document.getElementById('staffSort');
    if (sortSel) {
      sortSel.onchange = () => {
        staffSort = sortSel.value;
        render();
      };
    }

    document.querySelectorAll('.staff-row select').forEach(sel => {
      sel.onchange = () => saveUserRole(sel.dataset.uid, sel.value);
    });
    document.querySelectorAll('[data-fire]').forEach(b => b.onclick = () => fireUser(b.dataset.fire));
    document.querySelectorAll('[data-restore]').forEach(b => b.onclick = () => restoreUser(b.dataset.restore));
    document.querySelectorAll('[data-del]').forEach(b => b.onclick = () => deleteUser(b.dataset.del));
    document.querySelectorAll('[data-warn]').forEach(b => b.onclick = () => addWarning(b.dataset.warn));
    document.querySelectorAll('[data-reset]').forEach(b => b.onclick = () => requestPasswordReset(b.dataset.reset));
    document.querySelectorAll('[data-rmwarn]').forEach(b => {
      b.onclick = () => {
        const [uid, wid] = b.dataset.rmwarn.split(':');
        removeWarning(uid, wid);
      };
    });
  }, 0);

  return html;
}

function renderInvites() {
  if (!canManageStaff(currentProfile)) return `<h2>Доступ запрещён</h2>`;
  return `
    <h2>Пригласительные коды</h2>
    <p class="doc-meta">Создавай коды, чтобы новички могли зарегистрироваться сразу с нужной ролью</p>
    <button class="btn" id="btnCreateInvite" style="margin-bottom:20px">+ Создать код</button>
    <div id="invitesList">
      ${cachedInvites.length === 0
        ? '<p class="doc-meta">Кодов пока нет.</p>'
        : cachedInvites.map(i => `
          <div class="invite-row ${i.usedBy ? 'used' : ''}">
            <div>
              <div class="invite-code">${escapeHtml(i.code)}</div>
              <div class="invite-meta">Роль: <strong>${escapeHtml(i.role)}</strong> · от ${escapeHtml(i.createdByNick)}</div>
              ${i.usedBy ? `<div class="invite-meta" style="color:var(--muted)">Использован: ${escapeHtml(i.usedByNick)} · ${fmtDate(i.usedAt)}</div>` : ''}
            </div>
            <button class="btn danger" data-delinv="${i.id}">🗑</button>
          </div>
        `).join('')}
    </div>
  `;
}
document.addEventListener('click', e => {
  if (e.target.id === 'btnCreateInvite') createInvite();
  if (e.target.dataset?.delinv) deleteInvite(e.target.dataset.delinv);
});

function renderResets() {
  if (!canResetPasswords(currentProfile)) return `<h2>Доступ запрещён</h2>`;

  const pending = cachedResets.filter(r => r.status === 'pending');
  const done    = cachedResets.filter(r => r.status === 'done');

  const renderCard = r => `
    <div class="reset-row ${r.status === 'done' ? 'done' : ''}">
      <div class="reset-info">
        <div class="reset-target">${escapeHtml(r.targetNick)} <span style="color:var(--accent)">· ${escapeHtml(r.targetRank)}</span></div>
        <div class="reset-meta">
          Запросил: <strong>${escapeHtml(r.requestedByNick)}</strong> · ${fmtDate(r.createdAt)}
        </div>
        <div class="reset-reason">💬 ${escapeHtml(r.reason)}</div>
        ${r.status === 'done'
          ? `<div class="reset-meta" style="color:var(--ok)">✓ Выполнил: ${escapeHtml(r.resolvedBy)} · ${fmtDate(r.resolvedAt)}</div>`
          : ''}
      </div>
      <div class="reset-actions">
        ${r.status === 'pending'
          ? `<button class="btn" data-done="${r.id}">✓ Выполнено</button>`
          : ''}
        <button class="btn secondary" data-delreset="${r.id}">🗑</button>
      </div>
    </div>
  `;

  const html = `
    <h2>🔐 Запросы на сброс паролей</h2>
    <p class="doc-meta">
      Здесь собираются запросы от начальства. После того как сменишь пароль в Firebase Console,
      нажми «Выполнено» — запрос уйдёт в журнал.
    </p>

    <div class="counter-bar">
      <span>Ожидают: <strong style="color:var(--accent)">${pending.length}</strong></span>
      <span>Выполнено: <strong style="color:var(--ok)">${done.length}</strong></span>
    </div>

    <h3 style="color:var(--accent);margin:20px 0 12px">⏳ Ожидают (${pending.length})</h3>
    ${pending.length === 0
      ? '<p class="doc-meta">Нет активных запросов.</p>'
      : pending.map(renderCard).join('')}

    <h3 style="color:var(--muted);margin:28px 0 12px">✓ Журнал (${done.length})</h3>
    ${done.length === 0
      ? '<p class="doc-meta">Пока пусто.</p>'
      : done.map(renderCard).join('')}
  `;

  setTimeout(() => {
    document.querySelectorAll('[data-done]').forEach(b => b.onclick = () => markResetDone(b.dataset.done));
    document.querySelectorAll('[data-delreset]').forEach(b => b.onclick = () => deleteReset(b.dataset.delreset));
  }, 0);

  return html;
}
/* ==================== ТЕСТЫ ==================== */
function renderTests() {
  return `<h2>Тесты</h2>
    <p class="doc-meta">Проверь свои знания</p>
    <div class="cards">${TESTS.map(t => `
      <div class="card" onclick="location.hash='#/test/${t.id}'">
        <h4>${t.title}</h4>
        <p>Вопросов: ${t.questions.length} · Проходной: ${t.passScore}%</p>
      </div>`).join('')}</div>`;
}
function renderTest(id) {
  const test = TESTS.find(t => t.id === id);
  if (!test) return `<h2>Тест не найден</h2>`;
  const html = `<h2>${test.title}</h2>
    <p class="doc-meta">Проходной балл: ${test.passScore}%</p>
    <form id="testForm">${test.questions.map((q,qi) => `
      <div class="question"><p>${qi+1}. ${escapeHtml(q.q)}</p>
        ${q.options.map((o,oi) => `
          <label class="option"><input type="radio" name="q${qi}" value="${oi}"> ${escapeHtml(o)}</label>
        `).join('')}
      </div>`).join('')}
      <button type="button" class="btn" id="btnCheckTest">Завершить тест</button>
    </form><div id="testResult"></div>`;
  setTimeout(() => {
    document.getElementById('btnCheckTest').onclick = () => {
      let correct = 0;
      test.questions.forEach((q,qi) => {
        const sel = document.querySelector(`input[name="q${qi}"]:checked`);
        if (sel && Number(sel.value) === q.correct) correct++;
      });
      const pct = Math.round(correct / test.questions.length * 100);
      const pass = pct >= test.passScore;
      document.getElementById('testResult').innerHTML = `
        <div class="result ${pass ? 'pass' : 'fail'}">
          ${pass ? '✅ ТЕСТ ПРОЙДЕН' : '❌ НЕ ПРОЙДЕН'}<br>
          ${correct}/${test.questions.length} (${pct}%)
        </div>`;
    };
  }, 0);
  return html;
}

/* ==================== ПОИСК ==================== */
function globalSearch(query) {
  const q = query.trim().toLowerCase();
  if (!q) { render(); return; }
  const results = DOCS.filter(d =>
    d.title.toLowerCase().includes(q) || d.content.toLowerCase().includes(q));

  document.getElementById('content').innerHTML = `
    <h2>Результаты поиска</h2>
    <p class="doc-meta">Найдено: ${results.length} по «${escapeHtml(query)}»</p>
    ${results.length === 0 ? '<p class="doc-meta">Ничего не найдено.</p>' :
      results.map(d => {
        const idx = d.content.toLowerCase().indexOf(q);
        const snip = idx >= 0
          ? '…' + d.content.slice(Math.max(0,idx-40), idx+120) + '…'
          : d.content.slice(0,120) + '…';
        return `<div class="search-result" onclick="location.hash='#/doc/${d.id}'">
          <h4>${d.title}</h4><p>${escapeHtml(snip)}</p></div>`;
      }).join('')}
  `;
}

/* ==================== РОУТЕР ==================== */
function render() {
  if (!currentProfile) return;
  const hash = location.hash || '#/home';
  const content = document.getElementById('content');

  document.querySelectorAll('.nav-link').forEach(l =>
    l.classList.toggle('active', l.dataset.route === hash));

  if (hash === '#/home')           content.innerHTML = renderHome();
  else if (hash.startsWith('#/doc/'))   content.innerHTML = renderDoc(hash.slice(6));
  else if (hash === '#/reports')   content.innerHTML = renderReports();
  else if (hash === '#/tests')     content.innerHTML = renderTests();
  else if (hash.startsWith('#/test/'))  content.innerHTML = renderTest(hash.slice(7));
  else if (hash === '#/staff')     content.innerHTML = renderStaff();
  else if (hash === '#/invites')   content.innerHTML = renderInvites();
  else if (hash === '#/passwords') content.innerHTML = renderResets();
  else content.innerHTML = `<h2>Страница не найдена</h2>`;

  window.scrollTo({top:0,behavior:'smooth'});
}

/* ==================== СТАРТ ==================== */
document.getElementById('year').textContent = new Date().getFullYear();

document.getElementById('tabLogin').onclick = () => {
  document.getElementById('tabLogin').classList.add('active');
  document.getElementById('tabRegister').classList.remove('active');
  document.getElementById('loginForm').classList.remove('hidden');
  document.getElementById('registerForm').classList.add('hidden');
};
document.getElementById('tabRegister').onclick = () => {
  document.getElementById('tabRegister').classList.add('active');
  document.getElementById('tabLogin').classList.remove('active');
  document.getElementById('registerForm').classList.remove('hidden');
  document.getElementById('loginForm').classList.add('hidden');
};
document.getElementById('btnLogin').onclick = doLogin;
document.getElementById('btnRegister').onclick = doRegister;
document.getElementById('btnLogout').onclick = doLogout;
document.getElementById('login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('reg-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doRegister(); });
document.getElementById('globalSearch').addEventListener('input', e => globalSearch(e.target.value));
window.addEventListener('hashchange', render);

onAuthStateChanged(auth, async user => {
  if (user) {
    currentUser = user;
    let profile = await loadProfile(user.uid);
    if (!profile) {
      await new Promise(r => setTimeout(r, 800));
      profile = await loadProfile(user.uid);
    }
    if (!profile) { await signOut(auth); return; }
    if (profile.status === 'fired') {
      alert('Вы уволены из фракции.');
      await signOut(auth);
      return;
    }
    currentProfile = profile;

    document.getElementById('authScreen').classList.add('hidden');
    document.getElementById('appScreen').classList.remove('hidden');
    document.getElementById('userNick').textContent = profile.nickname;
    document.getElementById('userRank').textContent = profile.rank;

    buildNav();
    subscribeUsers();
    if (canManageStaff(profile)) subscribeInvites();
    if (canResetPasswords(profile)) subscribeResets();
    render();
    hidePreloader('Добро пожаловать');
  } else {
    currentUser = null; currentProfile = null;
    if (reportsUnsub) { reportsUnsub(); reportsUnsub = null; }
    if (invitesUnsub) { invitesUnsub(); invitesUnsub = null; }
    if (resetsUnsub) { resetsUnsub(); resetsUnsub = null; }
    document.getElementById('authScreen').classList.remove('hidden');
    document.getElementById('appScreen').classList.add('hidden');

    hidePreloader('Авторизация');
  }
});