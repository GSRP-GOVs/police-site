// Глушим системную ошибку библиотеки web-vitals (startTime)
window.addEventListener('error', function(event) {
  // Проверяем текст ошибки или стек вызовов
  if (
    (event.message && event.message.includes("startTime")) ||
    (event.error && event.error.stack && event.error.stack.includes("reportAllChanges"))
  ) {
    event.preventDefault(); // Отменяем показ в консоли
    event.stopPropagation(); // Останавливаем всплытие
    return true;
  }
}, true); // Флаг true (capture) важен, чтобы поймать ошибку до того, как она попадет в консоль

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

import { firebaseConfig } from './firebase-config.js';
import {
  ROLES, ROLES_ORDERED,
  CAN_MANAGE_STAFF, CAN_DELETE_REPORTS,
  WARNING_LEVELS, DOCS, TESTS,
  CAN_RESET_PASSWORDS_FROM_LEVEL,
  LAWS, DETENTION_MAX_PRISON_MINUTES, DETENTION_EDIT_HOURS,
  CAN_RELEASE_EARLY, CAN_EDIT_ANY_DETENTION,
  STATUS_LABELS,
  AWARD_TYPES, CAN_GIVE_AWARDS,
  CAN_CREATE_ANNOUNCEMENTS_FROM_LEVEL, CAN_PIN_ANNOUNCEMENTS_FROM_LEVEL,
  REPORT_TAGS,
  CAN_PIN_REPORTS_FROM_LEVEL, CAN_UNPIN_ANY_FROM_LEVEL
} from './data.js';

/* ==================== ИНИЦИАЛИЗАЦИЯ ==================== */
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

/* ==================== СОСТОЯНИЕ ==================== */
let currentUser = null;
let currentProfile = null;
let isRegistering = false; // Защита от гонки при регистрации

// Функция для повторных попыток, если Firestore ещё не получил токен
async function firestoreWithRetry(operation, maxRetries = 10) {
  let lastErr;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (err) {
      if (err.code === 'permission-denied' || err.message?.includes('insufficient permissions')) {
        lastErr = err;
        await new Promise(r => setTimeout(r, 500)); // Ждём 0.5 сек
      } else {
        throw err;
      }
    }
  }
  throw lastErr;
}
let reportsUnsub = null;
let invitesUnsub = null;
let cachedUsers = [];
let cachedInvites = [];
let staffSort = 'rank'; // 'rank' | 'name' | 'warnings' | 'status'
let cachedResets = [];
let resetsUnsub = null;
const canResetPasswords = p => p
  && lvl(p.rank) >= CAN_RESET_PASSWORDS_FROM_LEVEL
  && !['Правительство', 'Администратор', 'РП-Куратор'].includes(p.rank);
let cachedDetentions = [];
let cachedFines = [];
let detentionsUnsub = null;
let finesUnsub = null;
let cachedReports = [];
let reportsGlobalUnsub = null;
let cachedAnnouncements = [];
let announcementsUnsub = null;
let cachedVacations = [];
let vacationsUnsub = null;
let vacFilter = 'pending';   // 'pending' | 'all' | 'active'
let editingAnnouncementId = null;

const canCreateAnnouncements = p => p && lvl(p.rank) >= CAN_CREATE_ANNOUNCEMENTS_FROM_LEVEL;
const canPinAnnouncements    = p => p && lvl(p.rank) >= CAN_PIN_ANNOUNCEMENTS_FROM_LEVEL;
let dashPeriod = 'week';
let dashboardConfig = { lastClearAt: null };
let dashboardConfigUnsub = null;
let selectedArticles = [];   // временное хранилище для формы
let selectedArticlesFine = [];
let lawTypeFilter = { detentions: 'all', fines: 'all' };
// Мультивыбор напарников: { reports: [uid, uid], detentions: [...], fines: [...] }
let selectedPartners = { reports: [], detentions: [], fines: [] };

const canReleaseEarly = p => p && CAN_RELEASE_EARLY.includes(p.rank);
const canEditAnyDetention = p => p && CAN_EDIT_ANY_DETENTION.includes(p.rank);

/* ===== Тесты (Firestore) ===== */
let cachedTests = [];
let cachedTestResults = [];
let testsUnsub = null;
let testResultsUnsub = null;

/* ===== Чек-листы повышения ===== */
let promotionRules = { byRole: {} };
let promotionConfigUnsub = null;

const canEditPromotionRules = p => p
  && ['Генерал полиции','Губернатор','Администратор','Старший администратор','РП-Куратор'].includes(p.rank);

// Дефолтные правила (используются, если в БД ещё ничего не задано)
function defaultPromotionRules() {
  return {
    byRole: {
      'Рядовой':          { toRole: 'Капрал',            minReports: 3,  minDetentions: 0,  minFines: 0,  maxWarnings: 0, requiredTests: [] },
      'Капрал':           { toRole: 'Сержант',           minReports: 5,  minDetentions: 2,  minFines: 3,  maxWarnings: 0, requiredTests: [] },
      'Сержант':          { toRole: 'Старший сержант',   minReports: 8,  minDetentions: 5,  minFines: 5,  maxWarnings: 0, requiredTests: [] },
      'Старший сержант':  { toRole: 'Младший лейтенант', minReports: 12, minDetentions: 8,  minFines: 8,  maxWarnings: 0, requiredTests: [] },
      'SWAT':             { toRole: 'Лейтенант',         minReports: 15, minDetentions: 12, minFines: 10, maxWarnings: 0, requiredTests: [] },
      'Младший лейтенант':{ toRole: 'Лейтенант',         minReports: 15, minDetentions: 10, minFines: 10, maxWarnings: 0, requiredTests: [] },
      'Лейтенант':        { toRole: 'Старший лейтенант', minReports: 18, minDetentions: 15, minFines: 12, maxWarnings: 0, requiredTests: [] },
      'Старший лейтенант':{ toRole: 'Агент ОБН',         minReports: 22, minDetentions: 18, minFines: 15, maxWarnings: 0, requiredTests: [] },
      'Агент ОБН':        { toRole: 'Капитан',           minReports: 25, minDetentions: 20, minFines: 18, maxWarnings: 0, requiredTests: [] },
      'Капитан':          { toRole: 'Майор',             minReports: 30, minDetentions: 25, minFines: 20, maxWarnings: 0, requiredTests: [] },
      'Майор':            { toRole: 'Подполковник',      minReports: 35, minDetentions: 30, minFines: 25, maxWarnings: 0, requiredTests: [] },
      'Подполковник':     { toRole: 'Руководитель ОБН',  minReports: 40, minDetentions: 35, minFines: 30, maxWarnings: 0, requiredTests: [] },
      'Руководитель ОБН': { toRole: 'Полковник',         minReports: 45, minDetentions: 40, minFines: 35, maxWarnings: 0, requiredTests: [] },
      'Полковник':        { toRole: 'Генерал полиции',   minReports: 50, minDetentions: 50, minFines: 40, maxWarnings: 0, requiredTests: [] }
    }
  };
}

let testHistoryFilters = {
  search: '',
  status: 'all',      // all | pass | fail
  period: 'all'       // all | today | week | month
};
let testHistorySort = 'date';  // date | score | name

// Роли, которые могут УПРАВЛЯТЬ тестами (создавать, редактировать, удалять)
const TEST_MANAGER_ROLES = [
  'Старший администратор',
  'РП-Куратор'
];

const TEST_SEE_ALL_ROLES = [
  'Старший администратор',
  'РП-Куратор'
];

const canManageTests = p => p && TEST_MANAGER_ROLES.includes(p.rank);

// Полковник+ или явная роль из списка — видят всё
function canSeeAllTests(p) {
  if (!p) return false;
  if (TEST_SEE_ALL_ROLES.includes(p.rank)) return true;
  return lvl(p.rank) >= 13;  // Полковник и выше
}

// Текущее прохождение теста
let currentTestRun = null;

/* ===== Файлы ===== */
let pendingFiles = { reports: [], detentions: [], fines: [], announcements: [], question: [] };
const MAX_FILES = 6;
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 МБ

/* ===== Cloudinary ===== */
const CLOUDINARY_CLOUD_NAME = 'fs6dto2s';
const CLOUDINARY_PRESET = 'ppd_unsigned';
const CLOUDINARY_UPLOAD_URL = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/auto/upload`;

/* ==================== ПРАВА ==================== */
// Виден ли тест текущему пользователю
function canSeeTest(test, profile) {
  // Если есть новый формат — используем его
  if (Array.isArray(test.audienceRoles)) {
    return canSeeTestDynamic(test, profile);
  }
  // Иначе — старая логика
  const aud = test.audience || 'all';
  if (aud === 'all') return true;
  if (aud === 'civil') return true;  // вступительный видят все

  // police — только полиция + начальство
  if (aud === 'police') {
    return isPolice(profile) || canReview(profile) || canManageStaff(profile);
  }

  // admin — только админы / правительство / губернатор
  if (aud === 'admin') {
    return canManageStaff(profile) || ['Губернатор','Правительство','Администратор','Старший администратор']
      .includes(profile?.rank);
  }
  return false;
}

// Бейдж для карточки теста
function testAudienceBadge(test) {
  const map = {
    'civil':  { text:'Для гражданских',   color:'#4a90e2' },
    'police': { text:'Для полиции',       color:'#f0b429' },
    'admin':  { text:'Для администрации', color:'#e74c3c' },
    'all':    { text:'Для всех',          color:'#2ecc71' }
  };
  const m = map[test.audience || 'all'];
  return `<span class="test-badge" style="border-color:${m.color};color:${m.color}">${m.text}</span>`;
}
const lvl = role => ROLES[role]?.level ?? 0;
const isPolice = p => p && ROLES[p.rank]?.police === true;
const canReview = p => p && lvl(p.rank) >= 9;
const canDelReports = p => p && CAN_DELETE_REPORTS.includes(p.rank);
const canManageStaff = p => p && CAN_MANAGE_STAFF.includes(p.rank);
// Кто может ВИДЕТЬ раздел Кадры (просмотр)
function canViewStaff(p) {
  if (!p) return false;
  if (isPolice(p)) return true;
  if (canManageStaff(p)) return true;
  if (['Правительство', 'Администратор'].includes(p.rank)) return true;
  return false;
}

// Кто может ВИДЕТЬ Дашборд
function canViewDashboard(p) {
  if (!p) return false;
  if (canManageStaff(p)) return true;
  if (['Правительство', 'Администратор'].includes(p.rank)) return true;
  return false;
}
const isAdmin = p => p && ['Администратор','Старший администратор'].includes(p.rank);

// Кого может менять me (target): только тех, у кого уровень ниже
// Может ли me менять РОЛЬ/СТАТУС цели (нанимать, увольнять, повышать/понижать)
function canEditUser(me, target) {
  if (!me || !target) return false;
  if (me.uid === target.uid) return false;

  // Старший администратор — все, ВКЛЮЧАЯ Гражданского
  if (me.rank === 'Старший администратор') {
    return lvl(me.rank) > lvl(target.rank);
  }

  // Руководитель ОБН — только Агент ОБН
  if (me.rank === 'Руководитель ОБН') {
    return target.rank === 'Агент ОБН';
  }

  // Полковник — только младшие 3 ранга
  if (me.rank === 'Полковник') {
    return ['Рядовой', 'Капрал', 'Сержант'].includes(target.rank);
  }

  // Генерал, Губернатор, РП-Куратор — все ниже себя, КРОМЕ Гражданского
  if (['Генерал полиции','Губернатор','РП-Куратор'].includes(me.rank)) {
    if (target.rank === 'Гражданский') return false;
    return lvl(me.rank) > lvl(target.rank);
  }

  if (!canManageStaff(me)) return false;
  return lvl(me.rank) > lvl(target.rank);
}

// Может ли me выдавать выговор/поощрение/сброс пароля для target
function canWarnAwardReset(me, target) {
  if (!me || !target) return false;
  if (me.uid === target.uid) return false;

  // Правительство и Администратор — только смотрят, не взаимодействуют
  if (['Правительство', 'Администратор'].includes(me.rank)) return false;

  // Руководитель ОБН — только Агент ОБН
  if (me.rank === 'Руководитель ОБН') {
    return target.rank === 'Агент ОБН';
  }

  // Остальные — все, кто ниже
  return lvl(me.rank) > lvl(target.rank);
}

// ===== НАЙМ И УВОЛЬНЕНИЕ =====

// Может ли me НАНЯТЬ этого гражданского (принять на службу)
function canHireUser(me, target) {
  if (!me || !target) return false;
  if (target.rank !== 'Гражданский') return false;

  if (me.rank === 'Полковник')        return true;
  if (me.rank === 'Руководитель ОБН') return true;
  if (me.rank === 'РП-Куратор')       return true;

  if (['Генерал полиции','Губернатор','Старший администратор'].includes(me.rank)) {
    return true;
  }

  return false;
}

// Какие роли может ВЫДАТЬ me при найме
function rolesIHire(me) {
  if (!me) return [];

  if (me.rank === 'Полковник')        return ['Рядовой', 'Капрал', 'Сержант'];
  if (me.rank === 'Руководитель ОБН') return ['Агент ОБН'];

  if (me.rank === 'РП-Куратор') {
    return ROLES_ORDERED.filter(r => lvl(r) < lvl(me.rank) && r !== 'Гражданский');
  }

  if (['Генерал полиции','Губернатор','Старший администратор'].includes(me.rank)) {
    return ROLES_ORDERED.filter(r => lvl(r) < lvl(me.rank) && r !== 'Гражданский');
  }

  return [];
}
// Может ли me УВОЛИТЬ этого сотрудника
function canFireUser(me, target) {
  if (!me || !target) return false;
  if (me.uid === target.uid) return false;
  if (target.rank === 'Гражданский') return false;

  if (me.rank === 'Полковник') {
    return ['Рядовой','Капрал','Сержант'].includes(target.rank);
  }
  if (me.rank === 'Руководитель ОБН') {
    return target.rank === 'Агент ОБН';
  }
  if (me.rank === 'РП-Куратор') {
    return lvl(target.rank) < lvl(me.rank);
  }
  if (['Генерал полиции','Губернатор','Старший администратор'].includes(me.rank)) {
    return lvl(me.rank) > lvl(target.rank);
  }
  return false;
}

// Какие роли может выдавать me
function rolesIAssign(me) {
  if (!me) return [];

  // Старший администратор — все роли кроме своей (включая Гражданского)
  if (me.rank === 'Старший администратор') {
    return ROLES_ORDERED.filter(r => lvl(r) < lvl(me.rank));
  }

  // Руководитель ОБН — только Агент ОБН
  if (me.rank === 'Руководитель ОБН') {
    return ['Агент ОБН'];
  }

  // Полковник — только младшие 3 ранга
  if (me.rank === 'Полковник') {
    return ['Рядовой', 'Капрал', 'Сержант'];
  }

  // Все остальные — всё ниже себя, КРОМЕ Гражданского
  return ROLES_ORDERED.filter(r => lvl(r) < lvl(me.rank) && r !== 'Гражданский');
}

// Какие роли может выдавать me ЧЕРЕЗ ПРИГЛАШЕНИЯ
function rolesIAssignViaInvite(me) {
  if (!me) return [];
  const role = me.rank;

  // Руководитель ОБН — только Агент ОБН
  if (role === 'Руководитель ОБН') {
    return ['Агент ОБН'];
  }

  // Полковник — только младший состав
  if (role === 'Полковник') {
    return ['Рядовой', 'Капрал', 'Сержант'];
  }

  // Генерал — все роли ниже себя
  if (role === 'Генерал полиции') {
    return ROLES_ORDERED.filter(r => lvl(r) < lvl(role));
  }

  // Губернатор — все роли ниже себя
  if (role === 'Губернатор') {
    return ROLES_ORDERED.filter(r => lvl(r) < lvl(role));
  }

  // Старший администратор — все роли кроме своей
  if (role === 'Старший администратор') {
    return ROLES_ORDERED.filter(r => lvl(r) < lvl(role));
  }
  // РП-Куратор — все роли ниже себя, кроме Гражданского
  if (role === 'РП-Куратор') {
    return ROLES_ORDERED.filter(r => lvl(r) < lvl(role) && r !== 'Гражданский');
  }
  return [];
}

const canGiveAwards = p => p
  && CAN_GIVE_AWARDS.includes(p.rank)
  && !['Правительство', 'Администратор'].includes(p.rank);

const canPinReports = p => p && lvl(p.rank) >= CAN_PIN_REPORTS_FROM_LEVEL;
const canUnpinAny   = p => p && lvl(p.rank) >= CAN_UNPIN_ANY_FROM_LEVEL;

// Может ли текущий пользователь закрепить/открепить конкретный отчёт
function canTogglePin(report) {
  if (!currentProfile) return false;
  if (!canPinReports(currentProfile)) return false;
  if (!report.pinned) return true;                           // закрепить — Майор+
  // открепить — только тот, кто закрепил, или Полковник+
  if (canUnpinAny(currentProfile)) return true;
  return report.pinnedByUid === currentUser?.uid;
}

/* ==================== ЗАКРЕПЛЁННЫЕ ОТЧЁТЫ ==================== */
async function togglePinReport(id, currentPinned) {
  const update = currentPinned
    ? { pinned: false, pinnedByUid: null, pinnedByNick: null, pinnedAt: null }
    : {
        pinned: true,
        pinnedByUid: currentUser.uid,
        pinnedByNick: currentProfile.nickname,
        pinnedAt: serverTimestamp()
      };
  await updateDoc(doc(db,'reports', id), update);
  toast(currentPinned ? 'Отчёт откреплён' : 'Отчёт закреплён 📌');
}

/* ==================== ТЕСТЫ — CRUD ==================== */

/* ==================== МОДАЛКА СОЗДАНИЯ/РЕДАКТИРОВАНИЯ ТЕСТА ==================== */
function openTestCreateModal(existing) {
  const isEdit = !!existing;
  const t = existing || {};

  // Выбранные роли (Set для удобства)
  const selectedRoles = new Set(t.audienceRoles || []);

  // Все доступные роли для выбора (из ROLES_ORDERED)
  const allRoles = ROLES_ORDERED.filter(r => ROLES[r]);  // только валидные

  const rolesHtml = allRoles.map(role => {
    const checked = selectedRoles.has(role) ? 'checked' : '';
    return `
      <label class="role-checkbox">
        <input type="checkbox" value="${escapeHtml(role)}" ${checked}>
        <span>${escapeHtml(role)}</span>
      </label>
    `;
  }).join('');

  openModal(`
    <h3>${isEdit ? '✏️ Редактировать тест' : '🎓 Создать тест'}</h3>
    <p class="modal-sub">${isEdit ? 'Измени настройки теста' : 'Заполни базовые настройки — вопросы добавишь потом'}</p>

    <div class="form-group">
      <label>Название теста *</label>
      <input id="t-title" type="text" placeholder="Например: Тест на знание ПДД" value="${isEdit ? escapeHtml(t.title || '') : ''}">
    </div>

    <div class="form-group">
      <label>Описание</label>
      <textarea id="t-desc" placeholder="Краткое описание теста..." style="min-height:60px">${isEdit ? escapeHtml(t.description || '') : ''}</textarea>
    </div>

    <div class="form-row-2">
      <div class="form-group">
        <label>Проходной балл (%)</label>
        <input id="t-pass" type="number" min="1" max="100" value="${t.passScore || 80}">
      </div>
      <div class="form-group">
        <label>Время (мин, 0 = без лимита)</label>
        <input id="t-time" type="number" min="0" max="180" value="${t.timeLimit ? Math.floor(t.timeLimit / 60) : 0}">
      </div>
    </div>

    <div class="form-group">
      <label>Кому адресован тест</label>
      <div class="roles-picker">
        <div class="roles-picker-head">
          <button type="button" class="btn tiny secondary" id="rolesSelectAll">Выбрать все</button>
          <button type="button" class="btn tiny secondary" id="rolesSelectNone">Снять все</button>
          <button type="button" class="btn tiny secondary" id="rolesSelectPolice">Только полиция</button>
        </div>
        <div class="roles-grid" id="rolesGrid">
          ${rolesHtml}
        </div>
        <div class="roles-hint">
          Если ничего не выбрать — тест увидят все роли.
        </div>
      </div>
    </div>

    <div class="form-group">
      <label>Поведение</label>
      <div class="check-line">
        <label class="role-checkbox">
          <input type="checkbox" id="t-shuffleQ" ${t.shuffleQuestions ? 'checked' : ''}>
          <span>Перемешивать вопросы</span>
        </label>
        <label class="role-checkbox">
          <input type="checkbox" id="t-shuffleO" ${t.shuffleOptions ? 'checked' : ''}>
          <span>Перемешивать варианты ответа</span>
        </label>
        <label class="role-checkbox">
          <input type="checkbox" id="t-hidden" ${t.hidden ? 'checked' : ''}>
          <span>Скрыть от пользователей (тест-черновик)</span>
        </label>
      </div>
    </div>

    <div class="modal-actions">
      <button class="btn secondary" data-cancel>Отмена</button>
      <button class="btn" data-confirm>${isEdit ? 'Сохранить' : 'Создать'}</button>
    </div>
  `, (overlay, close) => {
    // Кнопки управления ролями
    overlay.querySelector('#rolesSelectAll').onclick = () => {
      overlay.querySelectorAll('#rolesGrid input[type="checkbox"]').forEach(cb => cb.checked = true);
    };
    overlay.querySelector('#rolesSelectNone').onclick = () => {
      overlay.querySelectorAll('#rolesGrid input[type="checkbox"]').forEach(cb => cb.checked = false);
    };
    overlay.querySelector('#rolesSelectPolice').onclick = () => {
      const policeRoles = ['Рядовой','Капрал','Сержант','Старший сержант','SWAT',
        'Младший лейтенант','Лейтенант','Старший лейтенант','Агент ОБН','Капитан',
        'Майор','Подполковник','Руководитель ОБН','Полковник','Генерал полиции'];
      overlay.querySelectorAll('#rolesGrid input[type="checkbox"]').forEach(cb => {
        cb.checked = policeRoles.includes(cb.value);
      });
    };

    overlay.querySelector('[data-cancel]').onclick = close;

    overlay.querySelector('[data-confirm]').onclick = async () => {
      const title = overlay.querySelector('#t-title').value.trim();
      const description = overlay.querySelector('#t-desc').value.trim();
      const passScore = parseInt(overlay.querySelector('#t-pass').value, 10) || 80;
      const timeMin = parseInt(overlay.querySelector('#t-time').value, 10) || 0;
      const audienceRoles = Array.from(overlay.querySelectorAll('#rolesGrid input[type="checkbox"]:checked')).map(cb => cb.value);
      const shuffleQuestions = overlay.querySelector('#t-shuffleQ').checked;
      const shuffleOptions = overlay.querySelector('#t-shuffleO').checked;
      const hidden = overlay.querySelector('#t-hidden').checked;

      if (!title) return toast('Укажи название', 'err');
      if (passScore < 1 || passScore > 100) return toast('Проходной балл — от 1 до 100', 'err');
      if (timeMin < 0 || timeMin > 180) return toast('Время — от 0 до 180 минут', 'err');

      const payload = {
        title, description, passScore,
        audienceRoles,
        timeLimit: timeMin * 60,
        shuffleQuestions, shuffleOptions, hidden
      };

      if (isEdit) {
        await updateTest(existing.id, payload);
        close();
      } else {
        const newId = await createTest(payload);
        close();
        // Открываем редактор нового теста
        if (newId) location.hash = '#/test-editor/' + newId;
      }
    };
  });
}

// ---------- Создать новый тест ----------
async function createTest(data) {
  if (!canManageTests(currentProfile)) {
    return toast('Только ' + TEST_MANAGER_ROLES.join(', ') + ' может создавать тесты', 'err');
  }
  const test = {
    title: data.title || 'Новый тест',
    description: data.description || '',
    passScore: data.passScore || 80,
    audienceRoles: Array.isArray(data.audienceRoles) ? data.audienceRoles : [],
    timeLimit: data.timeLimit || 0,
    shuffleQuestions: !!data.shuffleQuestions,
    shuffleOptions: !!data.shuffleOptions,
    hidden: !!data.hidden,
    questions: data.questions || [],
    createdBy: currentUser.uid,
    createdByNick: currentProfile.nickname,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    updatedBy: currentProfile.nickname
  };
  const ref = await addDoc(collection(db,'tests'), test);
  toast('Тест создан');
  return ref.id;
}

// ---------- Обновить настройки теста ----------
async function updateTest(id, updates) {
  if (!canManageTests(currentProfile)) {
    return toast('Только ' + TEST_MANAGER_ROLES.join(', ') + ' может редактировать тесты', 'err');
  }
  await updateDoc(doc(db,'tests',id), {
    ...updates,
    updatedAt: serverTimestamp(),
    updatedBy: currentProfile.nickname
  });
  toast('Тест обновлён');
}

// ---------- Удалить тест ----------
async function deleteTest(id) {
  if (!canManageTests(currentProfile)) {
    return toast('Только Старший администратор может удалять тесты', 'err');
  }
  if (!confirm('Удалить тест со всеми вопросами?')) return;
  await deleteDoc(doc(db,'tests',id));
  toast('Тест удалён');
}

// ---------- Добавить вопрос ----------
async function addQuestion(testId, question) {
  if (!canManageTests(currentProfile)) return toast('Нет прав', 'err');
  const test = cachedTests.find(t => t.id === testId);
  if (!test) return toast('Тест не найден', 'err');

  const q = {
    id: 'q_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
    text: question.text || '',
    image: question.image || '',
    options: (question.options || []).map(o => ({
      text: o.text || '',
      correct: !!o.correct
    })),
    createdAt: new Date().toISOString()
  };
  const newQuestions = [...(test.questions || []), q];
  await updateDoc(doc(db,'tests',testId), {
    questions: newQuestions,
    questionsEditedAt: new Date().toISOString(),
    updatedAt: serverTimestamp(),
    updatedBy: currentProfile.nickname
  });
  toast('Вопрос добавлен');
  return q.id;
}

// ---------- Обновить вопрос ----------
async function updateQuestion(testId, questionId, updates) {
  if (!canManageTests(currentProfile)) return toast('Нет прав', 'err');
  const test = cachedTests.find(t => t.id === testId);
  if (!test) return toast('Тест не найден', 'err');

  const newQuestions = (test.questions || []).map(q => {
    if (q.id !== questionId) return q;
    return {
      ...q,
      text: updates.text !== undefined ? updates.text : q.text,
      image: updates.image !== undefined ? updates.image : q.image,
      options: updates.options !== undefined ? updates.options : q.options
    };
  });
  await updateDoc(doc(db,'tests',testId), {
    questions: newQuestions,
    questionsEditedAt: new Date().toISOString(),
    updatedAt: serverTimestamp(),
    updatedBy: currentProfile.nickname
  });
  toast('Вопрос обновлён');
}

// ---------- Удалить вопрос ----------
async function deleteQuestion(testId, questionId) {
  if (!canManageTests(currentProfile)) return toast('Нет прав', 'err');
  const test = cachedTests.find(t => t.id === testId);
  if (!test) return toast('Тест не найден', 'err');
  if (!confirm('Удалить вопрос?')) return;

  const newQuestions = (test.questions || []).filter(q => q.id !== questionId);
  await updateDoc(doc(db,'tests',testId), {
    questions: newQuestions,
    questionsEditedAt: new Date().toISOString(),
    updatedAt: serverTimestamp(),
    updatedBy: currentProfile.nickname
  });
  toast('Вопрос удалён');
}

// ---------- Переместить вопрос (direction: -1 вверх, +1 вниз) ----------
async function moveQuestion(testId, questionId, direction) {
  if (!canManageTests(currentProfile)) return toast('Нет прав', 'err');
  const test = cachedTests.find(t => t.id === testId);
  if (!test) return toast('Тест не найден', 'err');

  const arr = [...(test.questions || [])];
  const idx = arr.findIndex(q => q.id === questionId);
  if (idx < 0) return;
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= arr.length) return;

  [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];

  await updateDoc(doc(db,'tests',testId), {
    questions: arr,
    questionsEditedAt: new Date().toISOString(),
    updatedAt: serverTimestamp(),
    updatedBy: currentProfile.nickname
  });
}

// ---------- Список результатов по тесту ----------
function testResultsFor(testId) {
  return cachedTestResults.filter(r => r.testId === testId);
}

// ---------- Список результатов по пользователю ----------
function testResultsByUser(uid) {
  return cachedTestResults.filter(r => r.userId === uid);
}

/* ==================== ТЕГИ ОТЧЁТОВ ==================== */
let selectedReportTags = [];
let activeTagFilters = [];
let reportsFilter = 'all';         // 'all' | 'mine'
let lastReportsSnapshot = [];      // кэш отчётов из Firestore

function addReportTag(tagId) {
  const tag = REPORT_TAGS.find(t => t.id === tagId);
  if (!tag) return;
  if (selectedReportTags.some(t => t.id === tagId)) return;
  selectedReportTags.push(tag);
  refreshTagsDisplay();
}

function removeReportTag(tagId) {
  selectedReportTags = selectedReportTags.filter(t => t.id !== tagId);
  refreshTagsDisplay();
}

function refreshTagsDisplay() {
  const box = document.getElementById('tags-selected');
  if (!box) return;

  if (selectedReportTags.length === 0) {
    box.innerHTML = '<span class="tags-empty">Теги не выбраны</span>';
    highlightTagOptions();   // ⬅️ обновляем подсветку кнопок
    return;
  }

  box.innerHTML = selectedReportTags.map(t => `
    <span class="tag-chip" style="--tag-color:${t.color}">
      ${escapeHtml(t.label)}
      <button type="button" class="tag-remove" data-rm-tag="${t.id}">×</button>
    </span>
  `).join('');

  box.querySelectorAll('[data-rm-tag]').forEach(b => {
    b.onclick = () => {
      removeReportTag(b.dataset.rmTag);
      highlightTagOptions();   // ⬅️ обновляем подсветку кнопок
    };
  });

  highlightTagOptions();   // ⬅️ обновляем подсветку кнопок
}

function renderTagPicker() {
  return `
    <div class="form-group">
      <label>Теги</label>
      <div class="tag-picker">
        ${REPORT_TAGS.map(t => `
          <button type="button" class="tag-option" data-add-tag="${t.id}" style="--tag-color:${t.color}">
            ${escapeHtml(t.label)}
          </button>
        `).join('')}
      </div>
      <div class="tags-selected" id="tags-selected">
        <span class="tags-empty">Теги не выбраны</span>
      </div>
    </div>
  `;
}

function initTagPicker() {
  setTimeout(() => {
    // Восстанавливаем из черновика
    const draft = loadDraft('reports');
    if (draft && draft.tags && Array.isArray(draft.tags)) {
      selectedReportTags = draft.tags
        .map(id => REPORT_TAGS.find(t => t.id === id))
        .filter(Boolean);
    }
    refreshTagsDisplay();
    highlightTagOptions();

    // Клики по тегам — toggle (вкл/выкл)
    document.querySelectorAll('[data-add-tag]').forEach(b => {
      b.onclick = () => {
        const tagId = b.dataset.addTag;
        if (selectedReportTags.some(t => t.id === tagId)) {
          // Уже выбран — убираем
          removeReportTag(tagId);
        } else {
          // Не выбран — добавляем
          addReportTag(tagId);
        }
        highlightTagOptions();
        // Обновим черновик
        saveDraft('reports', {
          type: document.getElementById('r-type')?.value || '',
          partner: document.getElementById('r-partner')?.value || '',
          desc: document.getElementById('r-desc')?.value || '',
          tags: selectedReportTags.map(t => t.id)
        });
      };
    });
  }, 0);
}

// Подсветка активных кнопок тегов в форме
function highlightTagOptions() {
  document.querySelectorAll('[data-add-tag]').forEach(b => {
    const tagId = b.dataset.addTag;
    const isSelected = selectedReportTags.some(t => t.id === tagId);
    b.classList.toggle('selected', isSelected);
  });
}

function renderReportTags(tags) {
  if (!tags || tags.length === 0) return '';
  return `
    <div class="report-tags-row">
      ${tags.map(tagId => {
        const t = REPORT_TAGS.find(x => x.id === tagId);
        if (!t) return '';
        return `<span class="tag-chip small" style="--tag-color:${t.color}">${escapeHtml(t.label)}</span>`;
      }).join('')}
    </div>
  `;
}

function renderTagFilterBar() {
  const noneActive = activeTagFilters.length === 0;
  return `
    <div class="tag-filter-bar">
      <span class="tag-filter-label">Фильтр:</span>
      <button class="tag-filter-btn ${noneActive ? 'active' : ''}" data-filter-tag="">
        Все
      </button>
      ${REPORT_TAGS.map(t => `
        <button class="tag-filter-btn ${activeTagFilters.includes(t.id) ? 'active' : ''}"
                data-filter-tag="${t.id}"
                style="--tag-color:${t.color}">
          ${escapeHtml(t.label)}
        </button>
      `).join('')}
    </div>
  `;
}

function initTagFilterBar() {
  setTimeout(() => {
    document.querySelectorAll('[data-filter-tag]').forEach(b => {
      b.onclick = () => {
        const id = b.dataset.filterTag;
        if (!id) {
          activeTagFilters = [];
        } else {
          if (activeTagFilters.includes(id)) {
            activeTagFilters = activeTagFilters.filter(x => x !== id);
          } else {
            activeTagFilters.push(id);
          }
        }
        render();
      };
    });
  }, 0);
}

/* ==================== АВТОСОХРАНЕНИЕ ЧЕРНОВИКА ==================== */
const DRAFT_PREFIX = 'ppd_draft_';

function saveDraft(key, data) {
  try {
    localStorage.setItem(DRAFT_PREFIX + key, JSON.stringify({
      data,
      savedAt: Date.now()
    }));
    showDraftIndicator(key);
  } catch (e) {
    console.warn('Не удалось сохранить черновик:', e);
  }
}

function loadDraft(key) {
  try {
    const raw = localStorage.getItem(DRAFT_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed.data || null;
  } catch (e) { return null; }
}

function clearDraft(key) {
  try {
    localStorage.removeItem(DRAFT_PREFIX + key);
    hideDraftIndicator(key);
  } catch (e) {}
}

function showDraftIndicator(key) {
  let el = document.getElementById('draft-indicator-global');
  if (!el) {
    el = document.createElement('div');
    el.id = 'draft-indicator-global';
    el.className = 'draft-indicator';
    document.body.appendChild(el);
  }
  el.textContent = '💾 Черновик сохранён';
  el.classList.add('visible');
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => el.classList.remove('visible'), 1500);
}

function hideDraftIndicator(key) {
  const el = document.getElementById('draft-indicator-global');
  if (el) el.classList.remove('visible');
}

// Универсальный инициализатор автосохранения
// fieldMap: { htmlId: ключ_в_объекте }
function initDraft(key, fieldMap) {
  setTimeout(() => {
    // Восстановление из черновика
    const draft = loadDraft(key);
    if (draft) {
      Object.entries(fieldMap).forEach(([id, dataKey]) => {
        const el = document.getElementById(id);
        if (el && draft[dataKey] !== undefined) {
          el.value = draft[dataKey];
        }
      });
    }

    // Слушатель изменений
    Object.entries(fieldMap).forEach(([id]) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', () => {
        const data = {};
        Object.entries(fieldMap).forEach(([fid, dk]) => {
          const e = document.getElementById(fid);
          if (e) data[dk] = e.value;
        });
        saveDraft(key, data);
      });
      el.addEventListener('change', () => {
        const data = {};
        Object.entries(fieldMap).forEach(([fid, dk]) => {
          const e = document.getElementById(fid);
          if (e) data[dk] = e.value;
        });
        saveDraft(key, data);
      });
    });
  }, 0);
}

function renderDraftIndicator(key) {
  return ''; // Теперь показываем глобальный плавающий индикатор
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

/* ==================== МУЛЬТИВЫБОР НАПАРНИКОВ ==================== */

function renderPartnerPicker(stateKey) {
  return `
    <div class="form-group">
      <label>Напарники (можно несколько)</label>
      <select class="partner-add-select" data-partner-add="${stateKey}">
        <option value="">— Добавить напарника —</option>
      </select>
      <div class="partner-chips" id="partner-chips-${stateKey}"></div>
    </div>
  `;
}

function refreshPartnerChips(stateKey) {
  const box = document.getElementById(`partner-chips-${stateKey}`);
  const sel = document.querySelector(`[data-partner-add="${stateKey}"]`);
  if (!box || !sel) return;

  const uids = selectedPartners[stateKey] || [];

  if (uids.length === 0) {
    box.innerHTML = '<span class="partner-empty">Никого не выбрано</span>';
  } else {
    box.innerHTML = uids.map(uid => {
      const u = cachedUsers.find(x => x.uid === uid);
      if (!u) return '';
      return `
        <div class="partner-chip">
          <span>${escapeHtml(u.nickname)} <em>${escapeHtml(u.rank)}</em></span>
          <button type="button" data-rm-partner="${uid}" data-key="${stateKey}" title="Убрать">×</button>
        </div>
      `;
    }).join('');

    box.querySelectorAll('[data-rm-partner]').forEach(b => {
      b.onclick = () => {
        const uid = b.dataset.rmPartner;
        selectedPartners[b.dataset.key] = selectedPartners[b.dataset.key].filter(x => x !== uid);
        refreshPartnerChips(b.dataset.key);
      };
    });
  }

  // Заполняем селект теми, кто ещё не выбран
  const opts = ['<option value="">— Добавить напарника —</option>'];
  cachedUsers.forEach(u => {
    if (u.status !== 'active') return;
    if (u.uid === currentUser.uid) return;
    if (!isPolice(u)) return;
    if (uids.includes(u.uid)) return;
    opts.push(`<option value="${u.uid}">${escapeHtml(u.nickname)} — ${escapeHtml(u.rank)}</option>`);
  });
  sel.innerHTML = opts.join('');
}

function initPartnerPicker(stateKey) {
  setTimeout(() => {
    const sel = document.querySelector(`[data-partner-add="${stateKey}"]`);
    if (!sel) return;
    sel.onchange = () => {
      const uid = sel.value;
      if (!uid) return;
      if (!selectedPartners[stateKey].includes(uid)) {
        selectedPartners[stateKey].push(uid);
      }
      refreshPartnerChips(stateKey);
      sel.value = '';
    };
    refreshPartnerChips(stateKey);
  }, 0);
}

function getPartnerObjects(stateKey) {
  return (selectedPartners[stateKey] || []).map(uid => {
    const u = cachedUsers.find(x => x.uid === uid);
    return u ? { uid: u.uid, nickname: u.nickname, rank: u.rank } : null;
  }).filter(Boolean);
}

/* ==================== ЗАГРУЗКА ФАЙЛОВ ==================== */
async function uploadSingleFile(file, folder) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', CLOUDINARY_PRESET);
  formData.append('folder', `ppd/${folder}`);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', CLOUDINARY_UPLOAD_URL, true);

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          resolve({
            url: data.secure_url,
            publicId: data.public_id,
            name: file.name,
            size: file.size,
            type: file.type
          });
        } catch (e) { reject(new Error('Ошибка разбора ответа')); }
      } else {
        reject(new Error('Ошибка ' + xhr.status));
      }
    };
    xhr.onerror = () => reject(new Error('Сеть недоступна'));
    xhr.send(formData);
  });
}

async function uploadAllFiles(files, folder) {
  const results = [];
  for (const f of files) {
    try {
      const info = await uploadSingleFile(f, folder);
      results.push(info);
    } catch (e) {
      console.error('Ошибка загрузки:', f.name, e);
      toast(`Не удалось: ${f.name}`, 'err');
    }
  }
  return results;
}

function handleFiles(fileList, stateKey) {
  if (!pendingFiles[stateKey]) pendingFiles[stateKey] = [];
  const arr = Array.from(fileList);
  const current = pendingFiles[stateKey];

  const isAnnounce = stateKey === 'announcements';
  const isQuestion = stateKey === 'question';

  // Лимит файлов
  const maxFiles = (isAnnounce || isQuestion) ? 1 : MAX_FILES;

  arr.forEach(f => {
    if (current.length >= maxFiles) {
      return toast(`Максимум ${maxFiles} файл${maxFiles === 1 ? '' : 'ов'}`, 'err');
    }
    if (f.size > MAX_FILE_SIZE) {
      return toast(`${f.name} — больше 5 МБ`, 'err');
    }
    // Для объявлений и вопросов — только картинки
    const onlyImages = isAnnounce || isQuestion;
    const ok = onlyImages
      ? f.type.startsWith('image/')
      : (f.type.startsWith('image/') || f.type.startsWith('video/') || f.type === 'application/pdf');
    if (!ok) {
      return toast(`${f.name} — неподдерживаемый тип${onlyImages ? ' (только картинки)' : ''}`, 'err');
    }
    current.push(f);
  });
  refreshUploadList(stateKey);
}

function refreshUploadList(stateKey) {
  const list = document.getElementById(`upload-list-${stateKey}`);
  if (!list) return;
  const files = pendingFiles[stateKey] || [];

  if (files.length === 0) { list.innerHTML = ''; return; }

  list.innerHTML = files.map((f, i) => {
    const isImg = f.type.startsWith('image/');
    const isVideo = f.type.startsWith('video/');
    const preview = isImg ? URL.createObjectURL(f) : null;

    let thumb;
    if (isImg) thumb = `<img src="${preview}" class="upload-thumb" alt="">`;
    else if (isVideo) thumb = `<div class="upload-thumb video-icon">🎬</div>`;
    else thumb = `<div class="upload-thumb file-icon">📄</div>`;

    return `<div class="upload-item">
      ${thumb}
      <div class="upload-info">
        <div class="upload-name">${escapeHtml(f.name)}</div>
        <div class="upload-size">${(f.size/1024).toFixed(0)} КБ</div>
      </div>
      <button type="button" class="upload-remove" data-remove-file="${i}" data-state-key="${stateKey}">×</button>
    </div>`;
  }).join('');

  list.querySelectorAll('[data-remove-file]').forEach(b => {
    b.onclick = () => {
      const i = parseInt(b.dataset.removeFile, 10);
      pendingFiles[b.dataset.stateKey].splice(i, 1);
      refreshUploadList(b.dataset.stateKey);
    };
  });
}

function initFileUploaders() {
  ['reports', 'detentions', 'fines', 'announcements', 'question'].forEach(key => {
    const input = document.getElementById(`upload-input-${key}`);
    if (!input) return;
    input.onchange = () => { handleFiles(input.files, key); input.value = ''; };
    refreshUploadList(key);
  });

  document.querySelectorAll('[data-attach-for]').forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      const input = document.getElementById(`upload-input-${btn.dataset.attachFor}`);
      input?.click();
    };
  });
}

function getActiveUploadKey() {
  // Модалка вопроса — приоритет
  if (document.getElementById('upload-input-question')) return 'question';
  // Модалка объявления
  if (document.getElementById('upload-input-announcements')) return 'announcements';
  const hash = location.hash;
  if (hash === '#/reports') return 'reports';
  if (hash.startsWith('#/registry/detentions')) return 'detentions';
  if (hash.startsWith('#/registry/fines')) return 'fines';
  return null;
}

// Ctrl+V — вставка из буфера
document.addEventListener('paste', (e) => {
  const key = getActiveUploadKey();
  if (!key) return;
  // Игнорируем вставку в другие поля (кроме textarea)
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag !== 'textarea') return;

  const items = e.clipboardData?.items;
  if (!items) return;

  const files = [];
  for (const item of items) {
    if (item.kind === 'file') {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length > 0) {
    e.preventDefault();
    handleFiles(files, key);
    toast('Вставлено: ' + files.length);
  }
});

// Отображение в карточке
function renderAttachments(files) {
  if (!files || files.length === 0) return '';
  return `<div class="report-files">
    ${files.map(f => {
      const isImg = f.type && f.type.startsWith('image/');
      const isVideo = f.type && f.type.startsWith('video/');
      if (isImg) {
        return `<a href="${escapeHtml(f.url)}" target="_blank" class="report-img-link" rel="noopener">
          <img src="${escapeHtml(f.url)}" class="report-img" alt="" loading="lazy">
        </a>`;
      }
      if (isVideo) {
        return `<div class="report-video">
          <video controls preload="metadata" class="report-video-el">
            <source src="${escapeHtml(f.url)}" type="${escapeHtml(f.type)}">
          </video>
        </div>`;
      }
      return `<a href="${escapeHtml(f.url)}" target="_blank" class="report-file-link" rel="noopener">
        📄 ${escapeHtml(f.name)}
      </a>`;
    }).join('')}
  </div>`;
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

  if (isRegistering) return;
  isRegistering = true;
  let cred = null;

  try {
    // 1. Создаём аккаунт в Auth
    cred = await createUserWithEmailAndPassword(auth, nickToEmail(nick), pass);

    // 2. Получаем список юзеров (с ретраем на случай задержки токена)
    const all = await firestoreWithRetry(() => getDocs(collection(db,'users')));

    let assignedRole = 'Гражданский';
    let inviteUsedId = null;
    let inviteCurrent = null;

    if (all.size === 0) {
      assignedRole = 'Старший администратор';
    } else if (code) {
      const invSnap = await firestoreWithRetry(() => 
        getDocs(query(collection(db,'invites'), where('code','==',code)))
      );
      if (invSnap.empty) throw new Error('Неверный код приглашения');

      const invDoc = invSnap.docs[0];
      const inv = invDoc.data();

      if (inv.expiresAt && new Date(inv.expiresAt) < new Date()) {
        throw new Error('Код приглашения истёк');
      }

      const usedCount = inv.usedCount || 0;
      const maxUses = inv.maxUses || 1;
      if (usedCount >= maxUses) {
        throw new Error('Код приглашения исчерпан');
      }

      const usedByArr = inv.usedBy || [];
      if (usedByArr.includes(cred.user.uid)) {
        throw new Error('Ты уже использовал этот код');
      }

      assignedRole = inv.role;
      inviteUsedId = invDoc.id;
      inviteCurrent = inv;
    }

    // 3. Создаём профиль в Firestore
    await firestoreWithRetry(() => 
      setDoc(doc(db,'users',cred.user.uid), {
        nickname: nick,
        rank: assignedRole,
        status: 'active',
        warnings: [],
        createdAt: serverTimestamp(),
        lastAnnouncementReadAt: serverTimestamp()
      })
    );

    // 4. Помечаем инвайт использованным
    if (inviteUsedId && inviteCurrent) {
      const oldUsedBy = inviteCurrent.usedBy || [];
      const oldCount = inviteCurrent.usedCount || 0;
      await firestoreWithRetry(() => 
        updateDoc(doc(db,'invites',inviteUsedId), {
          usedBy: [...oldUsedBy, cred.user.uid],
          usedByNicks: [...(inviteCurrent.usedByNicks || []), nick],
          usedCount: oldCount + 1,
          usedAt: serverTimestamp()
        })
      );
    }
  } catch (e) {
    console.error(e);
    err.textContent = e.code ? translateErr(e.code) : (e.message || 'Ошибка регистрации');

    // Откат
    if (cred && cred.user) {
      try {
        await cred.user.delete();
        console.log('Откат успешен: удалён аккаунт из Auth');
      } catch (delErr) {
        console.error('Не удалось откатить регистрацию:', delErr);
      }
    }
  } finally {
    isRegistering = false;
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
  // 1. Отписываемся от всех подписок
  if (reportsUnsub)         { try { reportsUnsub(); }         catch(e){} reportsUnsub = null; }
  if (invitesUnsub)         { try { invitesUnsub(); }         catch(e){} invitesUnsub = null; }
  if (resetsUnsub)          { try { resetsUnsub(); }          catch(e){} resetsUnsub = null; }
  if (detentionsUnsub)      { try { detentionsUnsub(); }      catch(e){} detentionsUnsub = null; }
  if (finesUnsub)           { try { finesUnsub(); }           catch(e){} finesUnsub = null; }
  if (reportsGlobalUnsub)   { try { reportsGlobalUnsub(); }   catch(e){} reportsGlobalUnsub = null; }
  if (dashboardConfigUnsub) { try { dashboardConfigUnsub(); } catch(e){} dashboardConfigUnsub = null; }
  if (announcementsUnsub)   { try { announcementsUnsub(); }   catch(e){} announcementsUnsub = null; }
  if (vacationsUnsub)       { try { vacationsUnsub(); }       catch(e){} vacationsUnsub = null; }
  if (testsUnsub)           { try { testsUnsub(); }           catch(e){} testsUnsub = null; }
  if (testResultsUnsub)     { try { testResultsUnsub(); }     catch(e){} testResultsUnsub = null; }
  if (promotionConfigUnsub) { try { promotionConfigUnsub(); } catch(e){} promotionConfigUnsub = null; }

  // 2. Сбрасываем состояние
  currentTestRun = null;

  // 3. Даём Firestore 200 мс, чтобы корректно закрыть стримы
  await new Promise(r => setTimeout(r, 200));

  // 4. Теперь безопасно выходим
  await signOut(auth);
}

async function loadProfile(uid) {
  const snap = await getDoc(doc(db,'users',uid));
  return snap.exists() ? { uid, ...snap.data() } : null;
}

/* ==================== РЕАЛТАЙМ ==================== */
function subscribeUsers() {
  onSnapshot(
    collection(db,'users'),
    snap => {
      cachedUsers = [];
      snap.forEach(d => cachedUsers.push({ uid: d.id, ...d.data() }));
      cachedUsers.sort((a,b) => lvl(b.rank) - lvl(a.rank));
      if (['#/staff','#/reports'].includes(location.hash)) render();
    },
    err => {
      if (err?.code === 'permission-denied') return;
      console.warn('users listener:', err);
    }
  );
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
function subscribeReportsGlobal() {
  if (reportsGlobalUnsub) reportsGlobalUnsub();
  reportsGlobalUnsub = onSnapshot(
    query(collection(db,'reports'), orderBy('createdAt','desc')),
    snap => {
      cachedReports = [];
      snap.forEach(d => cachedReports.push({ id: d.id, ...d.data() }));
      if (location.hash === '#/dashboard') render();
    }
  );
}

function subscribeDashboardConfig() {
  if (dashboardConfigUnsub) dashboardConfigUnsub();
  dashboardConfigUnsub = onSnapshot(doc(db,'config','dashboard'), snap => {
    dashboardConfig = snap.exists() ? snap.data() : { lastClearAt: null };
    if (location.hash === '#/dashboard') render();
  });
}

async function clearDashboard() {
  if (!confirm('Очистить статистику дашборда?\n\nЗаписи в базе (отчёты, задержания, штрафы) ОСТАНУТСЯ.\nСчётчики обнулятся и будут считать только новые записи.')) return;
  await setDoc(doc(db,'config','dashboard'), {
    lastClearAt: serverTimestamp(),
    clearedBy: currentProfile.nickname,
    clearedAt: new Date().toISOString()
  }, { merge: true });
  toast('Дашборд очищен');
}

function subscribeTests() {
  if (testsUnsub) testsUnsub();
  testsUnsub = onSnapshot(
    query(collection(db,'tests'), orderBy('createdAt','desc')),
    snap => {
      cachedTests = [];
      snap.forEach(d => cachedTests.push({ id: d.id, ...d.data() }));
      // Перерисовываем, если мы на любой странице, связанной с тестами
      const h = location.hash;
      if (
        h === '#/tests' ||
        h.startsWith('#/test-editor/') ||
        h.startsWith('#/test-history/') ||
        h.startsWith('#/test-result/')
      ) {
        render();
      }
    },
    err => {
      if (err?.code === 'permission-denied') return;
      console.warn('tests listener:', err);
    }
  );
}

function subscribePromotionConfig() {
  if (promotionConfigUnsub) promotionConfigUnsub();
  promotionConfigUnsub = onSnapshot(
    doc(db, 'config', 'promotion'),
    snap => {
      if (snap.exists()) {
        const data = snap.data();
        promotionRules = data.byRole ? data : defaultPromotionRules();
      } else {
        promotionRules = defaultPromotionRules();
      }
      if (location.hash === '#/staff') render();
    },
    err => {
      if (err?.code === 'permission-denied') return;
      console.warn('promotion listener:', err);
    }
  );
}

function subscribeTestResults() {
  if (testResultsUnsub) testResultsUnsub();
  testResultsUnsub = onSnapshot(
    query(collection(db,'testResults'), orderBy('finishedAt','desc')),
    snap => {
      cachedTestResults = [];
      snap.forEach(d => cachedTestResults.push({ id: d.id, ...d.data() }));
      if (location.hash.startsWith('#/test-results')) render();
    },
    err => {
      if (err?.code === 'permission-denied') return;
      console.warn('testResults listener:', err);
    }
  );
}

/* ==================== ОТЧЁТЫ ==================== */
async function submitReport() {
  const type = document.getElementById('r-type').value;
  const desc = document.getElementById('r-desc').value.trim();

  if (!desc) return toast('Заполни описание','err');

  // Собираем массив партнёров
  const partners = getPartnerObjects('reports');
  const partnerUids = partners.map(p => p.uid);
  const firstPartner = partners[0] || null;

  // Загрузка файлов
  let uploaded = [];
  const filesToUpload = pendingFiles.reports || [];
  if (filesToUpload.length > 0) {
    toast('Загрузка файлов... (' + filesToUpload.length + ')');
    uploaded = await uploadAllFiles(filesToUpload, 'reports');
  }

  await addDoc(collection(db,'reports'), {
    authorUid: currentUser.uid,
    authorNick: currentProfile.nickname,
    authorRank: currentProfile.rank,
    // Старые поля — для совместимости
    partnerUid: firstPartner?.uid || null,
    partnerNick: firstPartner?.nickname || '',
    partnerRank: firstPartner?.rank || '',
    // Новые поля — массивы
    partners: partners,
    partnerUids: partnerUids,
    type,
    description: desc,
    files: uploaded,
    tags: selectedReportTags.map(t => t.id),
    status: 'pending',
    reviewComment: '',
    reviewedBy: null,
    reviewedAt: null,
    createdAt: serverTimestamp()
  });

  // Очистка
  pendingFiles.reports = [];
  refreshUploadList('reports');
  document.getElementById('r-desc').value = '';
  selectedPartners.reports = [];
  refreshPartnerChips('reports');
  selectedReportTags = [];
  refreshTagsDisplay();
  clearDraft('reports');

  toast('Отчёт отправлен');
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
  if (target.rank === newRole) return;

  const historyEntry = {
    from: target.rank,
    to: newRole,
    by: currentProfile.nickname,
    byRank: currentProfile.rank,
    at: new Date().toISOString()
  };

  await updateDoc(doc(db,'users',uid), {
    rank: newRole,
    rankHistory: [...(target.rankHistory || []), historyEntry]
  });
  toast('Роль обновлена: ' + newRole);
}

/* ==================== НАЙМ И УВОЛЬНЕНИЕ ==================== */

// ---- Модалка найма ----
function openHireModal(uid) {
  const target = cachedUsers.find(u => u.uid === uid);
  if (!target) return;

  const availableRoles = rolesIHire(currentProfile);
  if (availableRoles.length === 0) return toast('Нет доступных ролей', 'err');

  openModal(`
    <h3>✓ Принять на службу</h3>
    <p class="modal-sub">
      Гражданский: <strong style="color:var(--accent)">${escapeHtml(target.nickname)}</strong>
    </p>

    <div class="form-group">
      <label>Должность</label>
      <select id="hire-role">
        ${availableRoles.map(r => `<option value="${r}">${r}</option>`).join('')}
      </select>
    </div>

    <div class="form-group">
      <label>Причина приёма (обязательно)</label>
      <textarea id="hire-reason" placeholder="Например: успешно прошёл собеседование..." style="min-height:80px"></textarea>
    </div>

    <div class="modal-actions">
      <button class="btn secondary" data-cancel>Отмена</button>
      <button class="btn" data-confirm>Принять</button>
    </div>
  `, (overlay, close) => {
    overlay.querySelector('[data-cancel]').onclick = close;

    overlay.querySelector('[data-confirm]').onclick = async () => {
      const role = overlay.querySelector('#hire-role').value;
      const reason = overlay.querySelector('#hire-reason').value.trim();

      if (!role) return toast('Выбери должность', 'err');
      if (!reason) return toast('Укажи причину приёма', 'err');

      // История
      const historyEntry = {
        from: target.rank,
        to: role,
        by: currentProfile.nickname,
        byRank: currentProfile.rank,
        at: new Date().toISOString(),
        reason,
        type: 'hire'
      };

      try {
        await updateDoc(doc(db, 'users', uid), {
          rank: role,
          status: 'active',
          rankHistory: [...(target.rankHistory || []), historyEntry],
          firedInfo: null,   // на случай, если был уволен ранее
          firedAcknowledged: true
        });
        close();
        toast(`${target.nickname} принят на ${role}`);
      } catch (e) {
        console.error(e);
        toast('Не удалось принять: ' + (e.message || 'ошибка'), 'err');
      }
    };
  });
}

// ---- Модалка увольнения ----
function openFireModal(uid) {
  const target = cachedUsers.find(u => u.uid === uid);
  if (!target) return;

  openModal(`
    <h3>🗑 Уволить сотрудника</h3>
    <p class="modal-sub">
      <strong style="color:var(--accent)">${escapeHtml(target.nickname)}</strong>
      <span style="color:var(--muted)"> · ${escapeHtml(target.rank)}</span>
    </p>

    <div class="form-group">
      <label>Причина увольнения (обязательно)</label>
      <textarea id="fire-reason" placeholder="Например: неоднократное нарушение устава..." style="min-height:100px"></textarea>
    </div>

    <div class="modal-actions">
      <button class="btn secondary" data-cancel>Отмена</button>
      <button class="btn danger" data-confirm>Уволить</button>
    </div>
  `, (overlay, close) => {
    overlay.querySelector('[data-cancel]').onclick = close;

    overlay.querySelector('[data-confirm]').onclick = async () => {
      const reason = overlay.querySelector('#fire-reason').value.trim();
      if (!reason) return toast('Укажи причину увольнения', 'err');

      const historyEntry = {
        from: target.rank,
        to: 'Гражданский',
        by: currentProfile.nickname,
        byRank: currentProfile.rank,
        at: new Date().toISOString(),
        reason,
        type: 'fire'
      };

      try {
        await updateDoc(doc(db, 'users', uid), {
          rank: 'Гражданский',
          status: 'active',           // сбрасываем статус
          rankHistory: [...(target.rankHistory || []), historyEntry],
          firedInfo: {
            by: currentProfile.nickname,
            byRank: currentProfile.rank,
            at: new Date().toISOString(),
            reason
          },
          firedAcknowledged: false
        });
        close();
        toast(`${target.nickname} уволен`);
      } catch (e) {
        console.error(e);
        toast('Не удалось уволить: ' + (e.message || 'ошибка'), 'err');
      }
    };
  });
}

/* ==================== УВЕДОМЛЕНИЕ ОБ УВОЛЬНЕНИИ ==================== */

// Проверка при входе: показать ли уведомление
function checkFiredNotification(profile) {
  if (!profile) return;
  if (!profile.firedInfo) return;
  if (profile.firedAcknowledged === true) return;

  // Проверяем срок давности — 45 дней
  const firedAt = new Date(profile.firedInfo.at).getTime();
  const daysPassed = (Date.now() - firedAt) / (24 * 3600 * 1000);

  if (daysPassed > 45) {
    // Уведомление устарело — помечаем как прочитанное автоматически
    updateDoc(doc(db, 'users', currentUser.uid), { firedAcknowledged: true })
      .catch(err => console.warn('Не удалось пометить уведомление:', err));
    return;
  }

  showFiredNotification(profile.firedInfo);
}

// Показ блокирующего уведомления
function showFiredNotification(info) {
  document.getElementById('firedNotice')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'firedNotice';
  overlay.className = 'fired-notice-overlay';
  overlay.innerHTML = `
    <div class="fired-notice">
      <div class="fired-notice-icon">⚠️</div>
      <h3 class="fired-notice-title">ВЫ УВОЛЕНЫ</h3>
      <div class="fired-notice-body">
        <div class="fired-notice-row">
          <span class="fired-notice-label">Кем уволен:</span>
          <span class="fired-notice-value">${escapeHtml(info.by)} <em>(${escapeHtml(info.byRank || '')})</em></span>
        </div>
        <div class="fired-notice-row">
          <span class="fired-notice-label">Когда:</span>
          <span class="fired-notice-value">${fmtDate(info.at)}</span>
        </div>
        <div class="fired-notice-row">
          <span class="fired-notice-label">Причина:</span>
          <span class="fired-notice-value">${escapeHtml(info.reason)}</span>
        </div>
      </div>
      <button class="btn danger" id="btnAckFired" style="width:100%;margin-top:16px">Ознакомлен</button>
    </div>
  `;
  document.body.appendChild(overlay);

  // Блокируем клики по фону
  overlay.addEventListener('click', e => e.stopPropagation());

  document.getElementById('btnAckFired').onclick = async (e) => {
    e.stopPropagation();
    try {
      await updateDoc(doc(db, 'users', currentUser.uid), { firedAcknowledged: true });
    } catch (err) {
      console.error('Не удалось сохранить ознакомление:', err);
    }
    overlay.remove();
    if (currentProfile) currentProfile.firedAcknowledged = true;
  };
}

async function setUserStatus(uid, status) {
  if (!STATUS_LABELS[status]) return toast('Неверный статус','err');

  if (status === 'fired') {
    if (!confirm('Уволить сотрудника?')) return;
  } else {
    const labels = {
      active: 'вернуть в строй',
      vacation: 'отправить в отпуск',
      sick: 'перевести на больничный'
    };
    if (!confirm(`Точно ${labels[status]}?`)) return;
  }

  await updateDoc(doc(db,'users',uid), { status });
  toast('Статус обновлён: ' + STATUS_LABELS[status].label);
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
/* ==================== ОБЪЯВЛЕНИЯ ==================== */
// Флаг, чтобы не показывать плашку при самой первой загрузке страницы, 
// а только когда объявление реально приходит "в прямом эфире" или при входе
let annInitialLoadDone = false;

function subscribeAnnouncements() {
  if (announcementsUnsub) announcementsUnsub();
  announcementsUnsub = onSnapshot(
    query(collection(db,'announcements'), orderBy('createdAt','desc')),
    snap => {
      cachedAnnouncements = [];
      snap.forEach(d => cachedAnnouncements.push({ id: d.id, ...d.data() }));

      // Обновляем меню (чтобы загорелась красная точка, если появилось новое)
      buildNav();

      if (location.hash === '#/announcements') {
        render();
      } else if (!annInitialLoadDone) {
        // При входе на сайт проверяем, есть ли непрочитанные
        annInitialLoadDone = true;
        if (hasUnreadAnnouncements()) {
          setTimeout(() => showAnnouncementBanner(cachedAnnouncements[0]), 1000);
        }
      } else {
        // Если мы уже на сайте, и прилетело новое объявление
        const hasNew = snap.docChanges().some(change => change.type === 'added');
        if (hasNew && hasUnreadAnnouncements()) {
          showAnnouncementBanner(cachedAnnouncements[0]);
        }
      }
    },
    err => {
      if (err?.code === 'permission-denied') return;
      console.warn('announcements listener:', err);
    }
  );
}

function openAnnouncementModal(existing) {
  const isEdit = !!existing;

  // Сбрасываем pendingFiles.announcements
  pendingFiles.announcements = [];

  // Для режима редактирования — показываем существующие файлы
  const existingFiles = (isEdit && existing.files) ? existing.files : [];
  const existingFilesHtml = existingFiles.length ? `
    <div class="form-group">
      <label>Загруженные фото</label>
      <div class="ann-existing-files">
        ${existingFiles.map(f => `
          <div class="ann-existing-file" data-existing-url="${escapeHtml(f.url)}">
            <img src="${escapeHtml(f.url)}" alt="">
            <button type="button" class="ann-existing-remove" title="Удалить">×</button>
          </div>
        `).join('')}
      </div>
    </div>
  ` : '';

  openModal(`
    <h3>${isEdit ? '✏️ Редактировать объявление' : '📢 Новое объявление'}</h3>
    <div class="form-group">
      <label>Заголовок</label>
      <input id="ann-title" type="text" placeholder="Например: Общее собрание" value="${isEdit ? escapeHtml(existing.title) : ''}">
    </div>
    <div class="form-group">
      <label class="label-with-attach">
        Текст
        <button type="button" class="attach-btn" data-attach-for="announcements">📎 Прикрепить</button>
      </label>
      <textarea id="ann-text" placeholder="Опиши подробно... (можно вставить фото через Ctrl+V)" style="min-height:140px">${isEdit ? escapeHtml(existing.text) : ''}</textarea>
      <input type="file" multiple accept="image/*"
             id="upload-input-announcements" style="display:none">
      <div class="upload-list" id="upload-list-announcements"></div>
    </div>

    ${existingFilesHtml}

    <div class="modal-actions">
      <button class="btn secondary" data-cancel>Отмена</button>
      <button class="btn" data-confirm>${isEdit ? 'Сохранить' : 'Опубликовать'}</button>
    </div>
  `, (overlay, close) => {
    // Список удалённых существующих файлов
    const removedExisting = [];
    overlay.querySelectorAll('.ann-existing-remove').forEach(btn => {
      btn.onclick = () => {
        const wrapper = btn.closest('.ann-existing-file');
        removedExisting.push(wrapper.dataset.existingUrl);
        wrapper.remove();
      };
    });

    // Инициализируем загрузчик
    initFileUploaders();

    overlay.querySelector('[data-cancel]').onclick = close;

    overlay.querySelector('[data-confirm]').onclick = async () => {
      const title = overlay.querySelector('#ann-title').value.trim();
      const text = overlay.querySelector('#ann-text').value.trim();
      if (!title) return toast('Укажи заголовок','err');
      if (!text) return toast('Укажи текст','err');

      // Загружаем новые файлы
      let uploaded = [];
      if (pendingFiles.announcements.length > 0) {
        toast('Загрузка фото...');
        uploaded = await uploadAllFiles(pendingFiles.announcements, 'announcements');
      }

      // Существующие, которые остались
      const keptExisting = existingFiles.filter(f => !removedExisting.includes(f.url));
      const finalFiles = [...keptExisting, ...uploaded];

      if (isEdit) {
        await updateDoc(doc(db,'announcements',existing.id), {
          title, text,
          files: finalFiles,
          editedAt: new Date().toISOString(),
          editedBy: currentProfile.nickname
        });
        toast('Объявление обновлено');
      } else {
        await addDoc(collection(db,'announcements'), {
          title, text,
          files: finalFiles,
          authorUid: currentUser.uid,
          authorNick: currentProfile.nickname,
          authorRank: currentProfile.rank,
          pinned: false,
          createdAt: serverTimestamp(),
          editedAt: null,
          editedBy: null
        });
        toast('Объявление опубликовано');
      }

      pendingFiles.announcements = [];
      close();
    };
  });
}

async function togglePinAnnouncement(id, currentPinned) {
  await updateDoc(doc(db,'announcements',id), { pinned: !currentPinned });
  toast(currentPinned ? 'Откреплено' : 'Закреплено');
}

async function deleteAnnouncement(id) {
  if (!confirm('Удалить объявление?')) return;
  await deleteDoc(doc(db,'announcements',id));
  toast('Удалено');
}
/* ==================== ПООЩРЕНИЯ ==================== */
function giveAward(uid) {
  const target = cachedUsers.find(u => u.uid === uid);
  if (!target) return;
  if (target.rank === 'Гражданский') {
    return toast('Нельзя выдать поощрение гражданскому','err');
  }

  let type = 'thanks';
  let showAmount = false;

  openModal(`
    <h3>⭐ Выдать поощрение</h3>
    <p class="modal-sub">Сотрудник: <strong style="color:var(--accent)">${escapeHtml(target.nickname)}</strong> · ${escapeHtml(target.rank)}</p>

    <div class="form-group">
      <label>Тип</label>
      <div class="severity-picker" style="grid-template-columns:1fr 1fr">
        <button type="button" class="sev-btn active" data-award="thanks">🏅 Благодарность</button>
        <button type="button" class="sev-btn" data-award="bonus">💰 Премия</button>
      </div>
    </div>

    <div class="form-group" id="award-amount-group" style="display:none">
      <label>Сумма премии (exp)</label>
      <input id="award-amount" type="number" min="1" placeholder="50000">
    </div>

    <div class="form-group">
      <label>Формулировка</label>
      <textarea id="award-reason" placeholder="Например: за образцовое поведение при задержании..." style="min-height:80px"></textarea>
    </div>

    <div class="modal-actions">
      <button class="btn secondary" data-cancel>Отмена</button>
      <button class="btn" data-confirm>Выдать</button>
    </div>
  `, (overlay, close) => {
    // Переключение типа
    overlay.querySelectorAll('[data-award]').forEach(btn => {
      btn.onclick = () => {
        overlay.querySelectorAll('[data-award]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        type = btn.dataset.award;
        showAmount = (type === 'bonus');
        overlay.querySelector('#award-amount-group').style.display = showAmount ? 'block' : 'none';
      };
    });

    overlay.querySelector('[data-cancel]').onclick = close;

    overlay.querySelector('[data-confirm]').onclick = async () => {
      const reason = overlay.querySelector('#award-reason').value.trim();
      if (!reason) return toast('Укажи формулировку','err');

      let amount = 0;
      if (showAmount) {
        amount = parseInt(overlay.querySelector('#award-amount').value, 10);
        if (!amount || amount < 1) return toast('Укажи сумму премии','err');
      }

      const award = {
        id: Date.now().toString(),
        type,
        reason,
        amount,
        from: currentProfile.nickname,
        fromRank: currentProfile.rank,
        date: new Date().toISOString()
      };
      await updateDoc(doc(db,'users',uid), { awards: arrayUnion(award) });
      close();
      toast(type === 'bonus' ? 'Премия выдана' : 'Благодарность выдана');
    };
  });
}

async function removeAward(uid, awardId) {
  const u = cachedUsers.find(x => x.uid === uid);
  if (!u) return;

  const award = (u.awards || []).find(a => a.id === awardId);
  if (!award) return toast('Поощрение не найдено','err');

  const typeInfo = AWARD_TYPES[award.type];
  openModal(`
    <h3>Снять поощрение?</h3>
    <p class="modal-sub">
      Сотрудник: <strong style="color:var(--accent)">${escapeHtml(u.nickname)}</strong><br>
      Тип: <strong>${typeInfo?.label || award.type}</strong>
      ${award.amount ? `<br>Сумма: <strong>${award.amount.toLocaleString('ru-RU')} exp</strong>` : ''}<br>
      Формулировка: ${escapeHtml(award.reason)}<br>
      Выдал: ${escapeHtml(award.from)} · ${fmtDate(award.date)}
    </p>
    <div class="modal-actions">
      <button class="btn secondary" data-cancel>Отмена</button>
      <button class="btn danger" data-confirm>Снять</button>
    </div>
  `, (overlay, close) => {
    overlay.querySelector('[data-cancel]').onclick = close;
    overlay.querySelector('[data-confirm]').onclick = async () => {
      const newAwards = (u.awards || []).filter(a => a.id !== awardId);
      await updateDoc(doc(db,'users',uid), { awards: newAwards });
      close();
      toast('Поощрение снято');
    };
  });
}
/* ==================== СБРОС ПАРОЛЕЙ ==================== */
function subscribeResets() {
  if (resetsUnsub) resetsUnsub();
  resetsUnsub = onSnapshot(
    collection(db,'passwordResets'),
    snap => {
      cachedResets = [];
      snap.forEach(d => cachedResets.push({ id: d.id, ...d.data() }));
      cachedResets.sort((a,b) => (b.createdAt?.seconds||0) - (a.createdAt?.seconds||0));
      if (location.hash === '#/passwords') render();
    },
    err => {
      if (err?.code === 'permission-denied') return;
      console.warn('resets listener:', err);
    }
  );
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
function createInvite() {
  const availableRoles = rolesIAssignViaInvite(currentProfile);
  if (availableRoles.length === 0) {
    return toast('У тебя нет права создавать приглашения', 'err');
  }

  let selectedRole = availableRoles[0];

  openModal(`
    <h3>🔑 Новое приглашение</h3>
    <p class="modal-sub">Создай код для регистрации нового игрока</p>

    <div class="form-group">
      <label>Роль</label>
      <select id="inv-role">
        ${availableRoles.map(r => `<option value="${r}">${r}</option>`).join('')}
      </select>
    </div>

    <div class="form-group">
      <label>Действует (часов)</label>
      <input id="inv-hours" type="number" min="1" max="168" value="1">
    </div>

    <div class="form-group">
      <label>Максимум использований</label>
      <input id="inv-maxuses" type="number" min="1" max="50" value="5">
    </div>

    <div class="modal-actions">
      <button class="btn secondary" data-cancel>Отмена</button>
      <button class="btn" data-confirm>Создать</button>
    </div>
  `, (overlay, close) => {
    overlay.querySelector('#inv-role').onchange = e => { selectedRole = e.target.value; };

    overlay.querySelector('[data-cancel]').onclick = close;

    overlay.querySelector('[data-confirm]').onclick = async () => {
      const role = overlay.querySelector('#inv-role').value;
      const hours = parseInt(overlay.querySelector('#inv-hours').value, 10);
      const maxUses = parseInt(overlay.querySelector('#inv-maxuses').value, 10);

      if (!ROLES[role]) return toast('Неверная роль', 'err');
      if (!hours || hours < 1) return toast('Срок минимум 1 час', 'err');
      if (!maxUses || maxUses < 1) return toast('Минимум 1 использование', 'err');

      const code = genCode();
      const expiresAt = new Date(Date.now() + hours * 3600 * 1000);

      await addDoc(collection(db,'invites'), {
        code,
        role,
        expiresAt: expiresAt.toISOString(),
        maxUses,
        usedCount: 0,
        usedBy: [],
        createdBy: currentUser.uid,
        createdByNick: currentProfile.nickname,
        createdByRank: currentProfile.rank,
        createdAt: serverTimestamp()
      });

      close();
      toast('Код создан: ' + code);
    };
  });
}

async function deleteInvite(id) {
  if (!confirm('Удалить приглашение?')) return;
  await deleteDoc(doc(db,'invites',id));
  toast('Приглашение удалено');
}

/* ==================== ЗАДЕРЖАНИЯ И ШТРАФЫ ==================== */
function subscribeDetentions() {
  if (detentionsUnsub) detentionsUnsub();
  detentionsUnsub = onSnapshot(
    query(collection(db,'detentions'), orderBy('createdAt','desc')),
    snap => {
      cachedDetentions = [];
      snap.forEach(d => cachedDetentions.push({ id: d.id, ...d.data() }));
      if (location.hash === '#/detentions') render();
    },
    err => {
      if (err?.code === 'permission-denied') return;
      console.warn('detentions listener:', err);
    }
  );
}

function subscribeFines() {
  if (finesUnsub) finesUnsub();
  finesUnsub = onSnapshot(
    query(collection(db,'fines'), orderBy('createdAt','desc')),
    snap => {
      cachedFines = [];
      snap.forEach(d => cachedFines.push({ id: d.id, ...d.data() }));
      if (location.hash === '#/fines') render();
    },
    err => {
      if (err?.code === 'permission-denied') return;
      console.warn('fines listener:', err);
    }
  );
}

// ---- Мультивыбор статей ----
function lawLabel(law) {
  const stars = law.wantedLevel > 0 ? ' ' + '★'.repeat(law.wantedLevel) : '';
  return `${law.code} · ${law.title}${stars}`;
}

// Отображение звёзд с поддержкой диапазона (напр. 16.15: ★–★★★★★)
function formatStars(law) {
  if (!law || !law.wantedLevel) return '';
  if (law.wantedLevelMin && law.wantedLevelMin < law.wantedLevel) {
    return '★'.repeat(law.wantedLevelMin) + '–' + '★'.repeat(law.wantedLevel);
  }
  return '★'.repeat(law.wantedLevel);
}

function renderArticleSearch(inputId, resultsId, selectedId, stateKey) {
  const filter = lawTypeFilter[stateKey] || 'all';
  return `
    <div class="form-group">
      <label>Статьи</label>
      <div class="law-type-tabs">
        <button type="button" class="law-type-tab ${filter === 'all' ? 'active' : ''}"
                data-law-type="${stateKey}:all">Все</button>
        <button type="button" class="law-type-tab ${filter === 'УК' ? 'active' : ''}"
                data-law-type="${stateKey}:УК">УК</button>
        <button type="button" class="law-type-tab ${filter === 'АК' ? 'active' : ''}"
                data-law-type="${stateKey}:АК">АК</button>
        <button type="button" class="law-type-tab ${filter === 'ДК' ? 'active' : ''}"
                data-law-type="${stateKey}:ДК">ДК</button>
      </div>
      <div class="law-search-wrap">
        <input id="${inputId}" type="text" placeholder="Номер статьи или название (например: 17.6 или неповиновение)" autocomplete="off">
        <button type="button" class="law-search-clear" data-clear-for="${inputId}" title="Очистить">×</button>
      </div>
      <div id="${resultsId}" class="law-results"></div>
      <div id="${selectedId}" class="law-selected"></div>
      <div id="${selectedId}-summary" class="law-summary"></div>
    </div>
  `;
}

function updateLawResults(inputId, resultsId, stateKey) {
  const input = document.getElementById(inputId);
  const box = document.getElementById(resultsId);
  if (!input || !box) return;

  const q = input.value.trim().toLowerCase();
  const filter = lawTypeFilter[stateKey] || 'all';

  // Если поиск пуст — ничего не показываем
  if (!q) { box.innerHTML = ''; return; }

  const current = stateKey === 'detentions' ? selectedArticles : selectedArticlesFine;
  const matches = LAWS.filter(l => {
    if (current.some(a => a.code === l.code)) return false;
    // Фильтр по типу
    if (filter !== 'all' && l.codeType !== filter) return false;
    return l.code.toLowerCase().includes(q) ||
           l.title.toLowerCase().includes(q);
  }).slice(0, 20);

  if (matches.length === 0) {
    // Если в выбранном кодексе вообще нет статей — так и говорим
    const hasAnyInType = LAWS.some(l => filter === 'all' || l.codeType === filter);
    if (!hasAnyInType && filter !== 'all') {
      box.innerHTML = `<div class="law-empty">В кодексе ${escapeHtml(filter)} пока нет статей</div>`;
    } else {
      box.innerHTML = '<div class="law-empty">Ничего не найдено</div>';
    }
    return;
  }

  box.innerHTML = matches.map(l => `
    <div class="law-row" data-add="${l.code}">
      <button type="button" class="law-btn add" title="Добавить">+</button>
      <span class="law-code">${escapeHtml(l.code)}</span>
      <span class="law-type">${escapeHtml(l.codeType)}</span>
      <span class="law-title">${escapeHtml(l.title)}</span>
      ${l.wantedLevel ? `<span class="law-stars">${formatStars(l)}</span>` : ''}
      <button type="button" class="law-btn info"
              data-info-code="${escapeHtml(l.code)}"
              data-info-type="${escapeHtml(l.codeType)}"
              title="Открыть статью">?</button>
    </div>
  `).join('');

  box.querySelectorAll('[data-add]').forEach(row => {
    row.onclick = (e) => {
      if (e.target.closest('[data-info-code]')) return;   // клик по «?» — не добавляем
      addLawToSelection(row.dataset.add, stateKey);
    };
  });

  box.querySelectorAll('[data-info-code]').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      goToLawArticle(btn.dataset.infoType, btn.dataset.infoCode);
    };
  });
}

function addLawToSelection(code, stateKey) {
  const law = LAWS.find(l => l.code === code);
  if (!law) return;
  const arr = stateKey === 'detentions' ? selectedArticles : selectedArticlesFine;
  if (arr.some(a => a.code === code)) return;
  arr.push(law);
  refreshLawSelection(stateKey);
}

function removeLawFromSelection(code, stateKey) {
  const arr = stateKey === 'detentions' ? selectedArticles : selectedArticlesFine;
  const idx = arr.findIndex(a => a.code === code);
  if (idx >= 0) arr.splice(idx, 1);
  refreshLawSelection(stateKey);
}

function refreshLawSelection(stateKey) {
  const arr = stateKey === 'detentions' ? selectedArticles : selectedArticlesFine;
  const selId = stateKey === 'detentions' ? 'd-articles-selected' : 'f-articles-selected';
  const sumId = selId + '-summary';
  const selBox = document.getElementById(selId);
  const sumBox = document.getElementById(sumId);
  if (!selBox) return;

  if (arr.length === 0) {
    selBox.innerHTML = '<div class="law-empty">Статьи не выбраны</div>';
    if (sumBox) sumBox.innerHTML = '';
    return;
  }

  selBox.innerHTML = `
    <div class="law-selected-title">Выбрано (${arr.length}):</div>
    ${arr.map(l => `
      <div class="law-row selected">
        <button type="button" class="law-btn remove" data-rm="${l.code}">−</button>
        <span class="law-code">${escapeHtml(l.code)}</span>
        <span class="law-type">${escapeHtml(l.codeType)}</span>
        <span class="law-title">${escapeHtml(l.title)}</span>
        ${l.wantedLevel ? `<span class="law-stars">${formatStars(l)}</span>` : ''}
      </div>
    `).join('')}
  `;

  selBox.querySelectorAll('[data-rm]').forEach(row => {
    row.onclick = () => removeLawFromSelection(row.dataset.rm, stateKey);
  });

  // Итог
  if (sumBox) {
    const totalMonths = arr.reduce((s, l) => s + (l.prisonMonths || 0), 0);
    const totalFineMin = arr.reduce((s, l) => s + (l.fineMin || 0), 0);
    const totalFineMax = arr.reduce((s, l) => s + (l.fineMax || 0), 0);
    const maxWanted = Math.max(...arr.map(l => l.wantedLevel || 0));

    if (stateKey === 'detentions') {
      // Ограничиваем рекомендуемый срок максимумом
      const cappedMonths = Math.min(totalMonths, DETENTION_MAX_PRISON_MINUTES);
      const wasCapped = totalMonths > DETENTION_MAX_PRISON_MINUTES;

      sumBox.innerHTML = `
        <div class="law-total">
          ⏱ Рекомендуемый срок: <strong>${cappedMonths} мин</strong>
          ${wasCapped
            ? `<span style="color:var(--danger);margin-left:6px">⚠️ по статьям ${totalMonths} мин, ограничено максимумом ${DETENTION_MAX_PRISON_MINUTES}</span>`
            : `(макс. ${DETENTION_MAX_PRISON_MINUTES})`}
          ${maxWanted ? ` · Розыск: <strong>${'★'.repeat(maxWanted)}</strong>` : ''}
        </div>
      `;
      // Автоподстановка в поле срока (всегда ограничиваем максимумом)
      const prisonInput = document.getElementById('d-prison');
      if (prisonInput && !prisonInput.value) {
        prisonInput.value = cappedMonths;
      }
    } else {
      sumBox.innerHTML = `
        <div class="law-total">
          💰 Штраф: <strong>${totalFineMin.toLocaleString('ru-RU')} – ${totalFineMax.toLocaleString('ru-RU')} exp</strong>
          ${maxWanted ? ` · Розыск: <strong>${'★'.repeat(maxWanted)}</strong>` : ''}
        </div>
      `;
    }
  }
}

// ---- Подача задержания ----
async function submitDetention() {
  const target = document.getElementById('d-target').value.trim();
  const prison = parseInt(document.getElementById('d-prison').value, 10);
  const comment = document.getElementById('d-comment').value.trim();

  if (!target) return toast('Укажи ФИО задержанного','err');
  if (selectedArticles.length === 0) return toast('Выбери хотя бы одну статью','err');
  if (!prison || prison < 1) {
    return toast('Срок должен быть не менее 1 минуты','err');
  }
  if (prison > DETENTION_MAX_PRISON_MINUTES) {
    return toast(`Срок не может превышать ${DETENTION_MAX_PRISON_MINUTES} минут`,'err');
  }

  // Предупреждение, если срок сильно отклоняется от рекомендации
  const recommended = selectedArticles.reduce((s,l) => s + (l.prisonMonths || 0), 0);
  if (recommended > 0 && (prison < recommended * 0.5 || prison > recommended * 1.5)) {
    if (!confirm(`Рекомендуемый срок по статьям: ${recommended} мин.\nТы ставишь ${prison} мин.\nУверен?`)) return;
  }

  const partners = getPartnerObjects('detentions');
  const partnerUids = partners.map(p => p.uid);

  let uploaded = [];
  if (pendingFiles.detentions.length > 0) {
    toast('Загрузка файлов...');
    uploaded = await uploadAllFiles(pendingFiles.detentions, 'detentions');
  }

  await addDoc(collection(db,'detentions'), {
    target,
    articles: selectedArticles.map(l => ({
      code: l.code, codeType: l.codeType, title: l.title,
      prisonMonths: l.prisonMonths || 0,
      wantedLevel: l.wantedLevel || 0
    })),
    prisonMinutes: prison,
    recommendedMinutes: recommended,
    authorUid: currentUser.uid,
    authorNick: currentProfile.nickname,
    authorRank: currentProfile.rank,
    partners,
    partnerUids,
    files: uploaded,
    comment,
    status: 'pending',
    reviewComment: '',
    reviewedBy: null,
    reviewedAt: null,
    releasedEarly: null,
    edits: [],
    createdAt: serverTimestamp()
  });

  toast('Задержание записано');
  selectedArticles = [];
  refreshLawSelection('detentions');
  document.getElementById('d-target').value = '';
  document.getElementById('d-prison').value = '';
  document.getElementById('d-comment').value = '';
  pendingFiles.detentions = [];
  refreshUploadList('detentions');
  selectedPartners.detentions = [];
  refreshPartnerChips('detentions');
  clearDraft('detentions');
}

// ---- Подача штрафа ----
async function submitFine() {
  const target = document.getElementById('f-target').value.trim();
  const amount = parseInt(document.getElementById('f-amount').value, 10);
  const comment = document.getElementById('f-comment').value.trim();

  if (!target) return toast('Укажи ФИО','err');
  if (selectedArticlesFine.length === 0) return toast('Выбери статью','err');
  if (!amount || amount < 1) return toast('Укажи сумму штрафа','err');

  const totalMin = selectedArticlesFine.reduce((s,l) => s + (l.fineMin || 0), 0);
  const totalMax = selectedArticlesFine.reduce((s,l) => s + (l.fineMax || 0), 0);
  if (totalMin > 0 && (amount < totalMin || amount > totalMax)) {
    if (!confirm(`Рекомендуемый штраф: ${totalMin}–${totalMax} exp.\nТы ставишь ${amount} exp.\nУверен?`)) return;
  }

  const partners = getPartnerObjects('fines');   // ← ИСПРАВИЛ: было 'detentions'
  const partnerUids = partners.map(p => p.uid);

  // Загрузка файлов (ДО addDoc!)
  let uploaded = [];
  if (pendingFiles.fines.length > 0) {
    toast('Загрузка файлов...');
    uploaded = await uploadAllFiles(pendingFiles.fines, 'fines');
  }

  await addDoc(collection(db,'fines'), {
    target,
    articles: selectedArticlesFine.map(l => ({
      code: l.code, codeType: l.codeType, title: l.title,
      fineMin: l.fineMin || 0, fineMax: l.fineMax || 0,
      wantedLevel: l.wantedLevel || 0
    })),
    amount,
    recommendedMin: totalMin,
    recommendedMax: totalMax,
    authorUid: currentUser.uid,
    authorNick: currentProfile.nickname,
    authorRank: currentProfile.rank,
    partners,
    partnerUids,
    files: uploaded,
    comment,
    status: 'pending',
    reviewComment: '',
    reviewedBy: null,
    reviewedAt: null,
    edits: [],
    createdAt: serverTimestamp()
  });

  toast('Штраф записан');
  selectedArticlesFine = [];
  refreshLawSelection('fines');
  document.getElementById('f-target').value = '';
  document.getElementById('f-amount').value = '';
  document.getElementById('f-comment').value = '';
  pendingFiles.fines = [];
  refreshUploadList('fines');
  selectedPartners.fines = [];            
  refreshPartnerChips('fines');             
  clearDraft('fines');
}

// ---- Статусы и действия ----
async function reviewDetention(collectionName, id, status) {
  const comment = prompt(
    status === 'accepted' ? 'Комментарий к принятию (необязательно):' : 'Причина отклонения (необязательно):',
    ''
  );
  if (comment === null) return;
  await updateDoc(doc(db, collectionName, id), {
    status,
    reviewComment: comment.trim(),
    reviewedBy: currentProfile.nickname,
    reviewedAt: serverTimestamp()
  });
  toast(status === 'accepted' ? 'Принято' : 'Отклонено');
}

async function deleteDetentionRecord(collectionName, id) {
  if (!confirm('Удалить запись?')) return;
  await deleteDoc(doc(db, collectionName, id));
  toast('Удалено');
}

async function releaseEarly(collectionName, id) {
  const reason = prompt('Причина досрочного освобождения:', '');
  if (reason === null) return;
  await updateDoc(doc(db, collectionName, id), {
    releasedEarly: {
      by: currentProfile.nickname,
      rank: currentProfile.rank,
      at: new Date().toISOString(),
      reason: reason.trim() || '—'
    }
  });
  toast('Освобождён досрочно');
}

// ---- Время: можно ли редактировать автору ----
function canAuthorEdit(record) {
  if (!record.createdAt) return false;
  const ts = record.createdAt.toDate ? record.createdAt.toDate() : new Date(record.createdAt);
  return (Date.now() - ts.getTime()) < DETENTION_EDIT_HOURS * 3600 * 1000;
}

function canEditRecord(record) {
  if (!currentProfile) return false;
  // Подполковник+ может редактировать всегда
  if (canEditAnyDetention(currentProfile)) return true;
  // Автор может, если 36 часов не прошли и запись не принята
  if (record.authorUid === currentUser.uid &&
      canAuthorEdit(record) &&
      record.status !== 'accepted') return true;
  return false;
}

async function editDetention(collectionName, id) {
  const record = (collectionName === 'detentions' ? cachedDetentions : cachedFines)
    .find(r => r.id === id);
  if (!record) return;

  const reason = prompt('Причина редактирования (обязательно):', '');
  if (!reason || !reason.trim()) return toast('Нужна причина','err');

  const fieldName = collectionName === 'detentions' ? 'Срок (мин)' : 'Сумма штрафа (exp)';
  const currentValue = collectionName === 'detentions' ? record.prisonMinutes : record.amount;

  const newVal = prompt(`${fieldName} (текущее: ${currentValue}):`, String(currentValue));
  if (newVal === null) return;
  const numVal = parseInt(newVal, 10);
  if (!numVal || numVal < 1) return toast('Некорректное значение','err');
  if (collectionName === 'detentions' && numVal > DETENTION_MAX_PRISON_MINUTES) {
    return toast(`Максимум ${DETENTION_MAX_PRISON_MINUTES} минут`,'err');
  }

  const edit = {
    by: currentProfile.nickname,
    rank: currentProfile.rank,
    at: new Date().toISOString(),
    reason: reason.trim(),
    changes: collectionName === 'detentions'
      ? `Срок: ${currentValue} → ${numVal}`
      : `Штраф: ${currentValue} → ${numVal}`
  };

  const update = collectionName === 'detentions'
    ? { prisonMinutes: numVal, edits: [...(record.edits || []), edit] }
    : { amount: numVal, edits: [...(record.edits || []), edit] };

  await updateDoc(doc(db, collectionName, id), update);
  toast('Отредактировано');
}

/* ==================== НАВИГАЦИЯ ==================== */
function buildNav() {
  const nav = document.getElementById('nav');
  const p = currentProfile;

  // Группируем документы по категориям (как в data.js)
  const docGroups = {};
  DOCS.forEach(d => { (docGroups[d.category] ||= []).push(d); });

  let html = '';

  // ===== 🎯 ГЛАВНОЕ =====
  {
    const items = [];
    items.push(`<a class="nav-link" data-route="#/home">🏠 Главная</a>`);

    if (isPolice(p) || canReview(p)) {
      items.push(`<a class="nav-link" data-route="#/reports">📝 Отчёты</a>`);
    }
    if (isPolice(p) || canReview(p) || canManageStaff(p)) {
      items.push(`<a class="nav-link" data-route="#/registry/detentions">⚖️ Реестр</a>`);
    }

    if (items.length > 0) {
      html += `<div class="nav-group">
        <div class="nav-group-title">🎯 Главное</div>
        ${items.join('')}
      </div>`;
    }
  }

  // ===== ⚙️ УПРАВЛЕНИЕ =====
  {
    const items = [];

    if (canViewStaff(p)) {
      items.push(`<a class="nav-link" data-route="#/staff">👮 Кадры</a>`);
    }
    if (canViewDashboard(p)) {
      items.push(`<a class="nav-link" data-route="#/dashboard">📊 Дашборд</a>`);
    }
    if (canManageStaff(p)) {
      items.push(`<a class="nav-link" data-route="#/invites">🔑 Приглашения</a>`);
    }
    if (canResetPasswords(p)) {
      items.push(`<a class="nav-link" data-route="#/passwords">🔐 Сброс паролей</a>`);
    }

    if (items.length > 0) {
      html += `<div class="nav-group">
        <div class="nav-group-title">⚙️ Управление</div>
        ${items.join('')}
      </div>`;
    }
  }

  // ===== 💬 ОБЩЕЕ =====
  {
    const items = [];

    if (isPolice(p) || canReview(p) || canManageStaff(p)) {
      const unreadDot = hasUnreadAnnouncements() ? '<span class="nav-unread-dot"></span>' : '';
      items.push(`<a class="nav-link" data-route="#/announcements">📢 Объявления ${unreadDot}</a>`);
    }
    // Тесты — видны всем
    items.push(`<a class="nav-link" data-route="#/tests">🎓 Тесты</a>`);

    if (items.length > 0) {
      html += `<div class="nav-group">
        <div class="nav-group-title">💬 Общее</div>
        ${items.join('')}
      </div>`;
    }
  }

  // ===== 🛡️ ФРАКЦИЯ =====
  if (docGroups['Фракция']) {
    html += `<div class="nav-group">
      <div class="nav-group-title">🛡️ Фракция</div>`;
    docGroups['Фракция'].forEach(d => {
      html += `<a class="nav-link" data-route="#/doc/${d.id}">📄 ${d.title}</a>`;
    });
    html += `</div>`;
  }

  // ===== ⚖️ ЗАКОНОДАТЕЛЬНАЯ БАЗА =====
  if (docGroups['Законодательная база']) {
    html += `<div class="nav-group">
      <div class="nav-group-title">⚖️ Законодательная база</div>`;
    docGroups['Законодательная база'].forEach(d => {
      html += `<a class="nav-link" data-route="#/doc/${d.id}">📄 ${d.title}</a>`;
    });
    html += `</div>`;
  }

  // ===== 📎 ДОПОЛНИТЕЛЬНО =====
  if (docGroups['Дополнительно']) {
    html += `<div class="nav-group">
      <div class="nav-group-title">📎 Дополнительно</div>`;
    docGroups['Дополнительно'].forEach(d => {
      html += `<a class="nav-link" data-route="#/doc/${d.id}">📄 ${d.title}</a>`;
    });
    html += `</div>`;
  }

  // ===== 📜 ПРАВИЛА СЕРВЕРА =====
  if (docGroups['Правила сервера']) {
    html += `<div class="nav-group">
      <div class="nav-group-title">📜 Правила сервера</div>`;
    docGroups['Правила сервера'].forEach(d => {
      html += `<a class="nav-link" data-route="#/doc/${d.id}">📄 ${d.title}</a>`;
    });
    html += `</div>`;
  }

  // ===== Остальные категории, если появятся =====
  const usedCategories = ['Фракция', 'Законодательная база', 'Дополнительно', 'Правила сервера'];
  for (const [cat, items] of Object.entries(docGroups)) {
    if (usedCategories.includes(cat)) continue;
    html += `<div class="nav-group">
      <div class="nav-group-title">${cat}</div>`;
    items.forEach(d => {
      html += `<a class="nav-link" data-route="#/doc/${d.id}">📄 ${d.title}</a>`;
    });
    html += `</div>`;
  }

  // ===== Кнопка «Выйти» на мобильных =====
  html += `
    <div class="nav-group nav-logout-group">
      <button class="btn secondary nav-logout-btn" id="navLogout">🚪 Выйти</button>
    </div>
  `;

  nav.innerHTML = html;
  nav.querySelectorAll('.nav-link').forEach(l => {
    l.onclick = () => { location.hash = l.dataset.route; };
  });

  document.getElementById('navLogout')?.addEventListener('click', () => {
    document.getElementById('btnLogout')?.click();
  });
}

/* ==================== ОТРИСОВКА ==================== */
function renderHome() {
  const warnings = currentProfile.warnings || [];
  const p = currentProfile;

  // Считаем статистику за последние 7 дней
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 3600 * 1000;
  const toMs = r => {
    const t = r.createdAt;
    return t?.toDate ? t.toDate().getTime() : new Date(t || 0).getTime();
  };
  const isMine = r => {
    if (r.authorUid === currentUser?.uid) return true;
    if (Array.isArray(r.partnerUids) && r.partnerUids.includes(currentUser?.uid)) return true;
    return false;
  };

  const myReports    = cachedReports.filter(r => isMine(r) && toMs(r) >= weekAgo).length;
  const myDetentions = cachedDetentions.filter(r => isMine(r) && toMs(r) >= weekAgo).length;
  const myFines      = cachedFines.filter(r => isMine(r) && toMs(r) >= weekAgo).length;

  const showStats = isPolice(p) || canReview(p) || canManageStaff(p);

  // Собираем карточки по тем же правилам, что и меню
  const cards = [];

  // Общие — для всех
  cards.push(`
    <div class="card" onclick="location.hash='#/doc/ustav'">
      <h4>📕 Устав</h4><p>Права и обязанности сотрудников.</p>
    </div>
    <div class="card" onclick="location.hash='#/doc/uk'">
      <h4>⚖️ Уголовный Кодекс</h4><p>Преступления и наказания.</p>
    </div>
  `);

  // Тесты — всем
  cards.push(`
    <div class="card" onclick="location.hash='#/tests'">
      <h4>🎓 Тесты</h4><p>Проверь знание устава.</p>
    </div>
  `);

  // Отчёты — полиции и тем, кто может проверять
  if (isPolice(p) || canReview(p)) {
    cards.push(`
      <div class="card" onclick="location.hash='#/reports'">
        <h4>📝 Отчёты</h4><p>Сдать рапорт или просмотреть общие.</p>
      </div>
    `);
  }

  // Кадры — полиции, начальству и Правительству/Администрации (просмотр)
  if (canViewStaff(p)) {
    cards.push(`
      <div class="card" onclick="location.hash='#/staff'">
        <h4>👮 Кадры</h4><p>Состав фракции${canManageStaff(p) ? ' и управление' : ''}.</p>
      </div>
    `);
  }

  // Приглашения
  if (canManageStaff(p)) {
    cards.push(`
      <div class="card" onclick="location.hash='#/invites'">
        <h4>🔑 Приглашения</h4><p>Коды для регистрации новичков.</p>
      </div>
    `);
  }

  // Сброс паролей
  if (canResetPasswords(p)) {
    cards.push(`
      <div class="card" onclick="location.hash='#/passwords'">
        <h4>🔐 Сброс паролей</h4><p>Запросы на восстановление доступа.</p>
      </div>
    `);
  }

  return `
    <h2>Добро пожаловать, ${escapeHtml(p.nickname)}</h2>
    <p class="doc-meta">Твоя роль: <strong style="color:var(--accent)">${escapeHtml(p.rank)}</strong></p>

    ${showStats ? `
      <div class="home-stats">
        <div class="home-stat-card" onclick="location.hash='#/reports'">
          <div class="home-stat-icon">📝</div>
          <div class="home-stat-body">
            <div class="home-stat-num">${myReports}</div>
            <div class="home-stat-lbl">Отчётов за 7 дней</div>
          </div>
        </div>
        <div class="home-stat-card" onclick="location.hash='#/registry/detentions'">
          <div class="home-stat-icon">📋</div>
          <div class="home-stat-body">
            <div class="home-stat-num">${myDetentions}</div>
            <div class="home-stat-lbl">Задержаний за 7 дней</div>
          </div>
        </div>
        <div class="home-stat-card" onclick="location.hash='#/registry/fines'">
          <div class="home-stat-icon">💰</div>
          <div class="home-stat-body">
            <div class="home-stat-num">${myFines}</div>
            <div class="home-stat-lbl">Штрафов за 7 дней</div>
          </div>
        </div>
      </div>
    ` : ''}

    ${(() => {
      const a = analyzeWarnings(warnings);
      if (!a.riskLevel) return '';
      const cls = a.riskLevel === 'danger' ? 'danger' : a.riskLevel === 'warning' ? 'warning' : 'notice';
      return `
        <div class="home-discipline home-discipline-${cls}">
          <div class="home-discipline-icon">
            ${a.riskLevel === 'danger' ? '🚨' : a.riskLevel === 'warning' ? '⚠️' : '⚡'}
          </div>
          <div class="home-discipline-body">
            <div class="home-discipline-title">${escapeHtml(a.riskLabel)}</div>
            <div class="home-discipline-meta">${escapeHtml(a.description)}</div>
          </div>
        </div>
      `;
    })()}

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

    <div class="cards">${cards.join('')}</div>
  `;
}

function renderDoc(id) {
  const d = DOCS.find(x => x.id === id);
  if (!d) return `<h2>Документ не найден</h2>`;

  // Оглавление показываем только для крупных кодексов
  const DOCS_WITH_TOC = ['uk', 'ak', 'pk', 'dk'];
  const showTOC = DOCS_WITH_TOC.includes(id);
  const chapters = showTOC ? buildDocTOC(d.content) : [];
  const tocHTML = renderDocTOC(chapters);

  setTimeout(() => {
    if (!showTOC) return;

    // Сворачивание/разворачивание оглавления
    const toggle = document.getElementById('docTocToggle');
    const box = document.querySelector('.doc-toc');
    if (toggle && box) {
      toggle.onclick = () => box.classList.toggle('collapsed');
    }

    // Клик по пункту оглавления — скролл + подсветка
    document.querySelectorAll('[data-toc-idx]').forEach(link => {
      link.onclick = (e) => {
        e.preventDefault();
        const idx = parseInt(link.dataset.tocIdx, 10);
        const el = document.querySelector(`[data-search-idx="${idx}"]`);
        if (!el) return;

        // Считаем отступ = высота sticky-шапки + немного воздуха
        const topbar = document.querySelector('.topbar');
        const offset = (topbar?.offsetHeight || 70) + 16;

        // Позиция цели в документе, минус отступ
        const rect = el.getBoundingClientRect();
        const targetY = window.scrollY + rect.top - offset;

        window.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });

        const startHighlight = () => {
          el.classList.add('search-highlight');
          setTimeout(() => el.classList.remove('search-highlight'), 2000);
        };
        if ('onscrollend' in window) {
          window.addEventListener('scrollend', startHighlight, { once: true });
        } else {
          setTimeout(startHighlight, 2500);
        }
      };
    });
  }, 0);

  return `<h2>${escapeHtml(d.title)}</h2>
    <div class="doc-meta">Раздел: ${escapeHtml(d.category)}</div>
    ${tocHTML}
    <div class="doc-body">${formatDocContent(d.content)}</div>`;
}

// ===== Список глав документа (для оглавления) =====
// Индексы совпадают с data-search-idx в formatDocContent
function buildDocTOC(content) {
  const lines = String(content || '').split('\n');
  const chapters = [];
  let idx = -1;

  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    if (/^\[\[IMG:.+\]\]$/.test(t)) continue;
    if (/^═{3,}$/.test(t))          continue;

    if (/^ГЛАВА\s+[IVXLCDM\d]+[\.\s]/i.test(t)) {
      idx++;
      chapters.push({ idx, title: t, type: 'chapter' });
      continue;
    }
    if (/^(Полицейский Департамент|База SWAT|База Национальной Гвардии|Остров Губернатора)$/i.test(t)) {
      idx++;
      chapters.push({ idx, title: t, type: 'object' });
      continue;
    }
    if (/^(Статья\s+)?\d+(\.\d+)*\.?\s+\S/.test(t)) {
      idx++;
      continue;   // статьи не выводим в TOC
    }
  }
  return chapters;
}

// ===== Рендер оглавления =====
// ===== Римские → арабские (только для оглавления) =====
const ROMAN_MAP = {
  'I': 1, 'II': 2, 'III': 3, 'IV': 4, 'V': 5,
  'VI': 6, 'VII': 7, 'VIII': 8, 'IX': 9, 'X': 10,
  'XI': 11, 'XII': 12, 'XIII': 13, 'XIV': 14, 'XV': 15,
  'XVI': 16, 'XVII': 17, 'XVIII': 18, 'XIX': 19, 'XX': 20
};

function toArabicTOC(title) {
  return title.replace(/^ГЛАВА\s+([IVXLCDM]+)([\.\s])/i, (m, roman, sep) => {
    const num = ROMAN_MAP[roman.toUpperCase()];
    return num ? `ГЛАВА ${num}${sep}` : m;
  });
}

function renderDocTOC(chapters) {
  if (chapters.length === 0) return '';
  return `
    <div class="doc-toc">
      <div class="doc-toc-title" id="docTocToggle">
        <span>📖 Содержание</span>
        <span class="doc-toc-arrow">▾</span>
      </div>
      <ul class="doc-toc-list">
        ${chapters.map(c => `
          <li>
            <a class="doc-toc-link" data-toc-idx="${c.idx}">
              ${escapeHtml(toArabicTOC(c.title))}
            </a>
          </li>
        `).join('')}
      </ul>
    </div>
  `;
}

/* ==================== АВТО-РАЗМЕТКА ТЕКСТОВ ДОКУМЕНТОВ ==================== */
// Правила:
//   "ГЛАВА N. ..."                        → крупный заголовок главы
//   "N.M. Название" / "Статья N.M ..."    → заголовок статьи
//   "Полицейский Департамент" и т.п.      → заголовок объекта (Глава 2 zzt)
//   "═══════"                             → горизонтальный разделитель
//   "[[IMG:путь]]"                        → картинка
//   всё остальное                         → обычный текст
function formatDocContent(content) {
  const lines = String(content || '').split('\n');
  const out = [];
  let buffer = [];
  let blockIdx = -1;   // -1 = до первого заголовка (не скроллится)

  const flush = () => {
    if (!buffer.length) return;
    const attr = blockIdx >= 0 ? ` data-search-idx="${blockIdx}"` : '';
    out.push(`<p class="doc-p"${attr}>${escapeHtml(buffer.join('\n'))}</p>`);
    buffer = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const t = line.trim();

    if (!t) { flush(); continue; }

    // Картинка
    if (/^\[\[IMG:.+\]\]$/.test(t)) {
      flush();
      const url = t.slice(6, -2).trim();
      const imgAttr = blockIdx >= 0 ? ` data-search-idx="${blockIdx}"` : '';
      out.push(`<figure class="doc-image"${imgAttr}>
        <img src="${escapeHtml(url)}" alt="" loading="lazy">
      </figure>`);
      continue;
    }

    // Разделитель
    if (/^═{3,}$/.test(t)) {
      flush();
      out.push('<hr class="doc-hr">');
      continue;
    }

    // Глава
    if (/^ГЛАВА\s+[IVXLCDM\d]+[\.\s]/i.test(t)) {
      flush();
      blockIdx++;
      out.push(`<h2 class="doc-chapter" data-search-idx="${blockIdx}">${escapeHtml(t)}</h2>`);
      continue;
    }

    // Объекты в Главе 2 "Юрисдикция"
    if (/^(Полицейский Департамент|База SWAT|База Национальной Гвардии|Остров Губернатора)$/i.test(t)) {
      flush();
      blockIdx++;
      out.push(`<h3 class="doc-object" data-search-idx="${blockIdx}">${escapeHtml(t)}</h3>`);
      continue;
    }

    // Статья
    if (/^(Статья\s+)?\d+(\.\d+)*\.?\s+\S/.test(t)) {
      flush();
      blockIdx++;
      out.push(`<h3 class="doc-article" data-search-idx="${blockIdx}">${escapeHtml(t)}</h3>`);
      continue;
    }

    buffer.push(line);
  }
  flush();
  return out.join('');
}

// ===== Разбивка документа на «блоки-статьи» для умного поиска =====
// Логика индексов 1:1 совпадает с formatDocContent → data-search-idx
function splitDocIntoBlocks(content) {
  const lines = String(content || '').split('\n');
  const blocks = [];
  let current = null;
  let counter = 0;

  const ensureCurrent = () => {
    if (!current) {
      current = { idx: -1, title: '', type: 'intro', lines: [] };
      blocks.push(current);
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const t = line.trim();
    if (!t) { if (current) current.lines.push(''); continue; }

    if (/^\[\[IMG:.+\]\]$/.test(t)) { ensureCurrent(); current.lines.push(t); continue; }
    if (/^═{3,}$/.test(t))          { ensureCurrent(); current.lines.push(t); continue; }

    if (/^ГЛАВА\s+[IVXLCDM\d]+[\.\s]/i.test(t)) {
      current = { idx: counter++, title: t, type: 'chapter', lines: [t] };
      blocks.push(current); continue;
    }
    if (/^(Полицейский Департамент|База SWAT|База Национальной Гвардии|Остров Губернатора)$/i.test(t)) {
      current = { idx: counter++, title: t, type: 'object', lines: [t] };
      blocks.push(current); continue;
    }
    if (/^(Статья\s+)?\d+(\.\d+)*\.?\s+\S/.test(t)) {
      current = { idx: counter++, title: t, type: 'article', lines: [t] };
      blocks.push(current); continue;
    }

    ensureCurrent();
    current.lines.push(line);
  }
  return blocks;
}

/* ===== ПЕРЕХОД ИЗ ПОИСКА К КОНКРЕТНОЙ СТАТЬЕ ===== */
let pendingScrollBlockIdx = null;
let pendingScrollDocId    = null;

function goToDocBlock(docId, blockIdx) {
  pendingScrollDocId    = docId;
  pendingScrollBlockIdx = blockIdx;

  const targetHash = '#/doc/' + docId;
  if (location.hash === targetHash) {
    scrollToPendingBlock();
  } else {
    location.hash = targetHash;
  }
}

function scrollToPendingBlock() {
  if (pendingScrollBlockIdx == null) return;
  const idx = pendingScrollBlockIdx;
  pendingScrollBlockIdx = null;
  pendingScrollDocId    = null;

  if (idx < 0) return;

  setTimeout(() => {
    const el = document.querySelector(`[data-search-idx="${idx}"]`);
    if (!el) return;

    // Что запустить после остановки скролла
    const startHighlight = () => {
      el.classList.add('search-highlight');
      setTimeout(() => el.classList.remove('search-highlight'), 2000);
    };

    // Убираем прежние подписки (если поиск запускали повторно)
    if (window._searchScrollEnd) {
      window.removeEventListener('scrollend', window._searchScrollEnd);
      clearTimeout(window._searchScrollFallback);
      window._searchScrollEnd = null;
    }

    // Резервный таймаут — на случай, если scrollend не сработает (старый браузер)
    window._searchScrollFallback = setTimeout(startHighlight, 2500);

    // Ждём события «скролл закончился» — тогда и включаем подсветку
    if ('onscrollend' in window) {
      window._searchScrollEnd = () => {
        window.removeEventListener('scrollend', window._searchScrollEnd);
        clearTimeout(window._searchScrollFallback);
        window._searchScrollEnd = null;
        startHighlight();
      };
      window.addEventListener('scrollend', window._searchScrollEnd, { once: true });
    }

    // Сам плавный скролл — запускаем в конце
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 80);
}

/* ===== ПОИСК ===== */
function globalSearch(query) {
  const q = query.trim().toLowerCase();
  if (!q) { render(); return; }

  const results = [];
  DOCS.forEach(doc => {
    const blocks = splitDocIntoBlocks(doc.content);
    blocks.forEach(block => {
      const text = block.lines.join('\n');
      const lower = text.toLowerCase();
      const at = lower.indexOf(q);
      if (at < 0) return;

      const SNIPPET_MAX = 160;   // максимум символов в сниппете
      const start = Math.max(0, at - 60);
      const end   = Math.min(text.length, start + SNIPPET_MAX);
      const snippet =
        (start > 0 ? '…' : '') +
        text.slice(start, end).replace(/\s+/g, ' ') +
        (end < text.length ? '…' : '');

      results.push({
        docId:      doc.id,
        docTitle:   doc.title,
        blockIdx:   block.idx,
        blockTitle: block.title,
        snippet
      });
    });
  });

  const contentEl = document.getElementById('content');
  contentEl.innerHTML = `
    <h2>Результаты поиска</h2>
    <p class="doc-meta">Найдено: ${results.length} по «${escapeHtml(query)}»</p>
    ${results.length === 0 ? '<p class="doc-meta">Ничего не найдено.</p>' :
      results.map((r, i) => `
        <div class="search-result" data-search-result-idx="${i}">
          <h4>
            ${escapeHtml(r.docTitle)}
            ${r.blockTitle
              ? `<span style="color:var(--muted);font-weight:400;font-size:12px"> → ${escapeHtml(r.blockTitle)}</span>`
              : ''}
          </h4>
          <p>${escapeHtml(r.snippet)}</p>
        </div>
      `).join('')
    }
  `;

  contentEl.querySelectorAll('[data-search-result-idx]').forEach(el => {
    el.onclick = () => {
      const r = results[parseInt(el.dataset.searchResultIdx, 10)];
      goToDocBlock(r.docId, r.blockIdx);
    };
  });
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
    ${renderPartnerPicker('reports')}

    <div class="form-group">
      <label class="label-with-attach">
        Описание
        <button type="button" class="attach-btn" data-attach-for="reports">📎 Прикрепить</button>
      </label>
      <textarea id="r-desc" placeholder="Что произошло... (можно вставить фото через Ctrl+V)"></textarea>
      <input type="file" multiple accept="image/*,video/*,application/pdf"
             id="upload-input-reports" style="display:none">
      <div class="upload-list" id="upload-list-reports"></div>
    </div>

    ${renderTagPicker()}

    ${renderDraftIndicator('reports')}
    <button class="btn" id="btnSubmitReport">Отправить отчёт</button>
  ` : '';

  setTimeout(() => {
    document.getElementById('btnSubmitReport')?.addEventListener('click', submitReport);
    initFileUploaders();
    initTagPicker();
    initPartnerPicker('reports');

    initDraft('reports', {
      'r-type': 'type',
      'r-partner': 'partner',
      'r-desc': 'desc'
    });

    const draft = loadDraft('reports');
    if (draft && draft.tags && Array.isArray(draft.tags)) {
      selectedReportTags = draft.tags
        .map(id => REPORT_TAGS.find(t => t.id === id))
        .filter(Boolean);
      refreshTagsDisplay();
    }
  }, 0);

  if (reportsUnsub) reportsUnsub();
  const q = query(collection(db,'reports'), orderBy('createdAt','desc'));
  reportsUnsub = onSnapshot(q, snap => {
    lastReportsSnapshot = [];
    snap.forEach(d => lastReportsSnapshot.push({ id: d.id, ...d.data() }));
    renderReportsList();
  });

  return `<h2>Отчёты сотрудников</h2>
    <p class="doc-meta">${
      canReview(currentProfile)
        ? 'Ты видишь все отчёты и можешь их проверять'
        : 'Ты видишь свои отчёты и те, где ты был напарником'
    }</p>
    ${canSubmit ? `<h3 style="color:var(--accent);margin:20px 0 12px">Подать новый</h3>${form}` : ''}
    <div id="reportsList" style="margin-top:24px"><p class="doc-meta">Загрузка...</p></div>`;
}

/* ===== Рендер списка отчётов с учётом фильтров ===== */
function renderReportsList() {
  const box = document.getElementById('reportsList');
  if (!box) return;

  const reports = lastReportsSnapshot;

  // 1) Фильтр доступа + «Мои / Все»
  let visible = reports.filter(r => {
    const iAmAuthor = r.authorUid === currentUser.uid;
    const iAmPartner =
      r.partnerUid === currentUser.uid ||
      (Array.isArray(r.partnerUids) && r.partnerUids.includes(currentUser.uid));

    const hasAccess =
      canReview(currentProfile) ||
      canManageStaff(currentProfile) ||
      iAmAuthor || iAmPartner;
    if (!hasAccess) return false;

    if (reportsFilter === 'mine' && !(iAmAuthor || iAmPartner)) return false;

    return true;
  });

  // 2) Фильтр по тегам
  if (activeTagFilters.length > 0) {
    visible = visible.filter(r =>
      Array.isArray(r.tags) && r.tags.some(t => activeTagFilters.includes(t))
    );
  }

  // 3) Сортировка: закреплённые сверху, потом по дате
  visible.sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    const ta = a.createdAt?.toDate?.() || new Date(a.createdAt || 0);
    const tb = b.createdAt?.toDate?.() || new Date(b.createdAt || 0);
    return tb - ta;
  });

  // 4) Тумблер «Все / Мои» — только для тех, кто видит чужие отчёты
  const showFilterToggle = canReview(currentProfile) || canManageStaff(currentProfile);
  const filterToggle = showFilterToggle ? `
    <div class="reports-filter-toggle">
      <button class="reports-filter-btn ${reportsFilter === 'all' ? 'active' : ''}"
              data-reports-filter="all">🌐 Все отчёты</button>
      <button class="reports-filter-btn ${reportsFilter === 'mine' ? 'active' : ''}"
              data-reports-filter="mine">👤 Только мои</button>
    </div>
  ` : '';

  const filterBar = renderTagFilterBar();

  if (visible.length === 0) {
    box.innerHTML = `
      ${filterToggle}
      ${filterBar}
      <p class="doc-meta">${
        reportsFilter === 'mine'
          ? 'У тебя пока нет своих отчётов.'
          : activeTagFilters.length > 0
            ? 'По выбранным тегам отчётов не найдено. Нажми «Все», чтобы сбросить фильтр.'
            : 'Отчётов пока нет.'
      }</p>
    `;
    bindReportsListHandlers();
    return;
  }

  box.innerHTML = `
    <h3 style="color:var(--accent);margin-bottom:14px">Список отчётов (${visible.length})</h3>
    ${filterToggle}
    ${filterBar}` +
    visible.map(r => {
      const cls = 'report-card status-' + r.status;
      const canDel = canDelReports(currentProfile);
      const canRev = canReview(currentProfile);
      const canPin = canTogglePin(r);
      const actions = (canRev || canDel || canPin) ? `
        <div class="report-actions">
          ${canRev && r.status !== 'accepted' ? `<button class="btn" data-act="accepted" data-id="${r.id}">✓ Принять</button>` : ''}
          ${canRev && r.status !== 'rejected' ? `<button class="btn danger" data-act="rejected" data-id="${r.id}">✗ Отклонить</button>` : ''}
          ${canPin ? `<button class="btn secondary" data-act="pin" data-id="${r.id}" data-pinned="${!!r.pinned}">${r.pinned ? '📌 Открепить' : '📌 Закрепить'}</button>` : ''}
          ${canDel ? `<button class="btn secondary" data-act="del" data-id="${r.id}">🗑 Удалить</button>` : ''}
        </div>` : '';

      const pinnedClass = r.pinned ? ' pinned' : '';
      return `<div class="${cls}${pinnedClass}">
        <div class="report-head">
          <div class="report-author">
            ${r.pinned ? '<span class="pin-icon" title="Закреплён">📌</span> ' : ''}
            ${escapeHtml(r.authorNick)}<span class="rank">${escapeHtml(r.authorRank)}</span>
          </div>
          <div class="report-date">${fmtDate(r.createdAt)}</div>
        </div>
        <div class="report-type">${escapeHtml(r.type)} · ${statusLabel(r.status)}</div>
        ${(() => {
          if (Array.isArray(r.partners) && r.partners.length > 0) {
            return `<div class="report-type" style="background:#1a2338;color:var(--accent)">👥 С кем: ${r.partners.map(p => escapeHtml(p.nickname) + ' — ' + escapeHtml(p.rank || '')).join(', ')}</div>`;
          }
          if (r.partnerNick) {
            return `<div class="report-type" style="background:#1a2338;color:var(--accent)">👥 С кем: ${escapeHtml(r.partnerNick)} — ${escapeHtml(r.partnerRank || '')}</div>`;
          }
          return '';
        })()}
        ${renderReportTags(r.tags)}
        <div class="report-desc">${escapeHtml(r.description)}</div>
        ${renderAttachments(r.files)}
        ${r.reviewComment ? `<div class="report-comment">💬 <strong>${escapeHtml(r.reviewedBy || '')}:</strong> ${escapeHtml(r.reviewComment)}</div>` : ''}
        ${actions}
      </div>`;
    }).join('');

  bindReportsListHandlers();
}

/* ===== Обработчики списка ===== */
function bindReportsListHandlers() {
  // Тумблер «Все / Мои»
  document.querySelectorAll('[data-reports-filter]').forEach(b => {
    b.onclick = () => {
      reportsFilter = b.dataset.reportsFilter;
      renderReportsList();
    };
  });

  // Кнопки действий
  document.querySelectorAll('#reportsList [data-act]').forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.id, act = btn.dataset.act;
      if (act === 'del')       deleteReport(id);
      else if (act === 'pin')  togglePinReport(id, btn.dataset.pinned === 'true');
      else                     reviewReport(id, act);
    };
  });

  initTagFilterBar();
}

function statusLabel(s) {
  return {pending:'На рассмотрении',accepted:'Принят',rejected:'Отклонён'}[s] || s;
}

/* ==================== ПРОФИЛЬ СОТРУДНИКА ==================== */
/* ==================== ДАШБОРД ==================== */
function renderDashboard() {
  if (!canViewDashboard(currentProfile)) return `<h2>Доступ запрещён</h2>`;

  const now = Date.now();
  const periodMs = dashPeriod === 'week' ? 7*24*3600*1000 : 30*24*3600*1000;
  const periodStart = now - periodMs;

  // Учитываем метку последней очистки
  let clearTs = 0;
  if (dashboardConfig.lastClearAt) {
    clearTs = dashboardConfig.lastClearAt.toDate
      ? dashboardConfig.lastClearAt.toDate().getTime()
      : new Date(dashboardConfig.lastClearAt).getTime();
  }
  const cutoff = Math.max(periodStart, clearTs);

  const toMs = r => r.createdAt?.toDate ? r.createdAt.toDate().getTime() : new Date(r.createdAt || 0).getTime();
  const inPeriod = r => toMs(r) >= cutoff;

  const reportsIn    = cachedReports.filter(inPeriod);
  const detentionsIn = cachedDetentions.filter(inPeriod);
  const finesIn      = cachedFines.filter(inPeriod);

  // Активные полицейские (без гражданских и уволенных)
  const policeActive = cachedUsers.filter(u => isPolice(u) && u.status === 'active').length;
  const policeTotal  = cachedUsers.filter(u => isPolice(u) && u.status !== 'fired').length;

  // Статистика по сотрудникам (без уволенных и гражданских)
  const stats = {};
  cachedUsers.forEach(u => {
    if (u.status === 'fired' || !isPolice(u)) return;
    stats[u.uid] = { user: u, reports: 0, detentions: 0, fines: 0, total: 0 };
  });
  reportsIn.forEach(r => { if (stats[r.authorUid]) { stats[r.authorUid].reports++; stats[r.authorUid].total++; } });
  detentionsIn.forEach(d => { if (stats[d.authorUid]) { stats[d.authorUid].detentions++; stats[d.authorUid].total++; } });
  finesIn.forEach(f => { if (stats[f.authorUid]) { stats[f.authorUid].fines++; stats[f.authorUid].total++; } });

  const top5 = Object.values(stats).filter(s => s.total > 0)
    .sort((a,b) => b.total - a.total).slice(0, 5);

  // С выговорами (без уволенных)
  const withWarnings = cachedUsers
    .filter(u => u.status !== 'fired' && isPolice(u) && (u.warnings || []).length > 0)
    .sort((a,b) => (b.warnings.length) - (a.warnings.length));

  // С поощрениями (без уволенных) — за выбранный период
  const awardsByUser = cachedUsers
    .filter(u => u.status !== 'fired' && isPolice(u) && (u.awards || []).length > 0)
    .map(u => {
      const awardsInPeriod = (u.awards || []).filter(a => {
        const t = new Date(a.date).getTime();
        return t >= cutoff;
      });
      return { user: u, count: awardsInPeriod.length, all: u.awards || [] };
    })
    .filter(x => x.count > 0)
    .sort((a,b) => b.count - a.count);

  // В отпуске / больничном — сортируем: сначала те, у кого ближайшая дата возврата
  const onLeave = cachedUsers
    .filter(u => isPolice(u) && (u.status === 'vacation' || u.status === 'sick'))
    .sort((a, b) => {
      const ta = a.vacationTo ? new Date(a.vacationTo).getTime() : Infinity;
      const tb = b.vacationTo ? new Date(b.vacationTo).getTime() : Infinity;
      return ta - tb;
    });

  // График активности по дням
  const daysCount = dashPeriod === 'week' ? 7 : 30;
  const days = [];
  for (let i = daysCount - 1; i >= 0; i--) {
    const dayStart = new Date();
    dayStart.setHours(0,0,0,0);
    dayStart.setDate(dayStart.getDate() - i);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const dayStartMs = Math.max(dayStart.getTime(), cutoff);
    const dayEndMs = dayEnd.getTime();

    let count = 0;
    const countIn = arr => arr.forEach(r => {
      const t = toMs(r);
      if (t >= dayStartMs && t < dayEndMs) count++;
    });
    countIn(cachedReports);
    countIn(cachedDetentions);
    countIn(cachedFines);

    const label = dayStart.toLocaleDateString('ru-RU',
      dashPeriod === 'week'
        ? { weekday:'short', day:'2-digit' }
        : { day:'2-digit' });
    days.push({ label, count });
  }
  const maxDay = Math.max(1, ...days.map(d => d.count));

  // Рендер
  const lastClear = dashboardConfig.clearedAt
    ? `<div class="dash-clear-info">Последняя очистка: ${fmtDate(dashboardConfig.clearedAt)} — ${escapeHtml(dashboardConfig.clearedBy || '')}</div>`
    : '';

  return `
    <h2>📊 Дашборд</h2>
<p class="doc-meta">Аналитика по фракции</p>

    <div class="dash-toolbar">
      <div class="dash-period">
        <button class="dash-period-btn ${dashPeriod === 'week' ? 'active' : ''}" data-period="week">7 дней</button>
        <button class="dash-period-btn ${dashPeriod === 'month' ? 'active' : ''}" data-period="month">30 дней</button>
      </div>
      ${lvl(currentProfile.rank) >= 14 ? `
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn secondary" id="btnDownloadBackup">💾 Скачать бэкап</button>
          <button class="btn danger" id="btnClearDash">🗑 Очистить статистику</button>
        </div>
      ` : ''}
    </div>
    ${lastClear}

    <div class="dash-tiles">
      <div class="dash-tile">
        <div class="dash-tile-num">${reportsIn.length}</div>
        <div class="dash-tile-lbl">📝 Отчётов</div>
      </div>
      <div class="dash-tile">
        <div class="dash-tile-num">${detentionsIn.length}</div>
        <div class="dash-tile-lbl">📋 Задержаний</div>
      </div>
      <div class="dash-tile">
        <div class="dash-tile-num">${finesIn.length}</div>
        <div class="dash-tile-lbl">💰 Штрафов</div>
      </div>
      <div class="dash-tile">
        <div class="dash-tile-num">${policeActive} <span style="font-size:14px;color:var(--muted)">/ ${policeTotal}</span></div>
        <div class="dash-tile-lbl">👮 Активных</div>
      </div>
    </div>

    <h3 class="profile-section-title">🏆 Топ-5 активных</h3>
    ${top5.length === 0 ? '<p class="doc-meta">Нет активности за период.</p>' : `
      <div class="dash-top">
        ${top5.map((s, i) => `
          <div class="dash-top-row" onclick="location.hash='#/profile/${s.user.uid}'" style="cursor:pointer">
            <div class="dash-top-place">${i+1}</div>
            <div class="dash-top-info">
              <div class="dash-top-name">${escapeHtml(s.user.nickname)}</div>
              <div class="dash-top-rank">${escapeHtml(s.user.rank)}</div>
            </div>
            <div class="dash-top-stats">
              <span title="Отчёты">📝 ${s.reports}</span>
              <span title="Задержания">📋 ${s.detentions}</span>
              <span title="Штрафы">💰 ${s.fines}</span>
            </div>
            <div class="dash-top-total">${s.total}</div>
          </div>
        `).join('')}
      </div>
    `}

    <h3 class="profile-section-title">📈 Активность по дням</h3>
    <div class="dash-chart">
      ${days.map(d => `
        <div class="dash-bar-wrap" title="${d.label}: ${d.count}">
          <div class="dash-bar-count">${d.count || ''}</div>
          <div class="dash-bar" style="height:${Math.max(2, (d.count / maxDay) * 100)}%"></div>
          <div class="dash-bar-label">${d.label}</div>
        </div>
      `).join('')}
    </div>

    <h3 class="profile-section-title">🏆 Поощрения за период (${awardsByUser.length})</h3>
    ${awardsByUser.length === 0 ? '<p class="doc-meta">За этот период никого не поощряли.</p>' : `
      <div class="dash-list">
        ${awardsByUser.map(x => {
          const totalExp = x.all.reduce((s, a) => s + (a.amount || 0), 0);
          return `<div class="dash-list-row" onclick="location.hash='#/profile/${x.user.uid}'" style="cursor:pointer">
            <div class="dash-list-name">${escapeHtml(x.user.nickname)} <span class="dash-list-rank">${escapeHtml(x.user.rank)}</span></div>
            <div class="dash-list-val" style="color:var(--ok)">
              ⭐ ${x.count}${totalExp ? ` <span style="font-size:11px;color:var(--muted)">(${totalExp.toLocaleString('ru-RU')} exp)</span>` : ''}
            </div>
          </div>`;
        }).join('')}
      </div>
    `}

    <h3 class="profile-section-title">⚠️ Сотрудники с выговорами (${withWarnings.length})</h3>
    ${withWarnings.length === 0 ? '<p class="doc-meta">Все чисто.</p>' : `
      <div class="dash-list">
        ${withWarnings.map(u => {
          const heavy = (u.warnings || []).filter(w => w.severity === 'heavy').length;
          return `<div class="dash-list-row" onclick="location.hash='#/profile/${u.uid}'" style="cursor:pointer">
            <div class="dash-list-name">${escapeHtml(u.nickname)} <span class="dash-list-rank">${escapeHtml(u.rank)}</span></div>
            <div class="dash-list-val" style="color:var(--danger)">
              ⚠️ ${u.warnings.length}${heavy ? ` <span style="font-size:11px">(тяжёлых: ${heavy})</span>` : ''}
            </div>
          </div>`;
        }).join('')}
      </div>
    `}

    <h3 class="profile-section-title">🌴 В отпуске / на больничном (${onLeave.length})</h3>
    ${onLeave.length === 0 ? '<p class="doc-meta">Все на месте.</p>' : `
      <div class="dash-list">
        ${onLeave.map(u => {
          const info = STATUS_LABELS[u.status];
          let dateInfo = '';
          if (u.status === 'vacation' && u.vacationTo) {
            const today = new Date(); today.setHours(0,0,0,0);
            const end = new Date(u.vacationTo); end.setHours(0,0,0,0);
            const daysLeft = Math.ceil((end - today) / 86400000);
            const endStr = new Date(u.vacationTo).toLocaleDateString('ru-RU', { day:'2-digit', month:'2-digit' });
            dateInfo = daysLeft <= 0
              ? `· возвращается сегодня`
              : daysLeft === 1
                ? `· вернётся завтра`
                : `· вернётся ${endStr} (через ${daysLeft} ${pluralDays(daysLeft)})`;
          }
          return `<div class="dash-list-row" onclick="location.hash='#/profile/${u.uid}'" style="cursor:pointer">
            <div class="dash-list-name">${escapeHtml(u.nickname)} <span class="dash-list-rank">${escapeHtml(u.rank)}</span></div>
            <div class="dash-list-val" style="color:${info.color}; text-align:right">
              ${info.label}
              ${dateInfo ? `<div style="font-size:11px;color:var(--muted);font-weight:400;margin-top:2px">${dateInfo}</div>` : ''}
            </div>
          </div>`;
        }).join('')}
      </div>
    `}
  `;
}

// Обработчики дашборда
document.addEventListener('click', e => {
  const periodBtn = e.target.closest('[data-period]');
  if (periodBtn) {
    dashPeriod = periodBtn.dataset.period;
    render();
  }
  if (e.target.id === 'btnClearDash') {
    clearDashboard();
  }
  if (e.target.id === 'btnDownloadBackup') {
    downloadBackup();
  }
});

/* ==================== ДОСКА ОБЪЯВЛЕНИЙ ==================== */
function renderAnnouncements() {
  // Доступ: только полиция + начальство
  if (!isPolice(currentProfile) && !canReview(currentProfile) && !canManageStaff(currentProfile)) {
    return `<h2>Доступ запрещён</h2>`;
  }

  // Как только зашли в раздел — помечаем прочитанным
  setTimeout(() => {
    markAnnouncementsAsRead();
  }, 100); // Небольшая задержка, чтобы DOM успел отрисоваться

  const canCreate = canCreateAnnouncements(currentProfile);
  const canPin = canPinAnnouncements(currentProfile);

  // Сортировка: закреплённые сверху
  const sorted = [...cachedAnnouncements].sort((a,b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    const ta = a.createdAt?.toDate?.() || new Date(a.createdAt || 0);
    const tb = b.createdAt?.toDate?.() || new Date(b.createdAt || 0);
    return tb - ta;
  });

  const cardsHtml = sorted.map(a => {
    const isAuthor = a.authorUid === currentUser.uid;
    const canEdit = isAuthor;
    const canDelete = isAuthor || canPin;
    return `
      <div class="ann-card ${a.pinned ? 'pinned' : ''}">
        <div class="ann-head">
          <div class="ann-title">
            ${a.pinned ? '<span class="ann-pin">📌</span>' : ''}
            ${escapeHtml(a.title)}
          </div>
          <div class="ann-date">${fmtDate(a.createdAt)}</div>
        </div>
        <div class="ann-text">${escapeHtml(a.text)}</div>
        ${(a.files && a.files.length) ? `
          <div class="ann-gallery">
            ${a.files.map(f => `
              <a href="${escapeHtml(f.url)}" target="_blank" class="ann-gallery-item" rel="noopener">
                <img src="${escapeHtml(f.url)}" alt="" loading="lazy">
              </a>
            `).join('')}
          </div>
        ` : ''}
        <div class="ann-foot">
          <div class="ann-author">
            ${escapeHtml(a.authorNick)} <span class="ann-rank">${escapeHtml(a.authorRank)}</span>
            ${a.editedAt ? `<span class="ann-edited">· ред. ${escapeHtml(a.editedBy || '')} ${fmtDate(a.editedAt)}</span>` : ''}
          </div>
          <div class="ann-actions">
            ${canPin ? `<button class="btn tiny secondary" data-pin="${a.id}" data-pinned="${a.pinned}">${a.pinned ? '📌 Открепить' : '📌 Закрепить'}</button>` : ''}
            ${canEdit ? `<button class="btn tiny secondary" data-edit-ann="${a.id}">✏️ Ред.</button>` : ''}
            ${canDelete ? `<button class="btn tiny danger" data-del-ann="${a.id}">🗑</button>` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');

  setTimeout(() => {
    document.getElementById('btnNewAnn')?.addEventListener('click', () => openAnnouncementModal(null));

    document.querySelectorAll('[data-pin]').forEach(b => {
      b.onclick = () => togglePinAnnouncement(b.dataset.pin, b.dataset.pinned === 'true');
    });
    document.querySelectorAll('[data-edit-ann]').forEach(b => {
      b.onclick = () => {
        const ann = cachedAnnouncements.find(a => a.id === b.dataset.editAnn);
        if (ann) openAnnouncementModal(ann);
      };
    });
    document.querySelectorAll('[data-del-ann]').forEach(b => {
      b.onclick = () => deleteAnnouncement(b.dataset.delAnn);
    });
  }, 0);

  return `
    <h2>📢 Доска объявлений</h2>
    <p class="doc-meta">Внутренние объявления для сотрудников фракции</p>

    ${canCreate ? `<button class="btn" id="btnNewAnn" style="margin-bottom:20px">+ Новое объявление</button>` : ''}

    ${sorted.length === 0
      ? '<p class="doc-meta">Объявлений пока нет.</p>'
      : cardsHtml}
  `;
}

function renderProfile(uid) {
  // Возвращаем заглушку, потом подгрузим данные
  setTimeout(async () => {
    const container = document.getElementById('profileContainer');
    if (!container) return;

    const profile = cachedUsers.find(u => u.uid === uid) || await loadProfile(uid);
    if (!profile) {
      container.innerHTML = '<h2>Сотрудник не найден</h2>';
      return;
    }

    // Загружаем статистику
    try {
      const [reportsA, detentionsA, finesA,
             reportsP, detentionsP, finesP] = await Promise.all([
        getDocs(query(collection(db,'reports'),  where('authorUid','==',uid))),
        getDocs(query(collection(db,'detentions'), where('authorUid','==',uid))),
        getDocs(query(collection(db,'fines'),    where('authorUid','==',uid))),
        getDocs(query(collection(db,'reports'),  where('partnerUids','array-contains',uid))),
        getDocs(query(collection(db,'detentions'), where('partnerUids','array-contains',uid))),
        getDocs(query(collection(db,'fines'),    where('partnerUids','array-contains',uid)))
      ]);

      // Последние записи (сортируем на клиенте)
      const sortByDate = arr => arr.sort((a,b) => {
        const ta = a.createdAt?.toDate?.() || new Date(a.createdAt || 0);
        const tb = b.createdAt?.toDate?.() || new Date(b.createdAt || 0);
        return tb - ta;
      });

      // Объединяем с дедупликацией по id (если я одновременно автор и напарник — не дублируем)
      const dedupe = (arr1, arr2) => {
        const map = new Map();
        [...arr1, ...arr2].forEach(x => map.set(x.id, x));
        return Array.from(map.values());
      };

      const allReports   = dedupe(reportsA.docs.map(d => ({ id: d.id, ...d.data() })),
                                   reportsP.docs.map(d => ({ id: d.id, ...d.data() })));
      const allDetentions= dedupe(detentionsA.docs.map(d => ({ id: d.id, ...d.data() })),
                                   detentionsP.docs.map(d => ({ id: d.id, ...d.data() })));
      const allFines     = dedupe(finesA.docs.map(d => ({ id: d.id, ...d.data() })),
                                   finesP.docs.map(d => ({ id: d.id, ...d.data() })));

      sortByDate(allReports);
      sortByDate(allDetentions);
      sortByDate(allFines);

      const lastReports    = allReports.slice(0, 5);
      const lastDetentions = allDetentions.slice(0, 5);
      const lastFines      = allFines.slice(0, 5);

      const totalFinesSum = allFines.reduce((s, f) => s + (f.amount || 0), 0);
      const warnings = profile.warnings || [];
      const rankHistory = profile.rankHistory || [];

      const statusInfo = STATUS_LABELS[profile.status] || { label: profile.status, color: '#888' };

      const statBlock = `
        <div class="profile-stats">
          <div class="stat-card">
            <div class="stat-num">${allReports.length}</div>
            <div class="stat-lbl">Отчётов</div>
          </div>
          <div class="stat-card">
            <div class="stat-num">${allDetentions.length}</div>
            <div class="stat-lbl">Задержаний</div>
          </div>
          <div class="stat-card">
            <div class="stat-num">${allFines.length}</div>
            <div class="stat-lbl">Штрафов</div>
          </div>
          <div class="stat-card">
            <div class="stat-num">${totalFinesSum.toLocaleString('ru-RU')}</div>
            <div class="stat-lbl">exp штрафов</div>
          </div>
          <div class="stat-card">
            <div class="stat-num" style="color:${warnings.length ? 'var(--danger)' : 'var(--ok)'}">${warnings.length}</div>
            <div class="stat-lbl">Выговоров</div>
          </div>
        </div>
      `;

            /* ===== Расширенная статистика ===== */

      // --- Топ-3 напарника ---
      const partnerCount = {};
      const countPartners = (items) => {
        items.forEach(it => {
          // Массив partners (новая структура)
          if (Array.isArray(it.partners)) {
            it.partners.forEach(p => {
              if (!p?.uid || p.uid === uid) return;
              if (!partnerCount[p.uid]) partnerCount[p.uid] = { uid: p.uid, nickname: p.nickname, rank: p.rank, count: 0 };
              partnerCount[p.uid].count++;
            });
          }
          // Старое поле partnerUid
          if (it.partnerUid && it.partnerUid !== uid) {
            const pu = cachedUsers.find(u => u.uid === it.partnerUid);
            if (pu) {
              if (!partnerCount[pu.uid]) partnerCount[pu.uid] = { uid: pu.uid, nickname: pu.nickname, rank: pu.rank, count: 0 };
              partnerCount[pu.uid].count++;
            }
          }
        });
      };
      // Только свои (не где он напарник) — чтобы не задваивалось
      const myReportsOnly    = allReports.filter(r => r.authorUid === uid);
      const myDetentionsOnly = allDetentions.filter(d => d.authorUid === uid);
      const myFinesOnly      = allFines.filter(f => f.authorUid === uid);
      countPartners(myReportsOnly);
      countPartners(myDetentionsOnly);
      countPartners(myFinesOnly);

      const topPartners = Object.values(partnerCount)
        .sort((a, b) => b.count - a.count)
        .slice(0, 3);

      // --- Топ-5 любимых статей ---
      const articleCount = {};
      const countArticles = (items) => {
        items.forEach(it => {
          (it.articles || []).forEach(a => {
            const key = `${a.code}|${a.codeType}`;
            if (!articleCount[key]) {
              articleCount[key] = { code: a.code, codeType: a.codeType, title: a.title || '', count: 0 };
            }
            articleCount[key].count++;
          });
        });
      };
      countArticles(myDetentionsOnly);
      countArticles(myFinesOnly);

      const topArticles = Object.values(articleCount)
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

      // --- График по 8 последним неделям ---
      const WEEKS = 8;
      const nowMs = Date.now();
      const weekMs = 7 * 24 * 3600 * 1000;
      const weekBuckets = [];
      for (let i = WEEKS - 1; i >= 0; i--) {
        const end   = nowMs - i * weekMs;
        const start = end - weekMs;
        weekBuckets.push({ start, end, label: '', count: 0 });
      }
      const countInWeek = (items) => {
        items.forEach(it => {
          const t = it.createdAt?.toDate?.() || new Date(it.createdAt || 0);
          const ts = t.getTime();
          for (const w of weekBuckets) {
            if (ts >= w.start && ts < w.end) { w.count++; break; }
          }
        });
      };
      countInWeek(myReportsOnly);
      countInWeek(myDetentionsOnly);
      countInWeek(myFinesOnly);

      // Подписи недель: "12.05 – 18.05"
      weekBuckets.forEach(w => {
        const s = new Date(w.start);
        const e = new Date(w.end - 24 * 3600 * 1000);
        const fmt = d => `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}`;
        w.label = `${fmt(s)}–${fmt(e)}`;
      });
      const maxWeek = Math.max(1, ...weekBuckets.map(w => w.count));

      const topPartnersHtml = topPartners.length ? `
        <h3 class="profile-section-title">🤝 Чаще всего в паре</h3>
        <div class="profile-top-list">
          ${topPartners.map((p, i) => `
            <div class="profile-top-row" onclick="location.hash='#/profile/${p.uid}'" style="cursor:pointer">
              <div class="profile-top-place">${i+1}</div>
              <div class="profile-top-name">
                ${escapeHtml(p.nickname)}
                <span class="profile-top-rank">${escapeHtml(p.rank || '')}</span>
              </div>
              <div class="profile-top-count">${p.count} раз</div>
            </div>
          `).join('')}
        </div>
      ` : '';

      const topArticlesHtml = topArticles.length ? `
        <h3 class="profile-section-title">⚖️ Любимые статьи</h3>
        <div class="profile-top-list">
          ${topArticles.map((a, i) => `
            <div class="profile-top-row law-chip-clickable"
                 data-law-type="${escapeHtml(a.codeType)}"
                 data-law-code="${escapeHtml(a.code)}"
                 style="cursor:pointer">
              <div class="profile-top-place">${i+1}</div>
              <div class="profile-top-name">
                ${escapeHtml(a.code)} <span class="profile-top-rank">${escapeHtml(a.codeType)}</span>
                <div style="font-size:11px;color:var(--muted);margin-top:2px;line-height:1.3">${escapeHtml((a.title || '').slice(0, 80))}${(a.title || '').length > 80 ? '…' : ''}</div>
              </div>
              <div class="profile-top-count">${a.count}×</div>
            </div>
          `).join('')}
        </div>
      ` : '';

      const activityChartHtml = `
        <h3 class="profile-section-title">📈 Активность за 8 недель</h3>
        <div class="profile-activity-chart">
          ${weekBuckets.map(w => `
            <div class="profile-bar-wrap" title="${w.label}: ${w.count}">
              <div class="profile-bar-count">${w.count || ''}</div>
              <div class="profile-bar" style="height:${Math.max(2, (w.count / maxWeek) * 100)}%"></div>
              <div class="profile-bar-label">${w.label}</div>
            </div>
          `).join('')}
        </div>
      `;

      const isPartnerIn = (item) => item.authorUid !== uid &&
        (Array.isArray(item.partnerUids) ? item.partnerUids.includes(uid) : item.partnerUid === uid);

      const renderMiniReport = r => `
        <div class="profile-mini status-${r.status}">
          <div class="profile-mini-head">
            <span>${escapeHtml(r.type || 'Отчёт')}${isPartnerIn(r) ? ' <em style="color:var(--accent-2);font-style:normal;font-size:11px">· как напарник</em>' : ''}</span>
            <span class="profile-mini-date">${fmtDate(r.createdAt)}</span>
          </div>
          <div class="profile-mini-body">${escapeHtml((r.description || '').slice(0, 100))}${(r.description || '').length > 100 ? '…' : ''}</div>
          <div class="profile-mini-status status-${r.status}">${statusLabel(r.status)}</div>
        </div>
      `;

      const renderMiniDetention = d => `
        <div class="profile-mini status-${d.status}">
          <div class="profile-mini-head">
            <span>👤 ${escapeHtml(d.target || '—')}${isPartnerIn(d) ? ' <em style="color:var(--accent-2);font-style:normal;font-size:11px">· как напарник</em>' : ''}</span>
            <span class="profile-mini-date">${fmtDate(d.createdAt)}</span>
          </div>
          <div class="profile-mini-body">
            ${(d.articles || []).map(a => `<span class="law-chip" style="font-size:10px">${escapeHtml(a.code)}</span>`).join(' ')}
            · ⏱ ${d.prisonMinutes || 0} мин
          </div>
          <div class="profile-mini-status status-${d.status}">${statusLabel(d.status)}</div>
        </div>
      `;

      const renderMiniFine = f => `
        <div class="profile-mini status-${f.status}">
          <div class="profile-mini-head">
            <span>👤 ${escapeHtml(f.target || '—')}${isPartnerIn(f) ? ' <em style="color:var(--accent-2);font-style:normal;font-size:11px">· как напарник</em>' : ''}</span>
            <span class="profile-mini-date">${fmtDate(f.createdAt)}</span>
          </div>
          <div class="profile-mini-body">
            💰 ${Number(f.amount || 0).toLocaleString('ru-RU')} exp
            ${(f.articles || []).map(a => `<span class="law-chip" style="font-size:10px">${escapeHtml(a.code)}</span>`).join(' ')}
          </div>
          <div class="profile-mini-status status-${f.status}">${statusLabel(f.status)}</div>
        </div>
      `;

      const rankHistoryHtml = rankHistory.length ? `
        <h3 class="profile-section-title">🎖 История карьеры</h3>
        <div class="profile-history">
          ${rankHistory.slice().reverse().map(h => {
            const isFire = h.type === 'fire';
            const isHire = h.type === 'hire';
            const accentColor = isFire ? 'var(--danger)' : (isHire ? 'var(--ok)' : 'var(--accent)');
            const icon = isFire ? '🗑' : (isHire ? '✓' : '🎖');
            const label = isFire ? 'Увольнение' : (isHire ? 'Приём' : 'Повышение');

            return `
              <div class="history-item" style="border-left:3px solid ${accentColor}">
                <div class="history-main">
                  <span style="color:${accentColor};font-size:11px;letter-spacing:1px;text-transform:uppercase">${icon} ${label}</span><br>
                  <strong>${escapeHtml(h.from)}</strong>
                  <span style="color:var(--muted)"> → </span>
                  <strong style="color:${accentColor}">${escapeHtml(h.to)}</strong>
                </div>
                <div class="history-meta">
                  ${fmtDate(h.at)} — ${escapeHtml(h.by)} (${escapeHtml(h.byRank || '')})
                </div>
                ${h.reason ? `<div class="history-reason">💬 ${escapeHtml(h.reason)}</div>` : ''}
              </div>
            `;
          }).join('')}
        </div>
      ` : '';

      // Блок "Уволен" — если сотрудник был уволен и пока не принят обратно
      const firedInfo = profile.firedInfo;
      const firedHtml = (firedInfo && profile.firedAcknowledged !== true && profile.rank === 'Гражданский') ? `
        <div class="fired-banner">
          <div class="fired-banner-title">⚠️ СОТРУДНИК УВОЛЕН</div>
          <div class="fired-banner-info">
            <div>👤 Кем: <strong>${escapeHtml(firedInfo.by)}</strong> (${escapeHtml(firedInfo.byRank || '')})</div>
            <div>🕐 Когда: <strong>${fmtDate(firedInfo.at)}</strong></div>
            <div>💬 Причина: <strong>${escapeHtml(firedInfo.reason)}</strong></div>
          </div>
        </div>
      ` : '';

      // Показываем баннер в основном HTML (см. ниже)

      const awards = profile.awards || [];
      const awardsHtml = awards.length ? `
        <h3 class="profile-section-title">⭐ Поощрения (${awards.length})</h3>
        <div class="profile-awards">
          ${awards.slice().reverse().map(a => {
            const info = AWARD_TYPES[a.type] || { label: a.type, color: '#888' };
            return `
              <div class="award-item" style="border-left-color:${info.color}">
                <div class="award-head">
                  <strong style="color:${info.color}">${info.label}${a.amount ? ` · ${a.amount.toLocaleString('ru-RU')} exp` : ''}</strong>
                  <span class="award-date">${fmtDate(a.date)}</span>
                </div>
                <div class="award-reason">${escapeHtml(a.reason)}</div>
                <div class="award-meta">Выдал: ${escapeHtml(a.from)} (${escapeHtml(a.fromRank || '')})</div>
              </div>
            `;
          }).join('')}
        </div>
      ` : '';
      
      const warningsAnalysis = analyzeWarnings(warnings);
      const warningsHtml = warnings.length ? `
        <h3 class="profile-section-title">⚠️ Дисциплина</h3>

        <div class="discipline-status discipline-${warningsAnalysis.riskLevel || 'ok'}">
          <div class="discipline-head">
            <span class="discipline-label">
              ${warningsAnalysis.riskLevel === 'danger'  ? '🚨 РЕКОМЕНДОВАН К УВОЛЬНЕНИЮ'
              : warningsAnalysis.riskLevel === 'warning' ? '⚠️ ' + warningsAnalysis.riskLabel
              : warningsAnalysis.riskLevel === 'notice'  ? '⚡ ' + warningsAnalysis.riskLabel
              : '✅ Дисциплина в норме'}
            </span>
            <span class="discipline-counts">
              ${warningsAnalysis.description || `${warnings.length} выговор(ов)`}
            </span>
          </div>
          <div class="discipline-hint">
            ${warningsAnalysis.recommendFire
              ? 'Сотрудник имеет 3+ тяжёлых выговора. Окончательное решение об увольнении принимает руководство.'
              : warningsAnalysis.riskLevel === 'warning' && warningsAnalysis.heavy > 0
                ? 'Имеется тяжёлый выговор — рекомендуется провести собеседование с сотрудником.'
                : warningsAnalysis.riskLevel === 'warning'
                  ? '3+ средних выговора. Близко к критическому уровню дисциплины.'
                  : warningsAnalysis.riskLevel === 'notice'
                    ? '3+ лёгких выговора. Стоит обратить внимание.'
                    : ''}
          </div>
        </div>

        <div class="profile-warnings">
          ${warnings.map(w => `
            <div class="warning-item" style="border-left-color:${WARNING_LEVELS[w.severity]?.color}">
              <div><strong>${WARNING_LEVELS[w.severity]?.label}</strong> · от ${escapeHtml(w.from)} · ${fmtDate(w.date)}</div>
              <div style="color:var(--muted);margin-top:4px">${escapeHtml(w.reason)}</div>
            </div>
          `).join('')}
        </div>
      ` : '';

      container.innerHTML = `
        <div class="profile-hero">
          <div class="profile-avatar">${escapeHtml(profile.nickname.charAt(0).toUpperCase())}</div>
          <div class="profile-info">
            <h2 style="border:none;padding:0;margin:0">${escapeHtml(profile.nickname)}</h2>
            <div class="profile-meta">
              <span class="profile-rank">${escapeHtml(profile.rank)}</span>
              <span class="status-pill" style="background:${statusInfo.color}22;color:${statusInfo.color}">
                ${statusInfo.label}
              </span>
            </div>
            <div class="profile-since">В штате с ${fmtDate(profile.createdAt)}</div>
            ${uid === currentUser.uid && isPolice(profile) ? `
              <button class="btn vacation-btn" id="btnVacationRequest">🏖 Подать заявку на отпуск</button>
            ` : ''}
          </div>
        </div>

        ${(() => {
          if (uid !== currentUser.uid) return '';
          const myVacations = cachedVacations.filter(v => v.userId === currentUser.uid);
          const active = myVacations.find(v => v.status === 'pending' || v.status === 'approved');
          if (!active) return '';
          return renderVacationStatusBlock(active);
        })()}

        ${firedHtml}

        ${statBlock}

        ${activityChartHtml}
        ${topPartnersHtml}
        ${topArticlesHtml}

        ${rankHistoryHtml}
        ${awardsHtml}
        ${warningsHtml}

        <h3 class="profile-section-title">📝 Последние отчёты ${lastReports.length ? `(${lastReports.length} из ${allReports.length})` : ''}</h3>
        ${lastReports.length ? lastReports.map(renderMiniReport).join('') : '<p class="doc-meta">Нет отчётов.</p>'}

        <h3 class="profile-section-title">📋 Последние задержания ${lastDetentions.length ? `(${lastDetentions.length} из ${allDetentions.length})` : ''}</h3>
        ${lastDetentions.length ? lastDetentions.map(renderMiniDetention).join('') : '<p class="doc-meta">Нет задержаний.</p>'}

        <h3 class="profile-section-title">💰 Последние штрафы ${lastFines.length ? `(${lastFines.length} из ${allFines.length})` : ''}</h3>
        ${lastFines.length ? lastFines.map(renderMiniFine).join('') : '<p class="doc-meta">Нет штрафов.</p>'}
      `;

      // Клик по «любимой статье» → переход в кодекс
      container.querySelectorAll('.law-chip-clickable').forEach(el => {
        el.addEventListener('click', () => {
          goToLawArticle(el.dataset.lawType, el.dataset.lawCode);
        });
      });

      // Кнопка «Подать заявку»
      document.getElementById('btnVacationRequest')?.addEventListener('click', openVacationModal);

      // Кнопка «Отменить заявку»
      document.getElementById('btnCancelVacation')?.addEventListener('click', (e) => {
        cancelVacation(e.currentTarget.dataset.vacId);
      });

    } catch (err) {
      console.error(err);
      container.innerHTML = `<p class="doc-meta" style="color:var(--danger)">Ошибка загрузки профиля: ${escapeHtml(err.message)}</p>`;
    }
  }, 0);

  return `
    <button class="btn secondary" style="margin-bottom:16px" onclick="location.hash='#/staff'">← Назад к Кадрам</button>
    <div id="profileContainer"><p class="doc-meta">Загрузка профиля...</p></div>
  `;
}

function renderStaff() {
  if (!canViewStaff(currentProfile)) {
    return `<h2>Доступ запрещён</h2>`;
  }
  const active = cachedUsers.filter(u => u.status === 'active').length;
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
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 16px">
      ${rolesIAssignViaInvite(currentProfile).length > 0
        ? `<button class="btn" id="btnOpenInvites" style="width:auto">🔑 Приглашения</button>`
        : ''}
      ${canEditPromotionRules(currentProfile)
        ? `<button class="btn secondary" id="btnPromoEditor" style="width:auto">⚙️ Чек-листы повышения</button>`
        : ''}
    </div>
    <p class="doc-meta">${iCanManage ? 'Ты можешь редактировать сотрудников ниже своего уровня' : 'Просмотр'}</p>
    <div class="counter-bar">
      <span>Активных: <strong>${active}</strong></span>
      <span>Всего: <strong>${cachedUsers.length}</strong></span>
    </div>

    ${renderVacationRequestsBlock()}      

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
      const canWarnTarget = canWarnAwardReset(currentProfile, u);
      const warns = u.warnings || [];
      const heavy = warns.filter(w => w.severity === 'heavy').length;
      const analysis = analyzeWarnings(warns);
      const roleOptions = ROLES_ORDERED.map(r => {
        const canAssign = myRoles.includes(r);
        const sel = r === u.rank ? 'selected' : '';
        const dis = canAssign ? '' : 'disabled';
        return `<option value="${r}" ${sel} ${dis}>${r}${canAssign ? '' : ' 🔒'}</option>`;
      }).join('');

      const rowExtraClass = analysis.recommendFire ? 'fire-recommended' : '';
      return `<div class="staff-row status-${u.status} ${u.status === 'fired' ? 'fired' : ''} ${rowExtraClass}">
        <div>
          <div class="name">
            ${escapeHtml(u.nickname)}
            ${heavy ? `<span style="color:var(--danger)">⚠️×${heavy}</span>` : ''}
          </div>
          ${renderWarningRiskBadge(warns)}
          <div class="nick">
            ${u.rank === 'Гражданский'
              ? `<span style="color:var(--muted)">Гражданский</span>`
              : `<span style="color:${STATUS_LABELS[u.status]?.color || '#888'}">${STATUS_LABELS[u.status]?.label || u.status}</span>
                 · выговоров: ${warns.length}
                 ${u.status === 'vacation' && u.vacationTo
                   ? `· <span class="vac-until">🏖 до ${new Date(u.vacationTo).toLocaleDateString('ru-RU', { day:'2-digit', month:'2-digit' })}</span>`
                   : ''}`}
          </div>
        </div>
        ${editable ? `
          <select data-uid="${u.uid}" data-field="rank">${roleOptions}</select>
        ` : `<div class="role-label">${escapeHtml(u.rank)}</div>`}
        <div class="staff-actions">
          <button class="btn secondary" data-open-profile="${u.uid}" title="Открыть профиль">👤</button>
          ${promotionRules.byRole?.[u.rank] && u.rank !== 'Гражданский'
            ? `<button class="btn secondary" data-promo-check="${u.uid}" title="Проверить повышение">🎖</button>`
            : ''}

          ${u.rank === 'Гражданский' ? `
            ${canHireUser(currentProfile, u) ? `
              <button class="btn" data-hire="${u.uid}" title="Принять на службу">✓ Принять</button>
            ` : ''}
          ` : `
            ${canWarnTarget ? `<button class="btn secondary" data-warn="${u.uid}">⚠️</button>` : ''}
            ${canWarnTarget && canGiveAwards(currentProfile) ? `<button class="btn secondary" data-award="${u.uid}" title="Поощрение">🏅</button>` : ''}
            ${canWarnTarget && canResetPasswords(currentProfile) ? `<button class="btn secondary" data-reset="${u.uid}" title="Сбросить пароль">🔑</button>` : ''}
            ${editable ? `
              <select data-status="${u.uid}" class="status-select" title="Статус сотрудника">
                ${Object.entries(STATUS_LABELS)
                  .filter(([key]) => key !== 'fired')
                  .map(([key, val]) =>
                    `<option value="${key}" ${u.status === key ? 'selected' : ''}>${val.label}</option>`
                  ).join('')}
              </select>
            ` : ''}
            ${canFireUser(currentProfile, u) ? `
              <button class="btn danger" data-fire="${u.uid}" title="Уволить">🗑</button>
            ` : ''}
          `}
        </div>
      </div>
      ${warns.length ? `<div style="padding:0 14px 10px 26px">
        ${warns.map(w => `<div class="warning-item small" style="border-left-color:${WARNING_LEVELS[w.severity]?.color}">
          <span><strong>${WARNING_LEVELS[w.severity]?.label}</strong> · ${escapeHtml(w.reason)} · от ${escapeHtml(w.from)} · ${fmtDate(w.date)}</span>
          ${canWarnTarget ? `<button class="btn tiny secondary" data-rmwarn="${u.uid}:${w.id}">×</button>` : ''}
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
    // Открытие профиля
    document.querySelectorAll('[data-open-profile]').forEach(b => {
      b.onclick = () => { location.hash = '#/profile/' + b.dataset.openProfile; };
    });
    document.querySelectorAll('[data-status]').forEach(sel => {
      sel.onchange = () => setUserStatus(sel.dataset.status, sel.value);
    });
    document.querySelectorAll('[data-del]').forEach(b => b.onclick = () => deleteUser(b.dataset.del));
    document.querySelectorAll('[data-warn]').forEach(b => b.onclick = () => addWarning(b.dataset.warn));
    document.querySelectorAll('[data-award]').forEach(b => b.onclick = () => giveAward(b.dataset.award));
    document.querySelectorAll('[data-reset]').forEach(b => b.onclick = () => requestPasswordReset(b.dataset.reset));
    document.querySelectorAll('[data-rmwarn]').forEach(b => {
      b.onclick = () => {
        const [uid, wid] = b.dataset.rmwarn.split(':');
        removeWarning(uid, wid);
      };
    });
    // Найм и увольнение
    document.querySelectorAll('[data-hire]').forEach(b => {
      b.onclick = () => openHireModal(b.dataset.hire);
    });
    document.querySelectorAll('[data-fire]').forEach(b => {
      b.onclick = () => openFireModal(b.dataset.fire);
    });
    // Открытие раздела Приглашения
    document.getElementById('btnOpenInvites')?.addEventListener('click', () => {
      location.hash = '#/invites';
    });
    document.getElementById('btnPromoEditor')?.addEventListener('click', openPromotionEditor);
    document.querySelectorAll('[data-promo-check]').forEach(b => {
      b.onclick = () => openPromotionCheckModal(b.dataset.promoCheck);
    });
  }, 0);

  return html;
}

function renderInvites() {
  if (!canManageStaff(currentProfile)) return `<h2>Доступ запрещён</h2>`;

  const myRoles = rolesIAssignViaInvite(currentProfile);
  const canCreate = myRoles.length > 0;
  const now = Date.now();

  // 🔒 ФИЛЬТРАЦИЯ ПО ПРАВАМ:
  //   — свои приглашения видим всегда
  //   — чужие — только если моя роль НЕ НИЖЕ роли, на которую выдано приглашение
  const myLevel = lvl(currentProfile.rank);
  const visibleInvites = cachedInvites.filter(inv => {
    if (inv.createdBy === currentUser.uid) return true;
    const inviteLevel = lvl(inv.role);
    return myLevel >= inviteLevel;
  });
  const hiddenCount = cachedInvites.length - visibleInvites.length;

  // Обработчики (навешиваются после рендера)
  setTimeout(() => {
    document.getElementById('btnCreateInvite')?.addEventListener('click', createInvite);
    document.querySelectorAll('[data-delinv]').forEach(b => {
      b.onclick = () => deleteInvite(b.dataset.delinv);
    });
  }, 0);

  return `
    <button class="btn secondary" style="margin-bottom:16px" onclick="location.hash='#/staff'">← Назад к Кадрам</button>
    <h2>🔑 Пригласительные коды</h2>
    <p class="doc-meta">
      Создавай коды для регистрации новичков
      ${hiddenCount > 0
        ? `<br><span style="color:var(--muted);font-size:11px">🔒 Ещё ${hiddenCount} приглашений скрыто — твоя роль ниже роли, на которую они выданы.</span>`
        : ''}
    </p>

    ${canCreate
      ? `<button class="btn" id="btnCreateInvite" style="margin-bottom:20px">+ Создать код</button>`
      : `<p class="doc-meta" style="color:var(--danger)">У тебя нет прав создавать приглашения</p>`}

    <div id="invitesList">
      ${visibleInvites.length === 0
        ? '<p class="doc-meta">Кодов пока нет.</p>'
        : visibleInvites.map(i => {
            const usedCount = i.usedCount || 0;
            const maxUses = i.maxUses || 1;
            const expiresAt = i.expiresAt ? new Date(i.expiresAt) : null;
            const isExpired = expiresAt && expiresAt < now;
            const isExhausted = usedCount >= maxUses;

            let statusBadge;
            let rowClass;
            if (isExpired) {
              statusBadge = '<span class="invite-badge expired">⏰ Истёк</span>';
              rowClass = 'expired';
            } else if (isExhausted) {
              statusBadge = '<span class="invite-badge used">✓ Исчерпан</span>';
              rowClass = 'used';
            } else {
              statusBadge = '<span class="invite-badge active">● Активен</span>';
              rowClass = 'active';
            }

            const percent = Math.min(100, Math.round((usedCount / maxUses) * 100));

            return `
              <div class="invite-row ${rowClass}">
                <div class="invite-main">
                  <div class="invite-code">
                    ${escapeHtml(i.code)}
                    <button class="invite-copy-btn" data-copy="${escapeHtml(i.code)}" title="Скопировать">📋</button>
                  </div>
                  <div class="invite-badges">
                    <span class="invite-badge role">🎖 ${escapeHtml(i.role)}</span>
                    ${statusBadge}
                    <span class="invite-badge">👤 ${usedCount}/${maxUses}</span>
                    ${expiresAt ? `<span class="invite-badge">⏱ до ${expiresAt.toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</span>` : ''}
                  </div>
                  <div class="invite-meta">
                    Создал: <strong>${escapeHtml(i.createdByNick)}</strong>${i.createdByRank ? ` (${escapeHtml(i.createdByRank)})` : ''}
                    ${(i.usedByNicks && i.usedByNicks.length) ? `<br>Использовали: ${i.usedByNicks.map(escapeHtml).join(', ')}` : ''}
                  </div>
                  <div class="invite-usage-bar">
                    <div class="invite-usage-fill" style="width:${percent}%"></div>
                  </div>
                </div>
                <div class="invite-actions">
                  <button class="btn danger" data-delinv="${i.id}" title="Удалить">🗑</button>
                </div>
              </div>
            `;
          }).join('')}
    </div>
  `;
}

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
/* ==================== СТРАНИЦЫ ЗАДЕРЖАНИЙ И ШТРАФОВ ==================== */
/* ==================== ОБЁРТКА РЕЕСТРА С ВКЛАДКАМИ ==================== */
function renderRegistry(activeTab) {
  if (!isPolice(currentProfile) && !canReview(currentProfile) && !canManageStaff(currentProfile)) {
    return `<h2>Доступ запрещён</h2>`;
  }
  const tab = activeTab || 'detentions';

  const detCount = cachedDetentions.length;
  const fineCount = cachedFines.length;

  const tabsHtml = `
    <div class="registry-tabs">
      <button class="registry-tab ${tab === 'detentions' ? 'active' : ''}"
              data-reg-tab="detentions">
        📋 Задержания <span class="tab-badge">${detCount}</span>
      </button>
      <button class="registry-tab ${tab === 'fines' ? 'active' : ''}"
              data-reg-tab="fines">
        💰 Штрафы <span class="tab-badge">${fineCount}</span>
      </button>
    </div>
  `;

  // Контент активной вкладки (без заголовка h2 — он уже сверху)
  const content = tab === 'detentions' ? renderDetentions() : renderFines();

  setTimeout(() => {
    document.querySelectorAll('[data-reg-tab]').forEach(b => {
      b.onclick = () => {
        location.hash = '#/registry/' + b.dataset.regTab;
      };
    });
  }, 0);

  return `
    <h2>⚖️ Реестр задержаний и штрафов</h2>
    ${tabsHtml}
    <div class="registry-content">${content}</div>
  `;
}
function renderDetentions() {
  if (!isPolice(currentProfile) && !canReview(currentProfile) && !canManageStaff(currentProfile)) {
    return `<h2>Доступ запрещён</h2>`;
  }
  const canSubmit = isPolice(currentProfile);

  const form = canSubmit ? `
    <div class="form-group">
      <label>ФИО задержанного</label>
      <input id="d-target" type="text" placeholder="Иван Иванов">
    </div>

    ${renderArticleSearch('d-articles-search','d-articles-results','d-articles-selected','detentions')}

    <div class="form-group">
      <label>Срок лишения свободы (минут, 1–${DETENTION_MAX_PRISON_MINUTES})</label>
      <input id="d-prison" type="number" min="1" max="${DETENTION_MAX_PRISON_MINUTES}" placeholder="10">
    </div>

    ${renderPartnerPicker('detentions')}

    <div class="form-group">
      <label class="label-with-attach">
        Комментарий
        <button type="button" class="attach-btn" data-attach-for="detentions">📎 Прикрепить</button>
      </label>
      <textarea id="d-comment" style="min-height:70px" placeholder="Дополнительно... (Ctrl+V для фото)"></textarea>
      <input type="file" multiple accept="image/*,video/*,application/pdf"
             id="upload-input-detentions" style="display:none">
      <div class="upload-list" id="upload-list-detentions"></div>
    </div>

    ${renderDraftIndicator('detentions')}    
    <button class="btn" id="btnSubmitDetention">Записать задержание</button>
    <hr style="margin:24px 0;border-color:var(--line)">
  ` : '';

  setTimeout(() => {
    // Обработчики формы
    document.getElementById('btnSubmitDetention')?.addEventListener('click', submitDetention);
    const dSearch = document.getElementById('d-articles-search');
    if (dSearch) {
      dSearch.addEventListener('input', () =>
        updateLawResults('d-articles-search','d-articles-results','detentions'));
    }
    refreshLawSelection('detentions');
    initFileUploaders();
      // Жёсткая валидация поля срока
  const prisonInput = document.getElementById('d-prison');
  if (prisonInput) {
    prisonInput.addEventListener('input', () => {
      let v = parseInt(prisonInput.value, 10);
      if (isNaN(v)) { prisonInput.value = ''; return; }

      // Обрезаем до максимума
      if (v > DETENTION_MAX_PRISON_MINUTES) {
        prisonInput.value = DETENTION_MAX_PRISON_MINUTES;
        v = DETENTION_MAX_PRISON_MINUTES;
        toast(`Максимум ${DETENTION_MAX_PRISON_MINUTES} минут`, 'err');
      }
      // Не меньше 1
      if (v < 1 && prisonInput.value !== '') {
        prisonInput.value = 1;
      }
      // Красим поле, если достигнут максимум
      prisonInput.classList.toggle('at-limit', v === DETENTION_MAX_PRISON_MINUTES);
    });

    // На всякий случай — блокируем ввод буквы "e", "+", "-" (экспонента/знаки)
    prisonInput.addEventListener('keydown', e => {
      if (['e', 'E', '+', '-'].includes(e.key)) e.preventDefault();
    });

    // При потере фокуса — если пусто, подставляем 1
    prisonInput.addEventListener('blur', () => {
      if (prisonInput.value === '') prisonInput.value = 1;
    });
  }
    initPartnerPicker('detentions');
    // Кнопки действий в карточках
    document.querySelectorAll('[data-det-act]').forEach(b => {
      b.onclick = () => {
        const [act, id] = b.dataset.detAct.split(':');
        if (act === 'accept')  reviewDetention('detentions', id, 'accepted');
        if (act === 'reject')  reviewDetention('detentions', id, 'rejected');
        if (act === 'del')     deleteDetentionRecord('detentions', id);
        if (act === 'release') releaseEarly('detentions', id);
        if (act === 'edit')    editDetention('detentions', id);
      };
    });
    initDraft('detentions', {
      'd-target': 'target',
      'd-prison': 'prison',
      'd-partner': 'partner',
      'd-comment': 'comment'
    });
  }, 0);

  const visible = cachedDetentions.filter(r =>
    canReview(currentProfile) ||
    canManageStaff(currentProfile) ||
    r.authorUid === currentUser.uid ||
    (r.partners || []).some(p => p.uid === currentUser.uid) ||
    (Array.isArray(r.partnerUids) && r.partnerUids.includes(currentUser.uid))
  );

  return `
    <p class="doc-meta">Аресты и сроки лишения свободы</p>
    ${canSubmit ? form : ''}
    <h3 style="color:var(--accent);margin:20px 0 12px">Записи (${visible.length})</h3>
    ${visible.length === 0 ? '<p class="doc-meta">Пока нет записей.</p>' :
      visible.map(r => renderDetentionCard(r)).join('')}
  `;
}

function renderDetentionCard(r) {
  const canRev = canReview(currentProfile);
  const canDel = CAN_DELETE_REPORTS.includes(currentProfile.rank);
  const canRel = canReleaseEarly(currentProfile);
  const canEdit = canEditRecord(r);

  const articles = (r.articles || []).map(a => `
    <div class="law-chip clickable"
         data-law-code="${escapeHtml(a.code)}"
         data-law-type="${escapeHtml(a.codeType)}"
         title="Открыть статью">
      ${escapeHtml(a.code)} ${escapeHtml(a.codeType)}${
        a.wantedLevel ? ' ' + '★'.repeat(a.wantedLevel) : ''
      }
    </div>
  `).join('');

  const edits = (r.edits || []).length ? `
    <div class="edit-history">
      <div class="edit-history-title">⚠️ Редактирования:</div>
      ${r.edits.map(e => `
        <div class="edit-item">
          ${fmtDate(e.at)} — <strong>${escapeHtml(e.by)}</strong> (${escapeHtml(e.rank)})
          <div class="edit-reason">${escapeHtml(e.reason)} · ${escapeHtml(e.changes || '')}</div>
        </div>
      `).join('')}
    </div>
  ` : '';

  const released = r.releasedEarly ? `
    <div class="released-badge">
      🔓 Досрочно освобождён ${fmtDate(r.releasedEarly.at)} —
      ${escapeHtml(r.releasedEarly.by)} (${escapeHtml(r.releasedEarly.rank)})
      <div class="edit-reason">${escapeHtml(r.releasedEarly.reason)}</div>
    </div>
  ` : '';

  const partners = (r.partners || []).length
    ? `<div class="report-type">👥 ${r.partners.map(p => escapeHtml(p.nickname) + ' — ' + escapeHtml(p.rank)).join(', ')}</div>`
    : '';

  return `
    <div class="report-card status-${r.status}">
      <div class="report-head">
        <div class="report-author">${escapeHtml(r.target)}
          <span class="rank">${escapeHtml(r.authorNick)} · ${escapeHtml(r.authorRank)}</span>
        </div>
        <div class="report-date">${fmtDate(r.createdAt)}</div>
      </div>
      <div class="report-type">${statusLabel(r.status)} · ⏱ ${r.prisonMinutes} мин</div>
      ${partners}
      <div class="law-chips">${articles}</div>
      ${renderAttachments(r.files)}
      ${r.comment ? `<div class="report-desc">${escapeHtml(r.comment)}</div>` : ''}
      ${r.reviewComment ? `<div class="report-comment">💬 <strong>${escapeHtml(r.reviewedBy || '')}:</strong> ${escapeHtml(r.reviewComment)}</div>` : ''}
      ${released}
      ${edits}
      <div class="report-actions">
        ${canRev && r.status !== 'accepted' ? `<button class="btn" data-det-act="accept:${r.id}">✓ Принять</button>` : ''}
        ${canRev && r.status !== 'rejected' ? `<button class="btn danger" data-det-act="reject:${r.id}">✗ Отклонить</button>` : ''}
        ${canEdit ? `<button class="btn secondary" data-det-act="edit:${r.id}">✏️ Ред.</button>` : ''}
        ${canRel && !r.releasedEarly ? `<button class="btn secondary" data-det-act="release:${r.id}">🔓 Досрочно</button>` : ''}
        ${canDel ? `<button class="btn secondary" data-det-act="del:${r.id}">🗑</button>` : ''}
      </div>
    </div>
  `;
}

function renderFines() {
  if (!isPolice(currentProfile) && !canReview(currentProfile) && !canManageStaff(currentProfile)) {
    return `<h2>Доступ запрещён</h2>`;
  }
  const canSubmit = isPolice(currentProfile);

  const form = canSubmit ? `
    <div class="form-group"><label>ФИО</label>
      <input id="f-target" type="text" placeholder="Иван Иванов"></div>

    ${renderArticleSearch('f-articles-search','f-articles-results','f-articles-selected','fines')}

    <div class="form-group"><label>Сумма штрафа (exp)</label>
      <input id="f-amount" type="number" min="1" placeholder="10000"></div>

    ${renderPartnerPicker('fines')}

    <div class="form-group">
      <label class="label-with-attach">
        Комментарий
        <button type="button" class="attach-btn" data-attach-for="fines">📎 Прикрепить</button>
      </label>
      <textarea id="f-comment" style="min-height:70px" placeholder="Дополнительно... (Ctrl+V для фото)"></textarea>
      <input type="file" multiple accept="image/*,video/*,application/pdf"
             id="upload-input-fines" style="display:none">
      <div class="upload-list" id="upload-list-fines"></div>
    </div>

    ${renderDraftIndicator('fines')}    
    <button class="btn" id="btnSubmitFine">Записать штраф</button>
    <hr style="margin:24px 0;border-color:var(--line)">
  ` : '';

  setTimeout(() => {
    document.getElementById('btnSubmitFine')?.addEventListener('click', submitFine);
    const fSearch = document.getElementById('f-articles-search');
    if (fSearch) {
      fSearch.addEventListener('input', () =>
        updateLawResults('f-articles-search','f-articles-results','fines'));
    }
    refreshLawSelection('fines');
    initFileUploaders();
    initPartnerPicker('fines');
    document.querySelectorAll('[data-fine-act]').forEach(b => {
      b.onclick = () => {
        const [act, id] = b.dataset.fineAct.split(':');
        if (act === 'accept') reviewDetention('fines', id, 'accepted');
        if (act === 'reject') reviewDetention('fines', id, 'rejected');
        if (act === 'del')    deleteDetentionRecord('fines', id);
        if (act === 'edit')   editDetention('fines', id);
      };
    });
    initDraft('fines', {
      'f-target': 'target',
      'f-amount': 'amount',
      'f-partner': 'partner',
      'f-comment': 'comment'
    });
  }, 0);

  const visible = cachedFines.filter(r =>
    canReview(currentProfile) ||
    canManageStaff(currentProfile) ||
    r.authorUid === currentUser.uid ||
    (r.partners || []).some(p => p.uid === currentUser.uid)
);

  return `
    <p class="doc-meta">Штрафы в exp</p>
    ${canSubmit ? form : ''}
    <h3 style="color:var(--accent);margin:20px 0 12px">Записи (${visible.length})</h3>
    ${visible.length === 0 ? '<p class="doc-meta">Пока нет записей.</p>' :
      visible.map(r => renderFineCard(r)).join('')}
  `;
}

function renderFineCard(r) {
  const canRev = canReview(currentProfile);
  const canDel = CAN_DELETE_REPORTS.includes(currentProfile.rank);
  const canEdit = canEditRecord(r);

  const articles = (r.articles || []).map(a => `
    <div class="law-chip clickable"
         data-law-code="${escapeHtml(a.code)}"
         data-law-type="${escapeHtml(a.codeType)}"
         title="Открыть статью">
      ${escapeHtml(a.code)} ${escapeHtml(a.codeType)}${
        a.wantedLevel ? ' ' + '★'.repeat(a.wantedLevel) : ''
      }
    </div>
  `).join('');

  const edits = (r.edits || []).length ? `
    <div class="edit-history">
      <div class="edit-history-title">⚠️ Редактирования:</div>
      ${r.edits.map(e => `
        <div class="edit-item">
          ${fmtDate(e.at)} — <strong>${escapeHtml(e.by)}</strong> (${escapeHtml(e.rank)})
          <div class="edit-reason">${escapeHtml(e.reason)} · ${escapeHtml(e.changes || '')}</div>
        </div>
      `).join('')}
    </div>
  ` : '';

  const partners = (r.partners || []).length
    ? `<div class="report-type">👥 ${r.partners.map(p => escapeHtml(p.nickname)).join(', ')}</div>`
    : '';

  return `
    <div class="report-card status-${r.status}">
      <div class="report-head">
        <div class="report-author">${escapeHtml(r.target)}
          <span class="rank">${escapeHtml(r.authorNick)} · ${escapeHtml(r.authorRank)}</span>
        </div>
        <div class="report-date">${fmtDate(r.createdAt)}</div>
      </div>
      <div class="report-type">${statusLabel(r.status)} · 💰 ${Number(r.amount).toLocaleString('ru-RU')} exp</div>
      ${partners}
      <div class="law-chips">${articles}</div>
      ${renderAttachments(r.files)}
      ${r.comment ? `<div class="report-desc">${escapeHtml(r.comment)}</div>` : ''}
      ${r.reviewComment ? `<div class="report-comment">💬 <strong>${escapeHtml(r.reviewedBy || '')}:</strong> ${escapeHtml(r.reviewComment)}</div>` : ''}
      ${edits}
      <div class="report-actions">
        ${canRev && r.status !== 'accepted' ? `<button class="btn" data-fine-act="accept:${r.id}">✓ Принять</button>` : ''}
        ${canRev && r.status !== 'rejected' ? `<button class="btn danger" data-fine-act="reject:${r.id}">✗ Отклонить</button>` : ''}
        ${canEdit ? `<button class="btn secondary" data-fine-act="edit:${r.id}">✏️ Ред.</button>` : ''}
        ${canDel ? `<button class="btn secondary" data-fine-act="del:${r.id}">🗑</button>` : ''}
      </div>
    </div>
  `;
}
/* ==================== ТЕСТЫ — ИНТЕРФЕЙС ==================== */

// Виден ли тест пользователю (новая логика через audienceRoles)
function canSeeTestDynamic(test, profile) {
  if (!profile) return false;

  // Полковник+ и Старший админ видят всё
  if (canSeeAllTests(profile)) return true;

  // Если массив ролей не задан или пуст — видят все (legacy)
  const roles = test.audienceRoles;
  if (!Array.isArray(roles) || roles.length === 0) return true;

  // Иначе — только если роль пользователя в списке
  return roles.includes(profile.rank);
}

// Бейдж аудитории — теперь на основе массива ролей
function testAudienceBadgeDynamic(test) {
  const roles = test.audienceRoles;

  // Если массив не задан или пуст → видят все
  if (!Array.isArray(roles) || roles.length === 0) {
    return `<span class="test-badge" style="border-color:#2ecc71;color:#2ecc71">Для всех</span>`;
  }

  // Один-два — показываем имена
  if (roles.length <= 2) {
    return roles.map(r =>
      `<span class="test-badge" style="border-color:#f0b429;color:#f0b429">${escapeHtml(r)}</span>`
    ).join(' ');
  }

  // Три и больше — «N ролей»
  return `<span class="test-badge" style="border-color:#f0b429;color:#f0b429">🎖 ${roles.length} ролей</span>`;
}

/* ==================== РЕДАКТОР ТЕСТА ==================== */
// Временно — заглушка, реализация на 4.3.2
/* ==================== МОДАЛКА ВОПРОСА ==================== */
function openQuestionModal(testId, questionId) {
  if (!canManageTests(currentProfile)) return toast('Нет прав', 'err');

  const test = cachedTests.find(t => t.id === testId);
  if (!test) return toast('Тест не найден', 'err');

  const isEdit = !!questionId;
  const existing = isEdit ? (test.questions || []).find(q => q.id === questionId) : null;

  // Сбрасываем pendingFiles.question
  pendingFiles.question = [];

  // Начальные варианты
  let initialOptions = existing?.options?.length
    ? existing.options.map(o => ({ text: o.text || '', correct: !!o.correct }))
    : [
        { text: '', correct: false },
        { text: '', correct: false }
      ];

  // Считаем правильные для определения режима
  const initialCorrectCount = initialOptions.filter(o => o.correct).length;

  openModal(`
    <h3>${isEdit ? '✏️ Редактировать вопрос' : '➕ Новый вопрос'}</h3>

    <div class="form-group">
      <label>Текст вопроса *</label>
      <textarea id="q-text" placeholder="Что нужно спросить?" style="min-height:80px">${existing ? escapeHtml(existing.text || '') : ''}</textarea>
    </div>

    <div class="form-group">
      <label class="label-with-attach">
        Картинка к вопросу
        <button type="button" class="attach-btn" data-attach-for="question">📎 Прикрепить</button>
      </label>
      <input type="file" accept="image/*" id="upload-input-question" style="display:none">
      <div class="upload-list" id="upload-list-question"></div>
      <div class="existing-q-image" id="existingQImageWrap" style="${existing?.image ? '' : 'display:none'}">
        <img src="${existing?.image ? escapeHtml(existing.image) : ''}" id="existingQImage" alt="">
        <button type="button" class="existing-q-image-remove" id="btnRemoveExistingQImage">×</button>
      </div>
      <div class="q-image-hint">Можно вставить через Ctrl+V</div>
    </div>

    <div class="form-group">
      <label>Варианты ответа *</label>
      <div class="q-options-mode-hint" id="qOptionsModeHint"></div>
      <div class="question-options ${initialCorrectCount >= 2 ? 'mode-multi' : 'mode-single'}" id="qOptionsList">
        ${initialOptions.map((o, i) => renderQuestionOptionRow(o, i)).join('')}
      </div>
      <button type="button" class="btn secondary tiny" id="btnAddOption" style="margin-top:10px;width:auto;padding:6px 14px;font-size:12px">+ Добавить вариант</button>
      <div class="q-options-help">
        Клик по кружку/квадрату слева — пометить как правильный.<br>
        Если правильный <strong>один</strong> — это кружок, если <strong>больше одного</strong> — квадрат.
      </div>
    </div>

    <div class="modal-actions">
      <button class="btn secondary" data-cancel>Отмена</button>
      <button class="btn" data-confirm>${isEdit ? 'Сохранить' : 'Добавить'}</button>
    </div>
  `, (overlay, close) => {
    let existingImageRemoved = false;

    const optionsList = overlay.querySelector('#qOptionsList');
    const modeHint = overlay.querySelector('#qOptionsModeHint');

    // Функция перерисовки режима
    function updateMode() {
      const correctCount = optionsList.querySelectorAll('.q-opt-row.correct').length;
      optionsList.classList.toggle('mode-single', correctCount <= 1);
      optionsList.classList.toggle('mode-multi', correctCount >= 2);
      modeHint.innerHTML = correctCount >= 2
        ? `🔲 Режим: <strong>несколько правильных</strong> (${correctCount})`
        : `⚪ Режим: <strong>один правильный</strong>`;
    }

    // Обработчики на варианты
    function attachRowEvents(row) {
      row.querySelector('.opt-marker').onclick = () => {
        row.classList.toggle('correct');
        updateMode();
      };
      row.querySelector('.opt-del')?.addEventListener('click', () => {
        const rows = optionsList.querySelectorAll('.q-opt-row');
        if (rows.length <= 2) return toast('Минимум 2 варианта', 'err');
        row.remove();
        updateMode();
      });
    }

    optionsList.querySelectorAll('.q-opt-row').forEach(attachRowEvents);
    updateMode();

    // Добавить вариант
    overlay.querySelector('#btnAddOption').onclick = () => {
      const rows = optionsList.querySelectorAll('.q-opt-row');
      if (rows.length >= 6) return toast('Максимум 6 вариантов', 'err');
      const newRow = document.createElement('div');
      newRow.className = 'q-opt-row';
      newRow.innerHTML = `
        <button type="button" class="opt-marker"></button>
        <input type="text" class="opt-text" placeholder="Вариант ${rows.length + 1}">
        <button type="button" class="opt-del" title="Удалить">×</button>
      `;
      optionsList.appendChild(newRow);
      attachRowEvents(newRow);
      newRow.querySelector('.opt-text').focus();
    };

    // Удаление существующей картинки
    overlay.querySelector('#btnRemoveExistingQImage')?.addEventListener('click', () => {
      existingImageRemoved = true;
      overlay.querySelector('#existingQImageWrap').style.display = 'none';
    });

    // Инициализируем загрузчик файлов
    initFileUploaders();

    // Отмена
    overlay.querySelector('[data-cancel]').onclick = close;

    // Сохранение
    overlay.querySelector('[data-confirm]').onclick = async () => {
      const text = overlay.querySelector('#q-text').value.trim();
      if (!text) return toast('Введи текст вопроса', 'err');

      const rows = Array.from(optionsList.querySelectorAll('.q-opt-row'));
      const options = rows.map(row => ({
        text: row.querySelector('.opt-text').value.trim(),
        correct: row.classList.contains('correct')
      }));

      if (options.some(o => !o.text)) return toast('Заполни все варианты', 'err');
      const correctCount = options.filter(o => o.correct).length;
      if (correctCount === 0) return toast('Отметь хотя бы один правильный ответ', 'err');

      // Обработка картинки
      let image = existing?.image || '';
      if (existingImageRemoved) image = '';

      // Загружаем новый файл, если он есть
      if (pendingFiles.question.length > 0) {
        toast('Загрузка картинки...');
        const uploaded = await uploadAllFiles(pendingFiles.question, 'tests');
        if (uploaded.length > 0) image = uploaded[0].url;
      }

      // Сохраняем
      if (isEdit) {
        await updateQuestion(testId, questionId, { text, image, options });
      } else {
        await addQuestion(testId, { text, image, options });
      }

      pendingFiles.question = [];
      close();
    };
  });
}

function renderQuestionOptionRow(opt, idx) {
  const cls = opt.correct ? 'q-opt-row correct' : 'q-opt-row';
  return `
    <div class="${cls}">
      <button type="button" class="opt-marker"></button>
      <input type="text" class="opt-text" placeholder="Вариант ${idx + 1}" value="${escapeHtml(opt.text || '')}">
      <button type="button" class="opt-del" title="Удалить">×</button>
    </div>
  `;
}
function renderTestEditor(testId) {
  if (!canManageTests(currentProfile)) {
    return `<h2>Доступ запрещён</h2>
      <p class="doc-meta">Только ${TEST_MANAGER_ROLES.join(', ')} может редактировать тесты.</p>`;
  }

  const test = cachedTests.find(t => t.id === testId);
  if (!test) {
    return `<h2>Тест не найден</h2>
      <button class="btn" onclick="location.hash='#/tests'">← К списку</button>`;
  }

  const questions = test.questions || [];
  const roles = test.audienceRoles || [];
  const rolesText = roles.length === 0
    ? 'Для всех ролей'
    : roles.length <= 3
      ? roles.join(', ')
      : `${roles.length} ролей`;

  setTimeout(() => {
    // Обработчики
    document.getElementById('btnEditSettings')?.addEventListener('click', () => {
      openTestCreateModal(test);
    });

    document.getElementById('btnAddQuestion')?.addEventListener('click', () => {
      openQuestionModal(testId, null, questions.length);
    });

    // Управление вопросами
    document.querySelectorAll('[data-q-action]').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const [action, qid] = btn.dataset.qAction.split(':');
        if (action === 'edit')   openQuestionModal(testId, qid);
        if (action === 'del')    deleteQuestion(testId, qid);
        if (action === 'up')     moveQuestion(testId, qid, -1);
        if (action === 'down')   moveQuestion(testId, qid, 1);
        if (action === 'dup')    duplicateQuestion(testId, qid);
      };
    });

    // Кнопка «Просмотр теста»
    document.getElementById('btnPreviewTest')?.addEventListener('click', () => {
      if (questions.length === 0) return toast('Сначала добавь вопросы', 'err');
      startTestRun(testId);
    });

    // Переключение скрытности
    document.getElementById('btnToggleHidden')?.addEventListener('click', async () => {
      await updateTest(testId, { hidden: !test.hidden });
    });

    // Удаление теста
    document.getElementById('btnDeleteTest')?.addEventListener('click', async () => {
      if (!confirm('Удалить тест со всеми вопросами? Это действие необратимо.')) return;
      await deleteTest(testId);
      location.hash = '#/tests';
    });
  }, 0);

  return `
    <button class="btn secondary" style="margin-bottom:16px" onclick="location.hash='#/tests'">← К списку тестов</button>

    <div class="editor-header">
      <div>
        <h2 style="margin-bottom:4px">${test.hidden ? '🔒 ' : ''}${escapeHtml(test.title)}</h2>
        <p class="doc-meta" style="margin:0">
          ${escapeHtml(rolesText)} · Проходной: ${test.passScore}% · 
          ${test.timeLimit > 0 ? `⏱ ${Math.floor(test.timeLimit/60)} мин` : '⏱ без лимита'} · 
          ${questions.length} ${questions.length === 1 ? 'вопрос' : 'вопросов'}
        </p>
      </div>
      <div class="editor-header-actions">
        <button class="btn secondary" id="btnEditSettings">⚙️ Настройки</button>
        <button class="btn secondary" id="btnPreviewTest">👁 Просмотр</button>
        <button class="btn secondary" id="btnToggleHidden">${test.hidden ? '👁 Показать' : '🔒 Скрыть'}</button>
        <button class="btn danger" id="btnDeleteTest">🗑 Удалить</button>
      </div>
    </div>

    <div class="editor-toolbar">
      <button class="btn" id="btnAddQuestion">+ Добавить вопрос</button>
    </div>

    <div class="editor-questions">
      ${questions.length === 0
        ? '<p class="doc-meta">Пока нет вопросов. Нажми «+ Добавить вопрос», чтобы начать.</p>'
        : questions.map((q, i) => renderQuestionRow(q, i, testId)).join('')}
    </div>
  `;
}

// Одна строка вопроса в списке редактора
function renderQuestionRow(q, idx, testId) {
  const optCount = (q.options || []).length;
  const correctCount = (q.options || []).filter(o => o.correct).length;
  const hasImage = !!q.image;

  const optionsPreview = (q.options || []).map((o, i) => {
    const marker = o.correct ? '✓' : '○';
    const cls = o.correct ? 'correct' : '';
    return `<div class="q-opt-preview ${cls}">${marker} ${escapeHtml(o.text || '—')}</div>`;
  }).join('');

  return `
    <div class="editor-question-card">
      <div class="eq-head">
        <div class="eq-number">${idx + 1}</div>
        <div class="eq-body">
          <div class="eq-text">${escapeHtml(q.text || '— без текста —')}</div>
          <div class="eq-meta">
            ${optCount} ${optCount === 1 ? 'вариант' : 'вариантов'} · 
            ${correctCount} ${correctCount === 1 ? 'правильный' : 'правильных'}
            ${hasImage ? ' · 🖼 с картинкой' : ''}
          </div>
        </div>
        <div class="eq-actions">
          <button class="eq-btn" data-q-action="up:${q.id}" title="Вверх">↑</button>
          <button class="eq-btn" data-q-action="down:${q.id}" title="Вниз">↓</button>
          <button class="eq-btn" data-q-action="dup:${q.id}" title="Дублировать">📋</button>
          <button class="eq-btn edit" data-q-action="edit:${q.id}" title="Редактировать">✏️</button>
          <button class="eq-btn del" data-q-action="del:${q.id}" title="Удалить">🗑</button>
        </div>
      </div>
      ${hasImage ? `
        <div class="eq-image-preview">
          <img src="${escapeHtml(q.image)}" alt="" onerror="this.style.display='none'">
        </div>
      ` : ''}
      <div class="eq-options-preview">
        ${optionsPreview}
      </div>
    </div>
  `;
}

// Дублирование вопроса
async function duplicateQuestion(testId, questionId) {
  if (!canManageTests(currentProfile)) return toast('Нет прав', 'err');
  const test = cachedTests.find(t => t.id === testId);
  if (!test) return;

  const original = (test.questions || []).find(q => q.id === questionId);
  if (!original) return;

  const copy = {
    id: 'q_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
    text: (original.text || '') + ' (копия)',
    image: original.image || '',
    options: (original.options || []).map(o => ({ text: o.text, correct: o.correct })),
    createdAt: new Date().toISOString()
  };

  const newQuestions = [...(test.questions || []), copy];
  await updateDoc(doc(db,'tests',testId), {
    questions: newQuestions,
    questionsEditedAt: new Date().toISOString(),
    updatedAt: serverTimestamp(),
    updatedBy: currentProfile.nickname
  });
  toast('Вопрос продублирован');
}

function renderTests() {
  const available = cachedTests.filter(t => {
    if (t.hidden && !canManageTests(currentProfile) && !canSeeAllTests(currentProfile)) return false;
    return canSeeTestDynamic(t, currentProfile);
  });
  const canManage = canManageTests(currentProfile);
  const canViewHistory = lvl(currentProfile.rank) >= 13 || canManage;

  const lastResult = (testId) => {
    const mine = cachedTestResults
      .filter(r => r.testId === testId && r.userId === currentUser.uid)
      .sort((a,b) => {
        const ta = a.finishedAt?.toDate?.() || new Date(a.finishedAt || 0);
        const tb = b.finishedAt?.toDate?.() || new Date(b.finishedAt || 0);
        return tb - ta;
      });
    return mine[0] || null;
  };

  const cardsHtml = available.map(t => {
    const qCount = (t.questions || []).length;
    const last = lastResult(t.id);
    const timerInfo = t.timeLimit > 0
      ? `⏱ ${Math.floor(t.timeLimit / 60)} мин`
      : '⏱ без лимита';

    let statusBlock = '';
    if (last) {
      const cls = last.passed ? 'pass' : 'fail';
      const icon = last.passed ? '✅' : '❌';
      statusBlock = `
        <div class="test-last-result ${cls}">
          ${icon} Твой последний результат: <strong>${last.percent}%</strong>
          (${last.score}/${last.total})
        </div>
      `;
    }

    return `
      <div class="card test-card ${t.hidden ? 'test-hidden' : ''}" data-test-id="${t.id}">
        <h4>${t.hidden ? '🔒 ' : ''}${escapeHtml(t.title)}</h4>
        ${t.description ? `<p style="margin-bottom:8px">${escapeHtml(t.description)}</p>` : ''}
        <div class="test-card-meta">
          <span>📝 ${qCount} вопросов</span>
          <span>🎯 Проходной: ${t.passScore}%</span>
          <span>${timerInfo}</span>
        </div>
        ${testAudienceBadgeDynamic(t)}
        ${statusBlock}
        <div class="test-card-actions">
          <button class="btn" data-start-test="${t.id}">${last ? 'Пройти заново' : 'Пройти тест'}</button>
          ${canViewHistory ? `<button class="btn secondary" data-test-history="${t.id}">📊 Результаты</button>` : ''}
          ${canManage ? `<button class="btn secondary" data-edit-test="${t.id}">✏️ Редактировать</button>` : ''}
        </div>
      </div>
    `;
  }).join('');

  setTimeout(() => {
    document.querySelectorAll('[data-start-test]').forEach(b => {
      b.onclick = () => startTestRun(b.dataset.startTest);
    });
    document.querySelectorAll('[data-test-history]').forEach(b => {
      b.onclick = () => { location.hash = '#/test-history/' + b.dataset.testHistory; };
    });
    document.querySelectorAll('[data-edit-test]').forEach(b => {
      b.onclick = () => { location.hash = '#/test-editor/' + b.dataset.editTest; };
    });
    document.getElementById('btnCreateTest')?.addEventListener('click', () => {
      openTestCreateModal(null);
    });
  }, 0);

  return `
    <h2>🎓 Тесты</h2>
    <p class="doc-meta">Доступно тестов: ${available.length}</p>

    ${canManage ? `
      <button class="btn" id="btnCreateTest" style="margin-bottom:20px">+ Создать тест</button>
    ` : ''}

    ${available.length === 0
      ? '<p class="doc-meta">Для твоей роли пока нет доступных тестов.</p>'
      : `<div class="cards">${cardsHtml}</div>`}
  `;
}

// ---------- Начать прохождение ----------
function startTestRun(testId) {
  const test = cachedTests.find(t => t.id === testId);
  if (!test) return toast('Тест не найден', 'err');

  const questions = (test.questions || []).slice();
  if (questions.length === 0) return toast('В тесте нет вопросов', 'err');

  if (test.shuffleQuestions) {
    for (let i = questions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [questions[i], questions[j]] = [questions[j], questions[i]];
    }
  }

  if (test.shuffleOptions) {
    questions.forEach(q => {
      const opts = q.options.slice();
      // Запоминаем правильные по тексту, потом восстановим
      const correctTexts = opts.filter(o => o.correct).map(o => o.text);
      for (let i = opts.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [opts[i], opts[j]] = [opts[j], opts[i]];
      }
      q.options = opts;
      // correct уже внутри опций, ничего восстанавливать не надо
    });
  }

  const startedAt = new Date().toISOString();
  const endsAt = test.timeLimit > 0
    ? Date.now() + test.timeLimit * 1000
    : null;

  currentTestRun = {
    testId,
    test,
    questions,
    startedAt,
    endsAt,
    currentIndex: 0,
    answers: {},       // { [questionIndex]: [selectedOptionIndexes] }
    timerId: null
  };

  // 💾 Сохраняем тест в localStorage на случай обновления или ухода
  localStorage.setItem('ppd_active_test', JSON.stringify(currentTestRun));

  location.hash = '#/test-run';
}

// ---------- Страница прохождения ----------
function renderTestRun() {
  if (!currentTestRun) {
    return `
      <h2>Тест не запущен</h2>
      <p class="doc-meta">Вернись к списку тестов.</p>
      <button class="btn" onclick="location.hash='#/tests'">← К списку тестов</button>
    `;
  }

  const run = currentTestRun;
  const total = run.questions.length;
  const q = run.questions[run.currentIndex];
  const selected = run.answers[run.currentIndex] || [];
  const isLast = run.currentIndex === total - 1;
  const progress = Math.round(((run.currentIndex + 1) / total) * 100);

  const timerHtml = run.endsAt
    ? `<div class="test-timer" id="testTimer">⏱ —</div>`
    : '';

  const imageHtml = q.image
    ? `<div class="test-image-wrap">
        <img src="${escapeHtml(q.image)}" alt="" class="test-image"
             onerror="this.parentElement.innerHTML='<div class=&quot;test-image-error&quot;>Изображение недоступно</div>'">
      </div>`
    : '';

  // Определяем режим: один правильный → radio, несколько → checkbox
  const correctCount = q.options.filter(o => o.correct).length;
  const isMulti = correctCount > 1;
  const inputType = isMulti ? 'checkbox' : 'radio';

  const optionsHtml = q.options.map((o, i) => `
    <label class="option ${selected.includes(i) ? 'selected' : ''}" data-opt-idx="${i}">
      <input type="${inputType}" name="q-opt" value="${i}" ${selected.includes(i) ? 'checked' : ''}>
      ${escapeHtml(o.text)}
    </label>
  `).join('');

  setTimeout(() => {
    // Обработчики выбора
    document.querySelectorAll('input[name="q-opt"]').forEach(inp => {
      inp.onchange = () => {
        const idx = parseInt(inp.value, 10);

        if (inputType === 'checkbox') {
          // Множественный выбор — работаем с массивом
          let current = run.answers[run.currentIndex] || [];
          if (inp.checked) {
            if (!current.includes(idx)) current = [...current, idx];
          } else {
            current = current.filter(v => v !== idx);
          }
          run.answers[run.currentIndex] = current.sort((a,b) => a-b);
        } else {
          // Одиночный — заменяем целиком
          run.answers[run.currentIndex] = [idx];
          document.querySelectorAll('.option').forEach(o => o.classList.remove('selected'));
        }

        // Обновляем визуальную подсветку
        inp.closest('.option').classList.toggle('selected', inp.checked);

        // 💾 Обновляем сохранение
        localStorage.setItem('ppd_active_test', JSON.stringify(currentTestRun));
      };
    });
    // Кнопка далее/завершить
    document.getElementById('btnNextQ').onclick = () => {
      if (!run.answers[run.currentIndex]) {
        return toast('Выбери ответ', 'err');
      }
      if (isLast) {
        finishTestRun();
      } else {
        run.currentIndex++;
        render();  // ⬅️ перерисовка напрямую
      }
    };

    // Таймер
    if (run.endsAt) {
      startTestTimer();
    }
  }, 0);

  return `
    <div class="test-header">
      <div class="test-progress-info">
        Вопрос <strong>${run.currentIndex + 1}</strong> из <strong>${total}</strong>
      </div>
      ${timerHtml}
    </div>
    <div class="test-progress-bar">
      <div class="test-progress-fill" style="width:${progress}%"></div>
    </div>

    <div class="question">
      <p>${run.currentIndex + 1}. ${escapeHtml(q.text)}</p>
      ${imageHtml}
      <div class="test-options">
        ${optionsHtml}
      </div>
    </div>

    <button class="btn" id="btnNextQ" style="margin-top:16px">
      ${isLast ? '🏁 Завершить тест' : 'Следующий →'}
    </button>
  `;
}

// ---------- Таймер прохождения ----------
function startTestTimer() {
  const run = currentTestRun;
  if (!run || !run.endsAt) return;
  if (run.timerId) clearInterval(run.timerId);

  const update = () => {
    const el = document.getElementById('testTimer');
    if (!el) return;
    const left = Math.max(0, Math.floor((run.endsAt - Date.now()) / 1000));
    const m = Math.floor(left / 60);
    const s = left % 60;
    el.textContent = `⏱ ${m}:${s.toString().padStart(2,'0')}`;
    el.classList.toggle('warning', left <= 60);
    if (left <= 0) {
      clearInterval(run.timerId);
      run.timerId = null;
      toast('Время вышло! Тест завершён автоматически', 'err');
      finishTestRun();
    }
  };
  update();
  run.timerId = setInterval(update, 1000);
}

// ---------- Завершение теста ----------
async function finishTestRun() {
  const run = currentTestRun;
  if (!run) return;

  if (run.timerId) {
    clearInterval(run.timerId);
    run.timerId = null;
  }

  const total = run.questions.length;
  let score = 0;
  const answerLog = [];

  run.questions.forEach((q, idx) => {
    const selected = run.answers[idx] || [];
    const correctIdxs = q.options
      .map((o, i) => o.correct ? i : -1)
      .filter(i => i >= 0);

    // Правильно, если выбраны ВСЕ правильные и НИ ОДИН неправильный
    const sortedSel = [...selected].sort((a,b) => a-b);
    const sortedCor = [...correctIdxs].sort((a,b) => a-b);
    const isCorrect =
      sortedSel.length === sortedCor.length &&
      sortedSel.every((v, i) => v === sortedCor[i]);

    if (isCorrect) score++;

    answerLog.push({
      questionId: q.id,
      questionText: q.text,
      selectedOptions: selected.map(i => q.options[i]?.text || ''),
      correctOptions: correctIdxs.map(i => q.options[i]?.text || ''),
      isCorrect
    });
  });

  const percent = total > 0 ? Math.round((score / total) * 100) : 0;
  const passed = percent >= (run.test.passScore || 80);

  const resultId = await saveTestResultAndGetId(
    run.test, answerLog, score, total, percent, passed, run.startedAt
  );

  currentTestRun = null;
  localStorage.removeItem('ppd_active_test'); // 🧹 Очищаем, т.к. тест сдан
  location.hash = '#/test-result/' + resultId;
}

async function saveTestResultAndGetId(test, answers, score, total, percent, passed, startedAt) {
  const ref = await addDoc(collection(db,'testResults'), {
    testId: test.id,
    testTitle: test.title,
    userId: currentUser.uid,
    userNick: currentProfile.nickname,
    userRank: currentProfile.rank,
    score,
    total,
    percent,
    passed,
    answers,
    startedAt: startedAt || new Date().toISOString(),
    finishedAt: serverTimestamp(),
    audience: test.audience || 'all',
    testQuestionsEditedAt: test.questionsEditedAt || null   // ⬅️ НОВОЕ ПОЛЕ
  });
  return ref.id;
}

// Проверяет, был ли тест изменён после прохождения
function isTestOutdated(result) {
  if (!result.testQuestionsEditedAt) return false;    // старая запись — не знаем
  const test = cachedTests.find(t => t.id === result.testId);
  if (!test || !test.questionsEditedAt) return false;
  return new Date(test.questionsEditedAt) > new Date(result.testQuestionsEditedAt);
}

// ---------- Страница результата ----------
function renderTestResult(resultId) {
  setTimeout(() => {
    const box = document.getElementById('testResultBox');
    if (!box) return;

    const r = cachedTestResults.find(x => x.id === resultId);
    if (!r) {
      box.innerHTML = '<p class="doc-meta">Загрузка результата...</p>';
      setTimeout(() => renderTestResult(resultId), 500);
      return;
    }

    // Проверка прав: свой результат или Полковник+
    const canViewDetails = r.userId === currentUser.uid || lvl(currentProfile.rank) >= 13;

    const answersHtml = (canViewDetails && r.answers) ? `
      <h3 class="profile-section-title">📋 Разбор ответов</h3>
      ${r.answers.map((a, i) => `
        <div class="test-review-item ${a.isCorrect ? 'correct' : 'wrong'}">
          <div class="test-review-head">
            <span>${i+1}. ${escapeHtml(a.questionText)}</span>
            <span class="test-review-icon">${a.isCorrect ? '✅' : '❌'}</span>
          </div>
          <div class="test-review-answers">
            <div>Твой ответ: <span class="${a.isCorrect ? 'ok' : 'err'}">${a.selectedOptions.map(escapeHtml).join(', ') || '— не отвечено —'}</span></div>
            ${!a.isCorrect ? `<div>Правильно: <span class="ok">${a.correctOptions.map(escapeHtml).join(', ')}</span></div>` : ''}
          </div>
        </div>
      `).join('')}
    ` : '';

    const outdated = isTestOutdated(r);

    box.innerHTML = `
      ${r.failReason ? `
        <div class="test-outdated-notice" style="border-color:var(--danger);color:var(--danger);background:rgba(231,76,60,.1); box-shadow: 0 0 20px rgba(231,76,60,.2);">
          🚨 <strong>ТЕСТ ПРОВАЛЕН ДОСРОЧНО</strong><br>
          Причина: ${escapeHtml(r.failReason)}
        </div>
      ` : ''}

      ${outdated ? `
        <div class="test-outdated-notice">
          ⚠️ <strong>Тест был изменён после этой попытки.</strong><br>
          Вопросы могли поменяться — актуальность разбора ниже может быть под вопросом.
        </div>
      ` : ''}

      <div class="result ${r.passed ? 'pass' : 'fail'}" style="margin-bottom:20px">
        ${r.passed ? '✅ ТЕСТ ПРОЙДЕН' : '❌ ТЕСТ НЕ ПРОЙДЕН'}<br>
        <span style="font-size:24px">${r.score}/${r.total} (${r.percent}%)</span>
        <div style="font-size:13px;margin-top:8px;opacity:.8">
          Тест: ${escapeHtml(r.testTitle)}
        </div>
      </div>
      <div class="doc-meta">Проходной балл: ${r.percent >= 0 ? 'см. тест' : '—'} · ${fmtDate(r.finishedAt)}</div>

      ${answersHtml}

      <div style="margin-top:20px;display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn" id="btnBackToTests">← К списку тестов</button>
        <button class="btn secondary" id="btnRetakeTest" data-test-id="${r.testId}">🔄 Пройти заново</button>
      </div>
    `;

    document.getElementById('btnBackToTests')?.addEventListener('click', () => {
      location.hash = '#/tests';
    });
    document.getElementById('btnRetakeTest')?.addEventListener('click', (e) => {
      startTestRun(e.currentTarget.dataset.testId);
    });
  }, 0);

  return `
    <h2>Результат теста</h2>
    <div id="testResultBox"><p class="doc-meta">Загрузка...</p></div>
  `;
}

// ---------- История результатов теста ----------
function renderTestHistory(testId) {
  if (lvl(currentProfile.rank) < 13 && !canManageTests(currentProfile)) {
    return `<h2>Доступ запрещён</h2>`;
  }

  const test = cachedTests.find(t => t.id === testId);
  if (!test) return `<h2>Тест не найден</h2>`;

  // Считаем границу периода
  const now = Date.now();
  let periodStart = 0;
  if (testHistoryFilters.period === 'today') {
    const d = new Date();
    d.setHours(0,0,0,0);
    periodStart = d.getTime();
  } else if (testHistoryFilters.period === 'week') {
    periodStart = now - 7 * 24 * 3600 * 1000;
  } else if (testHistoryFilters.period === 'month') {
    periodStart = now - 30 * 24 * 3600 * 1000;
  }

  const toMs = r => {
    const t = r.finishedAt;
    return t?.toDate ? t.toDate().getTime() : new Date(t || 0).getTime();
  };

  // Фильтруем
  let results = testResultsFor(testId).filter(r => {
    if (testHistoryFilters.status === 'pass' && !r.passed) return false;
    if (testHistoryFilters.status === 'fail' && r.passed) return false;
    if (periodStart && toMs(r) < periodStart) return false;
    if (testHistoryFilters.search) {
      const q = testHistoryFilters.search.toLowerCase();
      if (!(r.userNick || '').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  // Сортируем
  if (testHistorySort === 'date') {
    results.sort((a,b) => toMs(b) - toMs(a));
  } else if (testHistorySort === 'score') {
    results.sort((a,b) => (b.percent || 0) - (a.percent || 0));
  } else if (testHistorySort === 'name') {
    results.sort((a,b) => (a.userNick || '').localeCompare(b.userNick || '', 'ru'));
  }

  // Общая статистика (по всем, не по фильтру)
  const allResults = testResultsFor(testId);
  const passedCount = allResults.filter(r => r.passed).length;
  const failCount = allResults.length - passedCount;

  setTimeout(() => {
    // Поиск по имени
    const searchInput = document.getElementById('testHistorySearch');
    if (searchInput) {
      searchInput.value = testHistoryFilters.search;
      searchInput.oninput = (e) => {
        testHistoryFilters.search = e.target.value;
        // Перерисовываем только список, без сброса фокуса
        refreshTestHistoryList(testId);
      };
    }

    // Фильтр по статусу
    document.querySelectorAll('[data-th-status]').forEach(b => {
      b.onclick = () => {
        testHistoryFilters.status = b.dataset.thStatus;
        render();
      };
    });

    // Фильтр по периоду
    document.querySelectorAll('[data-th-period]').forEach(b => {
      b.onclick = () => {
        testHistoryFilters.period = b.dataset.thPeriod;
        render();
      };
    });

    // Сортировка
    const sortSel = document.getElementById('testHistorySort');
    if (sortSel) {
      sortSel.value = testHistorySort;
      sortSel.onchange = () => {
        testHistorySort = sortSel.value;
        render();
      };
    }

    // Клик на строку → детали
    document.querySelectorAll('[data-test-result-id]').forEach(row => {
      row.onclick = () => showTestResultDetails(row.dataset.testResultId);
    });

    // Кнопка сброса фильтров
    document.getElementById('testHistoryReset')?.addEventListener('click', () => {
      testHistoryFilters = { search: '', status: 'all', period: 'all' };
      testHistorySort = 'date';
      render();
    });
  }, 0);

  return `
    <button class="btn secondary" style="margin-bottom:16px" onclick="location.hash='#/tests'">← К списку тестов</button>
    <h2>📊 Результаты теста</h2>
    <p class="doc-meta">${escapeHtml(test.title)}</p>

    <div class="counter-bar">
      <span>Всего попыток: <strong>${allResults.length}</strong></span>
      <span>Прошли: <strong style="color:var(--ok)">${passedCount}</strong></span>
      <span>Не прошли: <strong style="color:var(--danger)">${failCount}</strong></span>
      <span>Показано: <strong>${results.length}</strong></span>
    </div>

    <div class="test-history-filters">
      <div class="form-group" style="margin-bottom:10px">
        <input id="testHistorySearch" type="text" placeholder="🔍 Поиск по имени...">
      </div>

      <div class="test-history-filter-row">
        <div class="test-history-filter-group">
          <span class="th-label">Статус:</span>
          <button class="th-btn ${testHistoryFilters.status === 'all' ? 'active' : ''}" data-th-status="all">Все</button>
          <button class="th-btn ${testHistoryFilters.status === 'pass' ? 'active' : ''}" data-th-status="pass">✅ Прошли</button>
          <button class="th-btn ${testHistoryFilters.status === 'fail' ? 'active' : ''}" data-th-status="fail">❌ Не прошли</button>
        </div>

        <div class="test-history-filter-group">
          <span class="th-label">Период:</span>
          <button class="th-btn ${testHistoryFilters.period === 'all' ? 'active' : ''}" data-th-period="all">Всё</button>
          <button class="th-btn ${testHistoryFilters.period === 'today' ? 'active' : ''}" data-th-period="today">Сегодня</button>
          <button class="th-btn ${testHistoryFilters.period === 'week' ? 'active' : ''}" data-th-period="week">Неделя</button>
          <button class="th-btn ${testHistoryFilters.period === 'month' ? 'active' : ''}" data-th-period="month">Месяц</button>
        </div>

        <div class="test-history-filter-group">
          <span class="th-label">Сортировка:</span>
          <select id="testHistorySort" class="th-select">
            <option value="date">По дате (новые)</option>
            <option value="score">По баллу (высокие)</option>
            <option value="name">По имени (А→Я)</option>
          </select>
        </div>

        <button class="btn secondary" id="testHistoryReset" style="width:auto;padding:6px 14px;font-size:12px">↺ Сброс</button>
      </div>
    </div>

    <div id="testHistoryList">
      ${renderTestHistoryList(testId, results)}
    </div>
  `;
}

// Отдельная функция рендера списка (для перерисовки при поиске)
function renderTestHistoryList(testId, results) {
  if (results.length === 0) {
    return '<p class="doc-meta">По выбранным фильтрам ничего не найдено.</p>';
  }
  return results.map(r => {
    const outdated = isTestOutdated(r);
    return `
      <div class="test-history-row ${r.passed ? 'pass' : 'fail'} ${outdated ? 'outdated' : ''}" data-test-result-id="${r.id}" style="cursor:pointer">
        <div class="test-history-user">
          <strong>${escapeHtml(r.userNick)}</strong>
          <span class="test-history-rank">${escapeHtml(r.userRank || '')}</span>
          ${outdated ? '<span class="test-outdated-badge">⚠️ устарело</span>' : ''}
          ${r.failReason ? `<span class="test-fail-badge">🚨 ${escapeHtml(r.failReason)}</span>` : ''}
        </div>
        <div class="test-history-score">
          ${r.passed ? '✅' : '❌'} ${r.score}/${r.total} (${r.percent}%)
        </div>
        <div class="test-history-date">${fmtDate(r.finishedAt)}</div>
        <div class="test-history-arrow">›</div>
      </div>
    `;
  }).join('');
}

// Модалка с полным разбором попытки
function showTestResultDetails(resultId) {
  const r = cachedTestResults.find(x => x.id === resultId);
  if (!r) return toast('Результат не найден', 'err');

  const answersHtml = (r.answers && r.answers.length) ? r.answers.map((a, i) => `
    <div class="test-review-item ${a.isCorrect ? 'correct' : 'wrong'}">
      <div class="test-review-head">
        <span>${i+1}. ${escapeHtml(a.questionText)}</span>
        <span class="test-review-icon">${a.isCorrect ? '✅' : '❌'}</span>
      </div>
      <div class="test-review-answers">
        <div>Ответ: <span class="${a.isCorrect ? 'ok' : 'err'}">${
          a.selectedOptions.length
            ? a.selectedOptions.map(escapeHtml).join(', ')
            : '— не отвечено —'
        }</span></div>
        ${!a.isCorrect
          ? `<div>Правильно: <span class="ok">${a.correctOptions.map(escapeHtml).join(', ')}</span></div>`
          : ''}
      </div>
    </div>
  `).join('') : '<p class="doc-meta">Детали ответов недоступны.</p>';

  openModal(`
    <h3>${r.passed ? '✅ Тест пройден' : '❌ Тест не пройден'}</h3>
    <p class="modal-sub">
      <strong>${escapeHtml(r.userNick)}</strong>
      <span style="color:var(--accent)"> · ${escapeHtml(r.userRank || '')}</span><br>
      ${fmtDate(r.finishedAt)} · ${r.score}/${r.total} (${r.percent}%)
    </p>
    ${r.failReason ? `
      <div class="test-outdated-notice" style="border-color:var(--danger);color:var(--danger);background:rgba(231,76,60,.1); margin-bottom:16px;">
        🚨 <strong>Тест провален досрочно</strong><br>
        Причина: ${escapeHtml(r.failReason)}
      </div>
    ` : ''}
    <div style="max-height:60vh;overflow-y:auto;padding-right:6px">
      ${answersHtml}
    </div>
    <div class="modal-actions">
      <button class="btn" data-close>Закрыть</button>
    </div>
  `, (overlay, close) => {
    overlay.querySelector('[data-close]').onclick = close;
  });
}

// Быстрая перерисовка только списка (без полного render)
function refreshTestHistoryList(testId) {
  const test = cachedTests.find(t => t.id === testId);
  if (!test) return;

  const now = Date.now();
  let periodStart = 0;
  if (testHistoryFilters.period === 'today') {
    const d = new Date(); d.setHours(0,0,0,0); periodStart = d.getTime();
  } else if (testHistoryFilters.period === 'week') {
    periodStart = now - 7 * 24 * 3600 * 1000;
  } else if (testHistoryFilters.period === 'month') {
    periodStart = now - 30 * 24 * 3600 * 1000;
  }

  const toMs = r => {
    const t = r.finishedAt;
    return t?.toDate ? t.toDate().getTime() : new Date(t || 0).getTime();
  };

  let results = testResultsFor(testId).filter(r => {
    if (testHistoryFilters.status === 'pass' && !r.passed) return false;
    if (testHistoryFilters.status === 'fail' && r.passed) return false;
    if (periodStart && toMs(r) < periodStart) return false;
    if (testHistoryFilters.search) {
      const q = testHistoryFilters.search.toLowerCase();
      if (!(r.userNick || '').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  if (testHistorySort === 'date') {
    results.sort((a,b) => toMs(b) - toMs(a));
  } else if (testHistorySort === 'score') {
    results.sort((a,b) => (b.percent || 0) - (a.percent || 0));
  } else if (testHistorySort === 'name') {
    results.sort((a,b) => (a.userNick || '').localeCompare(b.userNick || '', 'ru'));
  }

  const listEl = document.getElementById('testHistoryList');
  if (listEl) {
    listEl.innerHTML = renderTestHistoryList(testId, results);
    // Переподключаем обработчики
    listEl.querySelectorAll('[data-test-result-id]').forEach(row => {
      row.onclick = () => showTestResultDetails(row.dataset.testResultId);
    });
  }
}

/* ==================== РОУТЕР ==================== */
function render() {
  if (!currentProfile) return;
  const hash = location.hash || '#/home';

  // 🔥 ПРОВЕРКА ПЕРЕХОДА ПО САЙТУ: если ушли со страницы теста -> провал
  if (currentTestRun && hash !== '#/test-run' && !hash.startsWith('#/test-result/')) {
    const runToFail = currentTestRun;
    currentTestRun = null;
    localStorage.removeItem('ppd_active_test');
    processInterruptedTest(runToFail, 'Вы ушли со страницы теста (открыли другой раздел)');
    return; // Прерываем рендер, так как сейчас произойдет редирект
  }  

  const content = document.getElementById('content');

  document.querySelectorAll('.nav-link').forEach(l =>
    l.classList.toggle('active', l.dataset.route === hash));

  if (hash === '#/home')           content.innerHTML = renderHome();
  else if (hash.startsWith('#/doc/'))   content.innerHTML = renderDoc(hash.slice(6));
  else if (hash === '#/reports')   content.innerHTML = renderReports();
  else if (hash === '#/tests')     content.innerHTML = renderTests();
  else if (hash === '#/test-run')  content.innerHTML = renderTestRun();
  else if (hash.startsWith('#/test-result/')) content.innerHTML = renderTestResult(hash.replace('#/test-result/',''));
  else if (hash.startsWith('#/test-history/')) content.innerHTML = renderTestHistory(hash.replace('#/test-history/',''));
  else if (hash.startsWith('#/test-editor/')) content.innerHTML = renderTestEditor(hash.replace('#/test-editor/',''));
  else if (hash === '#/registry')              content.innerHTML = renderRegistry('detentions');
  else if (hash.startsWith('#/registry/'))     content.innerHTML = renderRegistry(hash.replace('#/registry/',''));
  else if (hash === '#/staff')     content.innerHTML = renderStaff();
  else if (hash.startsWith('#/profile/')) content.innerHTML = renderProfile(hash.replace('#/profile/',''));
  else if (hash === '#/dashboard')  content.innerHTML = renderDashboard();
  else if (hash === '#/announcements') content.innerHTML = renderAnnouncements();
  else if (hash === '#/invites')   content.innerHTML = renderInvites();
  else if (hash === '#/passwords') content.innerHTML = renderResets();
  else content.innerHTML = `<h2>Страница не найдена</h2>`;

  // Если пришли из поиска — скроллим к конкретной статье
  if (pendingScrollBlockIdx != null) {
    if (hash.startsWith('#/doc/') && hash.slice(6) === pendingScrollDocId) {
      scrollToPendingBlock();
    } else {
      pendingScrollBlockIdx = null;
      pendingScrollDocId    = null;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  } else {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
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
// Клик по логотипу → Главная
document.querySelector('.brand')?.addEventListener('click', () => {
  location.hash = '#/home';
});
document.getElementById('login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('reg-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doRegister(); });
document.getElementById('globalSearch').addEventListener('input', e => globalSearch(e.target.value));
window.addEventListener('hashchange', render);

onAuthStateChanged(auth, async user => {
  if (user) {
    currentUser = user;
    let profile = null;
    try {
      profile = await loadProfile(user.uid);
      
      if (!profile) {
        if (isRegistering) {
          // Если прямо сейчас идёт регистрация, ждём, пока doRegister создаст профиль
          let retries = 5;
          while (retries > 0 && !profile) {
            await new Promise(r => setTimeout(r, 800));
            profile = await loadProfile(user.uid);
            retries--;
          }
          if (!profile) {
             await signOut(auth);
             return;
          }
        } else {
          // 🛠 ВОССТАНОВЛЕНИЕ: если профиля нет (сбой при регистрации) — создаём его на ходу
          console.log('Профиль не найден. Авто-восстановление...');
          
          let defaultNick = user.email.split('@')[0].replace(/_/g, ' ');
          defaultNick = defaultNick.replace(/\b\w/g, c => c.toUpperCase());

          await firestoreWithRetry(() => 
            setDoc(doc(db,'users',user.uid), {
              nickname: defaultNick,
              rank: 'Гражданский',
              status: 'active',
              warnings: [],
              createdAt: serverTimestamp(),
              lastAnnouncementReadAt: serverTimestamp()
            })
          );
          
          profile = { uid: user.uid, nickname: defaultNick, rank: 'Гражданский', status: 'active', warnings: [] };
          toast('Аккаунт восстановлен. Твой ник: ' + defaultNick, 'err');
        }
      }
    } catch (err) {
      console.error('Ошибка связи с Firebase:', err);
      // Показываем понятное сообщение вместо вечной загрузки
      const pl = document.getElementById('preloader');
      if (pl) {
        pl.innerHTML = `
          <div class="preloader-content" style="text-align:center">
            <div class="preloader-badge">
              <div class="preloader-star" style="background:var(--danger);color:#fff">!</div>
            </div>
            <div class="preloader-title" style="color:var(--danger)">НЕТ СВЯЗИ С СЕРВЕРОМ</div>
            <div class="preloader-sub" style="max-width:420px;margin:12px auto 20px;line-height:1.6">
              Не удаётся подключиться к базе данных.<br>
              Проверь интернет, отключи VPN/AdBlock и попробуй снова.
            </div>
            <button class="btn" onclick="location.reload()" style="min-width:180px">
              🔄 Обновить
            </button>
          </div>
        `;
      }
      return;
    }
    if (!profile) { await signOut(auth); return; }
    if (profile.status === 'fired') {
      alert('Вы уволены из фракции.');
      await signOut(auth);
      return;
    }
    currentProfile = profile;

    // Проверяем, не истёк ли отпуск — если да, автоматически возвращаем в строй
    await checkExpiredVacation(profile);

    // 🔥 ПРОВЕРКА ОБНОВЛЕНИЯ СТРАНИЦЫ (F5): если в памяти есть тест -> провал
    const savedRunStr = localStorage.getItem('ppd_active_test');
    if (savedRunStr) {
      localStorage.removeItem('ppd_active_test');
      try {
        const savedRun = JSON.parse(savedRunStr);
        // Запускаем с небольшой задержкой, чтобы сайт успел прогрузиться
        setTimeout(() => {
          processInterruptedTest(savedRun, 'Обновление страницы или выход с сайта');
        }, 1000);
      } catch (e) {
        console.error('Ошибка чтения сохраненного теста', e);
      }
    }


    document.getElementById('authScreen').classList.add('hidden');
    document.getElementById('appScreen').classList.remove('hidden');
    document.getElementById('userNick').textContent = profile.nickname;
    document.getElementById('userRank').textContent = profile.rank;

    // Сбрасываем hash на главную при входе
    if (location.hash && location.hash !== '#/home') {
      location.hash = '#/home';
    }

    buildNav();
    subscribeUsers();
    if (canManageStaff(profile)) subscribeInvites();
    if (canResetPasswords(profile)) subscribeResets();
    if (isPolice(profile) || canReview(profile) || canManageStaff(profile)) {
      subscribeDetentions();
      subscribeFines();
    }
    if (canManageStaff(profile)) {
      subscribeReportsGlobal();
      subscribeDashboardConfig();
    }
    if (isPolice(profile) || canReview(profile) || canManageStaff(profile)) {
      subscribeAnnouncements();
    }
    // Отпуска — видны всем полицейским и руководству
    if (isPolice(profile) || canReview(profile) || canManageStaff(profile)) {
      subscribeVacations();
    }
    // Тесты — подписка для всех авторизованных
    subscribeTests();
    // Результаты — подписка для ВСЕХ, чтобы каждый видел свой результат
    subscribeTestResults();
    // Чек-листы повышения — видны всем, кто может видеть кадры
    subscribePromotionConfig();
    render();
    hidePreloader('Добро пожаловать');

    // Проверяем, не уволен ли пользователь
    checkFiredNotification(profile);

    // Периодически (раз в час) проверяем, не пора ли вернуться из отпуска
    setInterval(() => {
      if (currentProfile) checkExpiredVacation(currentProfile);
    }, 60 * 60 * 1000);
  } else {
    currentUser = null; currentProfile = null;
    if (reportsUnsub) { reportsUnsub(); reportsUnsub = null; }
    if (invitesUnsub) { invitesUnsub(); invitesUnsub = null; }
    if (resetsUnsub) { resetsUnsub(); resetsUnsub = null; }
    if (detentionsUnsub) { detentionsUnsub(); detentionsUnsub = null; }
    if (finesUnsub) { finesUnsub(); finesUnsub = null; }
    if (reportsGlobalUnsub) { reportsGlobalUnsub(); reportsGlobalUnsub = null; }
    if (dashboardConfigUnsub) { dashboardConfigUnsub(); dashboardConfigUnsub = null; }
    if (announcementsUnsub) { announcementsUnsub(); announcementsUnsub = null; }
    if (testsUnsub) { testsUnsub(); testsUnsub = null; }
    if (testResultsUnsub) { testResultsUnsub(); testResultsUnsub = null; }
    if (currentTestRun && currentTestRun.timerId) {
      clearInterval(currentTestRun.timerId);
      currentTestRun = null;
    }
    document.getElementById('authScreen').classList.remove('hidden');
    document.getElementById('appScreen').classList.add('hidden');

    hidePreloader('Авторизация');
  }
});

/* ==================== ГОРЯЧИЕ КЛАВИШИ ==================== */
(function initHotkeys() {
  document.addEventListener('keydown', e => {
    // Пропускаем, если пользователь печатает в поле ввода
    const tag = (e.target.tagName || '').toLowerCase();
    const isTyping = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;

    // Если открыто блокирующее уведомление — игнорируем все горячие клавиши
    if (document.getElementById('firedNotice')) return;

    // ---- ESC: закрывает модалку (работает всегда) ----
    if (e.key === 'Escape') {
      const overlay = document.querySelector('.modal-overlay');
      if (overlay) {
        overlay.style.transition = 'opacity .15s';
        overlay.style.opacity = '0';
        setTimeout(() => overlay.remove(), 150);
        e.preventDefault();
        return;
      }
      // Если модалки нет — снимаем фокус с поля ввода
      if (isTyping) {
        e.target.blur();
        return;
      }
    }

    // ---- Остальные клавиши — только если НЕ печатаешь ----
    if (isTyping) return;

    // Пропускаем, если открыта модалка (не мешаем закрывать Esc)
    if (document.querySelector('.modal-overlay')) return;

    // ---- "/" — фокус на поиск ----
    if (e.key === '/') {
      const searchInput = document.getElementById('globalSearch');
      if (searchInput) {
        e.preventDefault();
        searchInput.focus();
        searchInput.select();
      }
      return;
    }

    // ---- Alt+H / Alt+R / Alt+S ----
    if (e.altKey && !e.ctrlKey && !e.shiftKey) {
      const key = e.key.toLowerCase();
      if (key === 'h') {
        e.preventDefault();
        location.hash = '#/home';
        return;
      }
      if (key === 'r') {
        if (isPolice(currentProfile) || canReview(currentProfile) || canManageStaff(currentProfile)) {
          e.preventDefault();
          location.hash = '#/reports';
        }
        return;
      }
      if (key === 's') {
        if (isPolice(currentProfile) || canManageStaff(currentProfile)) {
          e.preventDefault();
          location.hash = '#/staff';
        }
        return;
      }
    }
  });
})();

/* ==================== КОПИРОВАНИЕ В БУФЕР ==================== */
document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const text = btn.dataset.copy;
  try {
    await navigator.clipboard.writeText(text);
    // Кратковременно меняем иконку на галочку
    const original = btn.textContent;
    btn.textContent = '✓';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('copied');
    }, 1200);
    toast('Код скопирован: ' + text);
  } catch (err) {
    // Fallback для браузеров без clipboard API
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast('Код скопирован: ' + text);
    } catch (e2) {
      toast('Не удалось скопировать', 'err');
    }
    document.body.removeChild(ta);
  }
});

/* ==================== ФИЛЬТР ПО КОДЕКСУ (УК/АК) ==================== */
document.addEventListener('click', e => {
  const tab = e.target.closest('[data-law-type]');
  if (!tab) return;
  const [stateKey, type] = tab.dataset.lawType.split(':');
  lawTypeFilter[stateKey] = type;

  // Обновляем активные табы
  document.querySelectorAll(`[data-law-type^="${stateKey}:"]`).forEach(t => {
    t.classList.toggle('active', t.dataset.lawType === `${stateKey}:${type}`);
  });

  // Очищаем результаты поиска (они больше неактуальны)
  const resultsId = stateKey === 'detentions' ? 'd-articles-results' : 'f-articles-results';
  const resultsBox = document.getElementById(resultsId);
  if (resultsBox) resultsBox.innerHTML = '';

  // Если что-то было введено — пересчитываем заново
  const inputId = stateKey === 'detentions' ? 'd-articles-search' : 'f-articles-search';
  const input = document.getElementById(inputId);
  if (input && input.value.trim()) {
    updateLawResults(inputId, resultsId, stateKey);
  }
});

/* ==================== ПРЕДУПРЕЖДЕНИЕ О ВЫХОДЕ ИЗ ТЕСТА ==================== */
window.addEventListener('beforeunload', e => {
  if (currentTestRun) {
    e.preventDefault();
    e.returnValue = 'Если вы уйдете, тест будет автоматически провален!';
    return e.returnValue;
  }
});

/* ==================== МОБИЛЬНОЕ МЕНЮ ==================== */
(function initMobileMenu() {
  const hamburger = document.getElementById('hamburger');
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebarOverlay');

  if (!hamburger || !sidebar) return;

  const closeSidebar = () => {
    sidebar.classList.remove('open');
    overlay?.classList.remove('active');
  };

  hamburger.addEventListener('click', () => {
    const isOpen = sidebar.classList.toggle('open');
    if (isOpen) overlay?.classList.add('active');
    else overlay?.classList.remove('active');
  });

  overlay?.addEventListener('click', closeSidebar);

  document.getElementById('nav')?.addEventListener('click', e => {
    if (e.target.classList.contains('nav-link') && window.innerWidth <= 820) closeSidebar();
  });

  window.addEventListener('hashchange', () => {
    if (window.innerWidth <= 820) closeSidebar();
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 820) closeSidebar();
  });
})();

/* ==================== КНОПКА «НАВЕРХ» ==================== */
(function initScrollTopButton() {
  // Создаём кнопку один раз при загрузке
  const btn = document.createElement('button');
  btn.id = 'scrollTopBtn';
  btn.className = 'scroll-top-btn';
  btn.setAttribute('aria-label', 'Наверх');
  btn.innerHTML = '↑';
  btn.title = 'Наверх';
  document.body.appendChild(btn);

  // Клик — плавный скролл наверх
  btn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // Показываем кнопку, только когда прокрутили больше 500px
  let ticking = false;
  const updateVisibility = () => {
    const show = window.scrollY > 500;
    btn.classList.toggle('visible', show);
    ticking = false;
  };

  window.addEventListener('scroll', () => {
    if (!ticking) {
      window.requestAnimationFrame(updateVisibility);
      ticking = true;
    }
  }, { passive: true });

  // Первичная проверка (если пользователь вернулся с прокруткой)
  updateVisibility();
})();

// Обработчик крестика для очистки поиска статей
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-clear-for]');
  if (!btn) return;
  const inputId = btn.dataset.clearFor;
  const input = document.getElementById(inputId);
  if (input) {
    input.value = '';
    input.focus();
    input.dispatchEvent(new Event('input')); // запустить существующий обработчик
  }
});

/* ==================== ПЕРЕХОД К СТАТЬЕ ИЗ РЕЕСТРА ==================== */
// codeType: 'УК' | 'АК' | 'ДК', fullCode: '6.1 ч.1', '17.6' и т.п.
function goToLawArticle(codeType, fullCode) {
  const DOC_MAP = { 'УК': 'uk', 'АК': 'ak', 'ДК': 'dk' };
  const docId = DOC_MAP[codeType];
  if (!docId) return toast('Кодекс не найден', 'err');

  // Берём только числовой код, отбрасываем "ч.1", "ч.2"
  const code = String(fullCode || '').trim().split(/\s+/)[0];
  if (!code) return;

  const targetHash = '#/doc/' + docId;
  const isSame = location.hash === targetHash;

  if (!isSame) location.hash = targetHash;

  // После смены роутера — ищем статью
  setTimeout(() => {
    const articles = document.querySelectorAll('.doc-body .doc-article[data-search-idx]');
    if (!articles.length) {
      // Возможно, ещё не отрисовалось — повторим
      setTimeout(() => goToLawArticle(codeType, fullCode), 200);
      return;
    }

    // Экранируем точки и ищем по началу заголовка
    const codeEsc = code.replace(/\./g, '\\.');
    const rx = new RegExp('^(Статья\\s+)?' + codeEsc + '[\\.\\s]');

    let found = null;
    for (const art of articles) {
      const txt = art.textContent.trim();
      if (rx.test(txt)) { found = art; break; }
    }

    if (!found) {
      return toast('Статья не найдена в документе', 'err');
    }

    const topbar = document.querySelector('.topbar');
    const offset = (topbar?.offsetHeight || 70) + 16;
    const rect = found.getBoundingClientRect();
    const targetY = window.scrollY + rect.top - offset;

    window.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });

    const startHighlight = () => {
      found.classList.add('search-highlight');
      setTimeout(() => found.classList.remove('search-highlight'), 2000);
    };
    if ('onscrollend' in window) {
      window.addEventListener('scrollend', startHighlight, { once: true });
    } else {
      setTimeout(startHighlight, 2500);
    }
  }, 150);
}

// Делегирование клика по чипам статей в карточках реестра
document.addEventListener('click', e => {
  const chip = e.target.closest('.law-chip.clickable');
  if (!chip) return;
  goToLawArticle(chip.dataset.lawType, chip.dataset.lawCode);
});

/* ==================== ПРОВЕРКА ПОВЫШЕНИЯ ==================== */
async function openPromotionCheckModal(uid) {
  const target = cachedUsers.find(u => u.uid === uid);
  if (!target) return;

  const rules = promotionRules.byRole?.[target.rank];
  if (!rules) return toast('Для этой роли правила не заданы', 'err');

  openModal(`
    <h3>🎖 Проверка повышения</h3>
    <p class="modal-sub">
      <strong style="color:var(--accent)">${escapeHtml(target.nickname)}</strong>
      <span style="color:var(--muted)"> · ${escapeHtml(target.rank)} → ${escapeHtml(rules.toRole || '—')}</span>
    </p>
    <div id="promoCheckBody"><p class="doc-meta">Загрузка...</p></div>
    <div class="modal-actions">
      <button class="btn" data-close>Закрыть</button>
    </div>
  `, (overlay, close) => {
    overlay.querySelector('[data-close]').onclick = close;
    loadAndRenderPromotionCheck(overlay, target, rules);
  });
}

async function loadAndRenderPromotionCheck(overlay, target, rules) {
  const body = overlay.querySelector('#promoCheckBody');

  try {
    const [rA, dA, fA] = await Promise.all([
      getDocs(query(collection(db,'reports'),    where('authorUid','==', target.uid))),
      getDocs(query(collection(db,'detentions'), where('authorUid','==', target.uid))),
      getDocs(query(collection(db,'fines'),      where('authorUid','==', target.uid)))
    ]);

    const stats = {
      reports:    rA.size,
      detentions: dA.size,
      fines:      fA.size,
      warnings:   (target.warnings || []).length,
      passedTests: new Set(
        cachedTestResults
          .filter(r => r.userId === target.uid && r.passed)
          .map(r => r.testId)
      )
    };

    // Собираем проверки
    const checks = [];

    if (rules.minReports > 0) {
      checks.push({
        label: 'Отчётов',
        need: rules.minReports,
        have: stats.reports,
        ok: stats.reports >= rules.minReports
      });
    }
    if (rules.minDetentions > 0) {
      checks.push({
        label: 'Задержаний',
        need: rules.minDetentions,
        have: stats.detentions,
        ok: stats.detentions >= rules.minDetentions
      });
    }
    if (rules.minFines > 0) {
      checks.push({
        label: 'Штрафов',
        need: rules.minFines,
        have: stats.fines,
        ok: stats.fines >= rules.minFines
      });
    }
    if (rules.maxWarnings > 0 || rules.maxWarnings === 0) {
      checks.push({
        label: 'Выговоров (макс.)',
        need: rules.maxWarnings,
        have: stats.warnings,
        ok: stats.warnings <= rules.maxWarnings,
        inverted: true
      });
    }
    (rules.requiredTests || []).forEach(testId => {
      const t = cachedTests.find(x => x.id === testId);
      const title = t?.title || 'Тест';
      checks.push({
        label: `Тест: ${title}`,
        ok: stats.passedTests.has(testId),
        testId
      });
    });

    const totalOk = checks.filter(c => c.ok).length;
    const total = checks.length;
    const allOk = total > 0 && totalOk === total;

    const header = allOk
      ? `<div class="promo-verdict ok">✅ Сотрудник готов к повышению</div>`
      : `<div class="promo-verdict pending">⏳ Выполнено ${totalOk} из ${total}</div>`;

    const list = checks.length === 0
      ? '<p class="doc-meta">Правила пусты — сотрудник автоматически готов.</p>'
      : `<div class="promo-checklist">
          ${checks.map(c => {
            let value = '';
            if (c.need !== undefined) {
              value = c.inverted
                ? `${c.have} / макс. ${c.need}`
                : `${c.have} / ${c.need}`;
            }
            return `
              <div class="promo-row ${c.ok ? 'ok' : 'fail'}">
                <div class="promo-icon">${c.ok ? '✅' : '❌'}</div>
                <div class="promo-label">${escapeHtml(c.label)}</div>
                ${value ? `<div class="promo-value">${escapeHtml(value)}</div>` : ''}
              </div>
            `;
          }).join('')}
        </div>`;

    body.innerHTML = header + list;

  } catch (err) {
    console.error(err);
    body.innerHTML = `<p class="doc-meta" style="color:var(--danger)">Ошибка загрузки: ${escapeHtml(err.message)}</p>`;
  }
}

/* ==================== РЕДАКТОР ЧЕК-ЛИСТОВ ==================== */
function openPromotionEditor() {
  if (!canEditPromotionRules(currentProfile)) return toast('Нет прав', 'err');

  const roles = ROLES_ORDERED.filter(r => ROLES[r]?.police && r !== 'Генерал полиции');

  const rows = roles.map(role => {
    const r = promotionRules.byRole?.[role] || {};
    return `
      <div class="promo-edit-row" data-role="${escapeHtml(role)}">
        <div class="promo-edit-head">
          <strong>${escapeHtml(role)}</strong>
          <span class="promo-edit-arrow">→</span>
          <select data-field="toRole">
            <option value="">— не задано —</option>
            ${ROLES_ORDERED.filter(x => ROLES[x]?.police).map(t =>
              `<option value="${escapeHtml(t)}" ${r.toRole === t ? 'selected' : ''}>${escapeHtml(t)}</option>`
            ).join('')}
          </select>
        </div>
        <div class="promo-edit-fields">
          <label>Отчётов <input type="number" min="0" data-field="minReports" value="${r.minReports ?? 0}"></label>
          <label>Задержаний <input type="number" min="0" data-field="minDetentions" value="${r.minDetentions ?? 0}"></label>
          <label>Штрафов <input type="number" min="0" data-field="minFines" value="${r.minFines ?? 0}"></label>
          <label>Макс. выговоров <input type="number" min="0" data-field="maxWarnings" value="${r.maxWarnings ?? 0}"></label>
        </div>
      </div>
    `;
  }).join('');

  openModal(`
    <h3>⚙️ Редактор чек-листов</h3>
    <p class="modal-sub">Требования для повышения на следующую роль</p>
    <div style="max-height:60vh;overflow-y:auto;padding-right:6px">
      ${rows}
    </div>
    <div class="modal-actions">
      <button class="btn secondary" data-reset>↺ Сбросить к дефолту</button>
      <button class="btn secondary" data-cancel>Отмена</button>
      <button class="btn" data-save>💾 Сохранить</button>
    </div>
  `, (overlay, close) => {
    overlay.querySelector('[data-cancel]').onclick = close;

    overlay.querySelector('[data-reset]').onclick = async () => {
      if (!confirm('Сбросить все правила к значениям по умолчанию?')) return;
      await setDoc(doc(db, 'config', 'promotion'), {
        ...defaultPromotionRules(),
        updatedAt: serverTimestamp(),
        updatedBy: currentProfile.nickname
      });
      toast('Правила сброшены');
      close();
    };

    overlay.querySelector('[data-save]').onclick = async () => {
      const newRules = { byRole: {} };
      overlay.querySelectorAll('.promo-edit-row').forEach(row => {
        const role = row.dataset.role;
        const toRole = row.querySelector('[data-field="toRole"]').value;
        if (!toRole) return;   // пропускаем пустые
        newRules.byRole[role] = {
          toRole,
          minReports:    parseInt(row.querySelector('[data-field="minReports"]').value, 10) || 0,
          minDetentions: parseInt(row.querySelector('[data-field="minDetentions"]').value, 10) || 0,
          minFines:      parseInt(row.querySelector('[data-field="minFines"]').value, 10) || 0,
          maxWarnings:   parseInt(row.querySelector('[data-field="maxWarnings"]').value, 10) || 0,
          requiredTests: []
        };
      });

      try {
        await setDoc(doc(db, 'config', 'promotion'), {
          ...newRules,
          updatedAt: serverTimestamp(),
          updatedBy: currentProfile.nickname
        });
        toast('Правила сохранены');
        close();
      } catch (e) {
        console.error(e);
        toast('Ошибка сохранения: ' + (e.message || ''), 'err');
      }
    };
  });
}

/* ==================== СИСТЕМА ПРЕДУПРЕЖДЕНИЙ ==================== */
// Возвращает объект с уровнем риска и рекомендациями
function analyzeWarnings(warnings) {
  const w = warnings || [];
  const light  = w.filter(x => x.severity === 'light').length;
  const medium = w.filter(x => x.severity === 'medium').length;
  const heavy  = w.filter(x => x.severity === 'heavy').length;

  // Авто-метка «рекомендован к увольнению»
  const recommendFire = heavy >= 3;

  // Уровень риска для бейджа
  //   3+ тяжёлых     → danger (красный)
  //   3+ средних     → warning (оранжевый)
  //   3+ лёгких      → notice (жёлтый)
  //   меньше         → нет бейджа
  let riskLevel = null;      // null | 'notice' | 'warning' | 'danger'
  let riskLabel = '';
  if (recommendFire) {
    riskLevel = 'danger';
    riskLabel = 'Рекомендован к увольнению';
  } else if (heavy >= 1) {
    riskLevel = 'warning';
    riskLabel = 'Требуется собеседование';
  } else if (medium >= 3) {
    riskLevel = 'warning';
    riskLabel = 'Высокий уровень риска';
  } else if (light >= 3) {
    riskLevel = 'notice';
    riskLabel = 'Средний уровень риска';
  }

  return {
    light, medium, heavy,
    total: w.length,
    recommendFire,
    riskLevel,
    riskLabel,
    // Текст-описание для карточки
    description: (() => {
      const parts = [];
      if (light  > 0) parts.push(`${light} лёгк.`);
      if (medium > 0) parts.push(`${medium} средн.`);
      if (heavy  > 0) parts.push(`${heavy} тяж.`);
      return parts.join(' · ');
    })()
  };
}

// Бейдж риска (используется в Кадрах и профиле)
function renderWarningRiskBadge(warnings) {
  const a = analyzeWarnings(warnings);
  if (!a.riskLevel) return '';
  return `<span class="risk-badge risk-${a.riskLevel}" title="${escapeHtml(a.riskLabel)}">${escapeHtml(a.riskLabel)}</span>`;
}

/* ==================== РЕЗЕРВНАЯ КОПИЯ (JSON) ==================== */
async function downloadBackup() {
  const allowedRoles = ['Генерал полиции','Губернатор','Администратор','Старший администратор','РП-Куратор'];
  if (!currentProfile || !allowedRoles.includes(currentProfile.rank)) {
    return toast('Нет прав', 'err');
  }

  if (!confirm('Создать резервную копию базы данных?\n\nМожет занять 10–30 секунд.')) return;

  toast('Сбор данных...');
  const btn = document.getElementById('btnDownloadBackup');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Сбор...'; }

  // Безопасный режим: исключены invites и passwordResets (персональные запросы)
  const COLLECTIONS = [
    'users','reports','detentions','fines',
    'announcements','tests','testResults'
  ];

  const backup = {
    meta: {
      generatedAt: new Date().toISOString(),
      generatedBy: currentProfile.nickname,
      generatedByRank: currentProfile.rank,
      version: '1.0'
    },
    collections: {}
  };

  try {
    for (const colName of COLLECTIONS) {
      const snap = await getDocs(collection(db, colName));
      backup.collections[colName] = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    }

    // config
    backup.collections.config = {};
    for (const cfgId of ['dashboard', 'promotion']) {
      const cfgSnap = await getDoc(doc(db, 'config', cfgId));
      if (cfgSnap.exists()) backup.collections.config[cfgId] = cfgSnap.data();
    }

    const json = JSON.stringify(backup, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const a = document.createElement('a');
    a.href = url;
    a.download = `ppd-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    // Считаем общий размер
    const totalRows = Object.values(backup.collections)
      .reduce((s, arr) => s + (Array.isArray(arr) ? arr.length : 0), 0);

    toast(`Бэкап готов ✓ (${totalRows} записей)`);
  } catch (e) {
    console.error(e);
    toast('Ошибка: ' + (e.message || 'неизвестная'), 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 Скачать бэкап'; }
  }
}

/* ==================== ОТПУСКА ==================== */
function subscribeVacations() {
  if (vacationsUnsub) vacationsUnsub();
  vacationsUnsub = onSnapshot(
    query(collection(db, 'vacationRequests'), orderBy('createdAt', 'desc')),
    snap => {
      cachedVacations = [];
      snap.forEach(d => cachedVacations.push({ id: d.id, ...d.data() }));
      if (location.hash === '#/staff') render();
    },
    err => {
      if (err?.code === 'permission-denied') return;
      console.warn('vacations listener:', err);
    }
  );
}

/* ==================== СОЗДАНИЕ ЗАЯВКИ НА ОТПУСК ==================== */
function openVacationModal() {
  if (!isPolice(currentProfile)) return toast('Только сотрудники PPD могут подавать заявку', 'err');

  // Проверяем, нет ли уже активной заявки
  const myPending = cachedVacations.find(v =>
    v.userId === currentUser.uid && v.status === 'pending'
  );
  if (myPending) {
    return toast('У тебя уже есть заявка на рассмотрении', 'err');
  }

  // Мин. дата — сегодня, макс. — 90 дней вперёд
  const today = new Date();
  const maxDate = new Date();
  maxDate.setDate(maxDate.getDate() + 90);
  const fmtInput = d => d.toISOString().slice(0, 10);

  openModal(`
    <h3>🏖 Заявка на отпуск</h3>
    <p class="modal-sub">Укажи даты и причину — руководство рассмотрит заявку</p>

    <div class="form-group">
      <label>Дата начала</label>
      <input id="vac-from" type="date" min="${fmtInput(today)}" max="${fmtInput(maxDate)}" value="${fmtInput(today)}">
    </div>

    <div class="form-group">
      <label>Дата окончания</label>
      <input id="vac-to" type="date" min="${fmtInput(today)}" max="${fmtInput(maxDate)}">
    </div>

    <div class="form-group">
      <label>Причина (обязательно)</label>
      <textarea id="vac-reason" placeholder="Например: семейные обстоятельства, отпуск по учёбе..." style="min-height:90px"></textarea>
    </div>

    <div class="vac-preview" id="vacPreview"></div>

    <div class="modal-actions">
      <button class="btn secondary" data-cancel>Отмена</button>
      <button class="btn" data-confirm>Отправить заявку</button>
    </div>
  `, (overlay, close) => {
    const fromInput = overlay.querySelector('#vac-from');
    const toInput   = overlay.querySelector('#vac-to');
    const preview   = overlay.querySelector('#vacPreview');

    // Живой пересчёт дней
    const updatePreview = () => {
      const from = fromInput.value;
      const to = toInput.value;
      if (!from || !to) { preview.innerHTML = ''; return; }

      const dFrom = new Date(from);
      const dTo = new Date(to);
      if (dTo < dFrom) {
        preview.innerHTML = `<div class="vac-preview-err">⚠️ Дата окончания раньше даты начала</div>`;
        return;
      }

      const days = Math.round((dTo - dFrom) / 86400000) + 1;
      if (days > 45) {
        preview.innerHTML = `<div class="vac-preview-err">⚠️ Максимум 45 дней подряд</div>`;
        return;
      }

      preview.innerHTML = `
        <div class="vac-preview-ok">
          📅 Отпуск: <strong>${days} ${pluralDays(days)}</strong>
          · с ${dFrom.toLocaleDateString('ru-RU')} по ${dTo.toLocaleDateString('ru-RU')}
        </div>
      `;
    };

    fromInput.onchange = () => {
      // Автоматически ставим min для окончания
      toInput.min = fromInput.value;
      if (toInput.value && toInput.value < fromInput.value) toInput.value = fromInput.value;
      updatePreview();
    };
    toInput.onchange = updatePreview;
    updatePreview();

    overlay.querySelector('[data-cancel]').onclick = close;

    overlay.querySelector('[data-confirm]').onclick = async () => {
      const from = fromInput.value;
      const to = toInput.value;
      const reason = overlay.querySelector('#vac-reason').value.trim();

      if (!from || !to) return toast('Укажи обе даты', 'err');
      if (new Date(to) < new Date(from)) return toast('Дата окончания раньше начала', 'err');
      if (!reason) return toast('Укажи причину', 'err');

      const days = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
      if (days > 45) return toast('Максимум 45 дней', 'err');

      try {
        await addDoc(collection(db, 'vacationRequests'), {
          userId: currentUser.uid,
          userNick: currentProfile.nickname,
          userRank: currentProfile.rank,
          fromDate: from,
          toDate: to,
          days,
          reason,
          status: 'pending',
          createdAt: serverTimestamp(),
          reviewedBy: null,
          reviewedByRank: null,
          reviewedAt: null,
          reviewComment: ''
        });
        close();
        toast('Заявка отправлена на рассмотрение');
      } catch (e) {
        console.error(e);
        toast('Ошибка отправки: ' + (e.message || ''), 'err');
      }
    };
  });
}

// Склонение «дней»
function pluralDays(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return 'дней';
  if (mod10 === 1) return 'день';
  if (mod10 >= 2 && mod10 <= 4) return 'дня';
  return 'дней';
}

// Отмена своей заявки (если ещё pending)
async function cancelVacation(id) {
  const v = cachedVacations.find(x => x.id === id);
  if (!v) return;
  if (v.userId !== currentUser.uid) return toast('Это не твоя заявка', 'err');
  if (v.status !== 'pending') return toast('Уже рассмотрена', 'err');

  if (!confirm('Отменить заявку на отпуск?')) return;
  await deleteDoc(doc(db, 'vacationRequests', id));
  toast('Заявка отменена');
}

/* ==================== СТАТУС ЗАЯВКИ В ПРОФИЛЕ ==================== */
function renderVacationStatusBlock(v) {
  const from = new Date(v.fromDate).toLocaleDateString('ru-RU', { day:'2-digit', month:'long' });
  const to   = new Date(v.toDate).toLocaleDateString('ru-RU',   { day:'2-digit', month:'long' });

  const cfg = {
    pending:  { icon: '⏳', label: 'Заявка на рассмотрении', cls: 'pending'  },
    approved: { icon: '✅', label: 'Отпуск одобрен',         cls: 'approved' },
    rejected: { icon: '❌', label: 'Заявка отклонена',       cls: 'rejected' }
  }[v.status] || { icon: '❓', label: v.status, cls: 'pending' };

  return `
    <div class="vacation-status vacation-status-${cfg.cls}">
      <div class="vacation-status-head">
        <span class="vacation-status-icon">${cfg.icon}</span>
        <span class="vacation-status-label">${cfg.label}</span>
      </div>
      <div class="vacation-status-body">
        📅 ${from} — ${to} · <strong>${v.days} ${pluralDays(v.days)}</strong>
      </div>
      <div class="vacation-status-reason">💬 ${escapeHtml(v.reason)}</div>
      ${v.reviewedBy ? `
        <div class="vacation-status-review">
          Рассмотрел: <strong>${escapeHtml(v.reviewedBy)}</strong> (${escapeHtml(v.reviewedByRank || '')})
          ${v.reviewComment ? `<br>💬 ${escapeHtml(v.reviewComment)}` : ''}
        </div>
      ` : ''}
      ${v.status === 'pending' ? `
        <button class="btn secondary tiny" id="btnCancelVacation" data-vac-id="${v.id}" style="margin-top:10px;width:auto">
          ✕ Отменить заявку
        </button>
      ` : ''}
    </div>
  `;
}

/* ==================== УПРАВЛЕНИЕ ЗАЯВКАМИ НА ОТПУСК ==================== */
async function approveVacation(id) {
  if (lvl(currentProfile.rank) < 13 &&
      !['Губернатор','Администратор','Старший администратор','РП-Куратор'].includes(currentProfile.rank)) {
    return toast('Нет прав', 'err');
  }

  const v = cachedVacations.find(x => x.id === id);
  if (!v) return;
  if (v.status !== 'pending') return toast('Заявка уже рассмотрена', 'err');

  const comment = prompt('Комментарий к одобрению (необязательно):', '');
  if (comment === null) return;

  try {
    // 1) Обновляем заявку
    await updateDoc(doc(db, 'vacationRequests', id), {
      status: 'approved',
      reviewedBy: currentProfile.nickname,
      reviewedByRank: currentProfile.rank,
      reviewedAt: serverTimestamp(),
      reviewComment: comment.trim()
    });

    // 2) Ставим сотруднику статус «В отпуске»
    await updateDoc(doc(db, 'users', v.userId), {
      status: 'vacation',
      vacationFrom: v.fromDate,
      vacationTo: v.toDate,
      vacationRequestId: id
    });

    toast(`Отпуск одобрен: ${v.userNick}`);
  } catch (e) {
    console.error(e);
    toast('Ошибка: ' + (e.message || ''), 'err');
  }
}

async function rejectVacation(id) {
  if (lvl(currentProfile.rank) < 13 &&
      !['Губернатор','Администратор','Старший администратор','РП-Куратор'].includes(currentProfile.rank)) {
    return toast('Нет прав', 'err');
  }

  const v = cachedVacations.find(x => x.id === id);
  if (!v) return;
  if (v.status !== 'pending') return toast('Заявка уже рассмотрена', 'err');

  const comment = prompt('Причина отказа (обязательно):', '');
  if (comment === null) return;
  if (!comment.trim()) return toast('Укажи причину отказа', 'err');

  try {
    await updateDoc(doc(db, 'vacationRequests', id), {
      status: 'rejected',
      reviewedBy: currentProfile.nickname,
      reviewedByRank: currentProfile.rank,
      reviewedAt: serverTimestamp(),
      reviewComment: comment.trim()
    });
    toast('Заявка отклонена');
  } catch (e) {
    console.error(e);
    toast('Ошибка: ' + (e.message || ''), 'err');
  }
}

// Удаление заявки из журнала
async function deleteVacation(id) {
  if (lvl(currentProfile.rank) < 13) return toast('Нет прав', 'err');
  if (!confirm('Удалить заявку из журнала?')) return;
  await deleteDoc(doc(db, 'vacationRequests', id));
  toast('Удалено');
}

/* ==================== РЕНДЕР БЛОКА ЗАЯВОК ==================== */
function renderVacationRequestsBlock() {
  // Только для руководства
  const canManage = lvl(currentProfile.rank) >= 13
    || ['Губернатор','Администратор','Старший администратор','РП-Куратор'].includes(currentProfile.rank);
  if (!canManage) return '';

  const pending  = cachedVacations.filter(v => v.status === 'pending');
  const approved = cachedVacations.filter(v => v.status === 'approved');
  const rejected = cachedVacations.filter(v => v.status === 'rejected');

  // Фильтрация
  let visible = [];
  if (vacFilter === 'pending')  visible = pending;
  else if (vacFilter === 'active') visible = approved;
  else if (vacFilter === 'rejected') visible = rejected;
  else visible = cachedVacations;   // 'all'

  const pendingBadge = pending.length ? `<span class="tab-badge">${pending.length}</span>` : '';

  const rows = visible.length === 0
    ? `<p class="doc-meta" style="margin-top:14px">${
        vacFilter === 'pending'  ? 'Нет заявок на рассмотрении.'
        : vacFilter === 'active' ? 'Нет активных отпусков.'
        : vacFilter === 'rejected' ? 'Нет отклонённых заявок.'
        : 'Заявок пока нет.'
      }</p>`
    : visible.map(v => renderVacationRow(v)).join('');

  return `
    <div class="vac-section">
      <h3 style="color:var(--accent);margin:22px 0 12px">🏖 Заявки на отпуск ${pendingBadge}</h3>

      <div class="vac-filter-bar">
        <button class="vac-filter-btn ${vacFilter === 'pending'  ? 'active' : ''}" data-vac-filter="pending">
          ⏳ Ожидают ${pending.length ? `(${pending.length})` : ''}
        </button>
        <button class="vac-filter-btn ${vacFilter === 'active'   ? 'active' : ''}" data-vac-filter="active">
          ✅ Активные (${approved.length})
        </button>
        <button class="vac-filter-btn ${vacFilter === 'rejected' ? 'active' : ''}" data-vac-filter="rejected">
          ❌ Отклонены (${rejected.length})
        </button>
        <button class="vac-filter-btn ${vacFilter === 'all'      ? 'active' : ''}" data-vac-filter="all">
          📋 Все (${cachedVacations.length})
        </button>
      </div>

      <div class="vac-list">${rows}</div>
    </div>
  `;
}

function renderVacationRow(v) {
  const from = new Date(v.fromDate).toLocaleDateString('ru-RU', { day:'2-digit', month:'short', year:'numeric' });
  const to   = new Date(v.toDate).toLocaleDateString('ru-RU',   { day:'2-digit', month:'short', year:'numeric' });

  const canManage = lvl(currentProfile.rank) >= 13
    || ['Губернатор','Администратор','Старший администратор','РП-Куратор'].includes(currentProfile.rank);

  const cfg = {
    pending:  { icon: '⏳', label: 'Ожидает', cls: 'pending'  },
    approved: { icon: '✅', label: 'Одобрена', cls: 'approved' },
    rejected: { icon: '❌', label: 'Отклонена', cls: 'rejected' }
  }[v.status] || { icon: '❓', label: v.status, cls: 'pending' };

  const actions = [];
  if (canManage && v.status === 'pending') {
    actions.push(`<button class="btn" data-vac-approve="${v.id}">✓ Одобрить</button>`);
    actions.push(`<button class="btn danger" data-vac-reject="${v.id}">✗ Отклонить</button>`);
  }
  if (canManage) {
    actions.push(`<button class="btn secondary" data-vac-del="${v.id}" title="Удалить">🗑</button>`);
  }

  return `
    <div class="vac-row vac-row-${cfg.cls}">
      <div class="vac-row-main">
        <div class="vac-row-head">
          <div class="vac-row-user" onclick="location.hash='#/profile/${v.userId}'" style="cursor:pointer">
            <strong>${escapeHtml(v.userNick)}</strong>
            <span class="vac-row-rank">${escapeHtml(v.userRank || '')}</span>
          </div>
          <span class="vac-row-status vac-row-status-${cfg.cls}">${cfg.icon} ${cfg.label}</span>
        </div>

        <div class="vac-row-dates">
          📅 ${from} → ${to} · <strong>${v.days} ${pluralDays(v.days)}</strong>
        </div>

        <div class="vac-row-reason">💬 ${escapeHtml(v.reason)}</div>

        ${v.reviewedBy ? `
          <div class="vac-row-review">
            Рассмотрел: <strong>${escapeHtml(v.reviewedBy)}</strong> (${escapeHtml(v.reviewedByRank || '')})
            · ${fmtDate(v.reviewedAt)}
            ${v.reviewComment ? `<br>💬 ${escapeHtml(v.reviewComment)}` : ''}
          </div>
        ` : ''}

        <div class="vac-row-created">Подано: ${fmtDate(v.createdAt)}</div>
      </div>

      ${actions.length ? `<div class="vac-row-actions">${actions.join('')}</div>` : ''}
    </div>
  `;
}

/* ==================== ДЕЛЕГИРОВАНИЕ КЛИКОВ ==================== */
document.addEventListener('click', e => {
  const filterBtn = e.target.closest('[data-vac-filter]');
  if (filterBtn) {
    vacFilter = filterBtn.dataset.vacFilter;
    render();
    return;
  }

  const approveBtn = e.target.closest('[data-vac-approve]');
  if (approveBtn) { approveVacation(approveBtn.dataset.vacApprove); return; }

  const rejectBtn = e.target.closest('[data-vac-reject]');
  if (rejectBtn) { rejectVacation(rejectBtn.dataset.vacReject); return; }

  const delBtn = e.target.closest('[data-vac-del]');
  if (delBtn) { deleteVacation(delBtn.dataset.vacDel); return; }
});

/* ==================== АВТО-ВОЗВРАТ ИЗ ОТПУСКА ==================== */
// Если у сотрудника status='vacation' и vacationTo < сегодня —
// автоматически возвращаем его в строй.
async function checkExpiredVacation(profile) {
  if (!profile) return false;
  if (profile.status !== 'vacation') return false;
  if (!profile.vacationTo) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const end = new Date(profile.vacationTo);
  end.setHours(23, 59, 59, 999);   // отпуск длится весь последний день

  if (today > end) {
    try {
      await updateDoc(doc(db, 'users', currentUser.uid), {
        status: 'active',
        vacationFrom: null,
        vacationTo: null,
        vacationRequestId: null
      });
      profile.status = 'active';
      profile.vacationFrom = null;
      profile.vacationTo = null;
      profile.vacationRequestId = null;
      toast('🏖 Отпуск завершён — ты снова в строю');
      return true;
    } catch (e) {
      console.warn('Не удалось завершить отпуск:', e);
    }
  }
  return false;
}

/* ==================== ПРИНУДИТЕЛЬНЫЙ ПРОВАЛ ТЕСТА ==================== */
async function processInterruptedTest(run, reason) {
  if (!currentUser || !currentProfile) return;

  const total = run.questions.length;
  let score = 0;
  const answerLog = [];

  // Считаем баллы за те вопросы, на которые успел ответить
  run.questions.forEach((q, idx) => {
    const selected = run.answers[idx] || [];
    const correctIdxs = q.options.map((o, i) => o.correct ? i : -1).filter(i => i >= 0);
    
    const sortedSel = [...selected].sort((a,b) => a-b);
    const sortedCor = [...correctIdxs].sort((a,b) => a-b);
    const isCorrect = sortedSel.length === sortedCor.length && sortedSel.every((v, i) => v === sortedCor[i]);

    if (isCorrect) score++;

    answerLog.push({
      questionId: q.id,
      questionText: q.text,
      selectedOptions: selected.map(i => q.options[i]?.text || ''),
      correctOptions: correctIdxs.map(i => q.options[i]?.text || ''),
      isCorrect
    });
  });

  const percent = total > 0 ? Math.round((score / total) * 100) : 0;

  try {
    const ref = await addDoc(collection(db,'testResults'), {
      testId: run.testId,
      testTitle: run.test.title,
      userId: currentUser.uid,
      userNick: currentProfile.nickname,
      userRank: currentProfile.rank,
      score,
      total,
      percent,
      passed: false,
      failReason: reason, // 🔥 Записываем причину
      answers: answerLog,
      startedAt: run.startedAt,
      finishedAt: serverTimestamp(),
      audience: run.test.audience || 'all',
      testQuestionsEditedAt: run.test.questionsEditedAt || null
    });
    
    // Перекидываем на результат с пометкой провала
    location.hash = '#/test-result/' + ref.id;
    toast('Тест провален: ' + reason, 'err');
  } catch (e) {
    console.error('Не удалось сохранить прерванный тест:', e);
  }
}

/* ==================== СИСТЕМА УВЕДОМЛЕНИЙ ОБ ОБЪЯВЛЕНИЯХ ==================== */

// Проверяет, есть ли непрочитанные объявления
function hasUnreadAnnouncements() {
  if (!currentProfile || !cachedAnnouncements.length) return false;
  
  const latestAnn = cachedAnnouncements[0];
  if (!latestAnn.createdAt) return false;

  // Время последнего прочтения пользователя (если не читал — 0)
  let lastRead = 0;
  if (currentProfile.lastAnnouncementReadAt) {
    lastRead = currentProfile.lastAnnouncementReadAt.toDate 
      ? currentProfile.lastAnnouncementReadAt.toDate().getTime() 
      : new Date(currentProfile.lastAnnouncementReadAt).getTime();
  }

  // Время создания самого свежего объявления
  const latestTime = latestAnn.createdAt.toDate 
    ? latestAnn.createdAt.toDate().getTime() 
    : new Date(latestAnn.createdAt).getTime();

  // Добавляем 1 секунду (1000 мс) буфера, чтобы не было ложных срабатываний
  return latestTime > (lastRead + 1000);
}

// Отмечает все объявления как прочитанные
async function markAnnouncementsAsRead() {
  if (!currentUser) return;
  
  try {
    const now = new Date();
    await updateDoc(doc(db, 'users', currentUser.uid), {
      lastAnnouncementReadAt: serverTimestamp()
    });
    
    // Обновляем локально, чтобы не ждать ответа базы
    if (currentProfile) currentProfile.lastAnnouncementReadAt = now;
    
    // Перестраиваем меню, чтобы убрать красную точку
    buildNav();
  } catch (e) {
    console.warn('Не удалось отметить объявления прочитанными:', e);
  }
}

// Показывает всплывающую плашку
function showAnnouncementBanner(ann) {
  const oldBanner = document.querySelector('.ann-banner');
  if (oldBanner) oldBanner.remove();

  // 🔊 Воспроизводим звук при появлении плашки
  playNotificationSound();

  const banner = document.createElement('div');
  banner.className = 'ann-banner';
  banner.innerHTML = `
    <div class="ann-banner-icon">🔔</div>
    <div class="ann-banner-text">
      Новое объявление!
      <span>${escapeHtml(ann.title)}</span>
    </div>
  `;
  // Клик по плашке → переход в раздел
  banner.onclick = () => {
    location.hash = '#/announcements';
    banner.classList.remove('show');
    setTimeout(() => banner.remove(), 400);
  };

  document.body.appendChild(banner);

  // Выезжает через 100мс (чтобы сработала анимация)
  setTimeout(() => banner.classList.add('show'), 100);

  // Уезжает через 8 секунд
  setTimeout(() => {
    if (banner.parentNode) {
      banner.classList.remove('show');
      setTimeout(() => banner.remove(), 400);
    }
  }, 8000);
}

/* ==================== ЗВУКОВЫЕ УВЕДОМЛЕНИЯ ==================== */
let audioCtx = null;

// Создаем контекст ТОЛЬКО при клике пользователя
function initAudio() {
  if (audioCtx) return; 
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch (e) {}
}

// Вешаем на любые действия пользователя
document.addEventListener('click', initAudio);
document.addEventListener('keydown', initAudio);
document.addEventListener('touchstart', initAudio);

function playNotificationSound() {
  // Если вкладка свернута, контекст не создан или браузер его усыпил — выходим без ошибок
  if (document.hidden || !audioCtx || audioCtx.state === 'suspended') return;
  
  try {
    const now = audioCtx.currentTime;
    const osc1 = audioCtx.createOscillator();
    const osc2 = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc1.type = 'sine';
    osc2.type = 'sine';
    
    // Приятный аккорд (две ноты)
    osc1.frequency.setValueAtTime(1318.51, now); // E6
    osc2.frequency.setValueAtTime(1760.00, now); // A6

    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.3, now + 0.05); 
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.8);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(audioCtx.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.8);
    osc2.stop(now + 0.8);
  } catch (e) {}
}

// Глушим известную ошибку библиотеки web-vitals (startTime)
window.addEventListener('error', (event) => {
  if (event.message && event.message.includes('startTime') && event.message.includes('reportAllChanges')) {
    event.preventDefault(); // Отменяем вывод в консоль
    return true;
  }
});