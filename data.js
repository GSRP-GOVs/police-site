/* ============ РОЛИ И ИХ УРОВНИ ============ */
export const ROLES = {
  'Гражданский':           { level: 0,   police: false, label: 'Гражданский' },
  'Рядовой':               { level: 1,   police: true },
  'Капрал':                { level: 2,   police: true },
  'Сержант':               { level: 3,   police: true },
  'Старший сержант':       { level: 4,   police: true },
  'SWAT':                  { level: 5,   police: true,  swat: true },
  'Младший лейтенант':     { level: 5,   police: true },
  'Лейтенант':             { level: 6,   police: true },
  'Старший лейтенант':     { level: 7,   police: true },
  'Агент ОБН':             { level: 8,   police: true },
  'Капитан':               { level: 9,   police: true },
  'Майор':                 { level: 10,  police: true },
  'Подполковник':          { level: 11,  police: true },
  'Руководитель ОБН':      { level: 12,  police: true },
  'Полковник':             { level: 13,  police: true },
  'Генерал полиции':       { level: 14,  police: true },
  'Правительство':         { level: 70,  police: false },
  'Губернатор':            { level: 80,  police: false },
  'Администратор':         { level: 90,  police: false },
  'РП-Куратор':            { level: 95,  police: true },
  'Старший администратор': { level: 100, police: false }
};

// Порядок для выпадающих списков (от старших к младшим)
export const ROLES_ORDERED = [
  'Старший администратор','РП-Куратор','Администратор','Губернатор','Правительство',
  'Генерал полиции','Полковник','Руководитель ОБН','Подполковник',
  'Майор','Капитан','Агент ОБН','Старший лейтенант','Лейтенант',
  'Младший лейтенант','SWAT','Старший сержант','Сержант','Капрал',
  'Рядовой','Гражданский'
];

export const MAX_STAFF = 24;

/* ============ КТО МОЖЕТ ЧТО ============ */
export const CAN_MANAGE_STAFF = [
  'Полковник','Генерал полиции','Губернатор',
  'Администратор','Старший администратор','РП-Куратор'
];

export const CAN_DELETE_REPORTS = [
  'Подполковник','Полковник','Генерал полиции',
  'Губернатор','Администратор','Старший администратор','РП-Куратор'
];

/* ============ ВЫГОВОРЫ ============ */
export const WARNING_LEVELS = {
  'light':  { label: 'Лёгкий',  color: '#f0b429' },
  'medium': { label: 'Средний', color: '#e67e22' },
  'heavy':  { label: 'Тяжёлый', color: '#e74c3c' }
};

/* ============ ДОКУМЕНТЫ ============ */
export const DOCS = [
  { id:'ustav', title:'Устав Полиции / SWAT', category:'Фракция',
    content:`[ЗАПОЛНИ ТЕКСТОМ УСТАВА]` },
  { id:'rules-police', title:'Правила Полиции', category:'Фракция',
    content:`[ЗАПОЛНИ ПРАВИЛАМИ]` },
  { id:'lore-police', title:'Лор Полиции', category:'Фракция',
    content:`[ЛОР ФРАКЦИИ]` },
  { id:'uk', title:'Уголовный Кодекс', category:'Законодательная база',
    content:`[УК]` },
  { id:'ak', title:'Административный Кодекс', category:'Законодательная база',
    content:`[АК]` },
  { id:'pk', title:'Процессуальный Кодекс', category:'Законодательная база',
    content:`[ПК]` },
  { id:'dk', title:'Дорожный Кодекс', category:'Законодательная база',
    content:`[ДК]` },
  { id:'zzt', title:'Закон о закрытых и охраняемых территориях',
    category:'Законодательная база', content:`[ТЕКСТ]` },
  { id:'zoo', title:'Закон об обороте вооружения',
    category:'Законодательная база', content:`[ТЕКСТ]` },
  { id:'zondl', title:'Закон о неприкосновенности должностных лиц',
    category:'Законодательная база', content:`[ТЕКСТ]` },
  { id:'zoad', title:'Закон об адвокатской деятельности',
    category:'Законодательная база', content:`[ТЕКСТ]` },
  { id:'zoso', title:'Закон о системе ордеров',
    category:'Законодательная база', content:`[ТЕКСТ]` },
  { id:'raids', title:'Рейды / Обыски', category:'Дополнительно',
    content:`[ПРОЦЕДУРА]` },
  { id:'term', title:'Общая терминология', category:'Правила сервера',
    content:`[ТЕРМИНЫ]` },
  { id:'server-rules', title:'Общие правила сервера', category:'Правила сервера',
    content:`[ПРАВИЛА]` }
];

/* ============ ТЕСТЫ ============ */
/* ============ ТЕСТЫ ============ */
// Теперь тесты хранятся в Firestore и управляются через интерфейс сайта.
// Настройки таймера, вопросов и картинок — в редакторе тестов.
export const TESTS = [];  // Оставлено для совместимости, не используется

export const CAN_RESET_PASSWORDS_FROM_LEVEL = 13;

/* ============ СТАТЬИ УК/АК ============ */
// prisonMonths — срок в RP-месяцах (= минут реального времени)
// fineMin / fineMax — диапазон штрафа в exp (0 = штраф не предусмотрен)
// wantedLevel — уровень розыска (0–5 звёзд)
export const LAWS = [
  { code:'17.6', codeType:'УК',
    title:'Неповиновение законному распоряжению или требованию правомочного лица, либо воспрепятствование исполнению им служебных обязанностей',
    prisonMonths: 10, fineMin: 5000, fineMax: 10000, wantedLevel: 3 },

  { code:'17.1', codeType:'УК',
    title:'Посягательство на жизнь сотрудника правоохранительного органа, военнослужащего, при исполнении им своих служебных обязанностей, а равно в связи с их исполнением или из мести за их исполнение',
    prisonMonths: 50, fineMin: 0, fineMax: 0, wantedLevel: 5 },

  { code:'13.1', codeType:'УК',
    title:'Незаконное кустарное производство и сбор наркотических веществ в любых размерах',
    prisonMonths: 15, fineMin: 10000, fineMax: 15000, wantedLevel: 3 },

  { code:'13.2', codeType:'УК',
    title:'Незаконное приобретение, хранение, перевозка и сбыт наркотических средств или оборудования для их производства',
    prisonMonths: 20, fineMin: 15000, fineMax: 20000, wantedLevel: 3 },

  { code:'12.8', codeType:'УК',
    title:'Незаконный оборот оружия. Незаконное хранение, приобретение, передача, сбыт, перевозка любых видов оружия и боеприпасов',
    prisonMonths: 15, fineMin: 5000, fineMax: 10000, wantedLevel: 5 },

  { code:'12.8.1', codeType:'УК',
    title:'Использование, ношение, хранение гражданскими лицами спец. средств, формы, государственного имущества',
    prisonMonths: 20, fineMin: 5000, fineMax: 7000, wantedLevel: 5 }
];

/* ============ КОНСТАНТЫ ЗАДЕРЖАНИЙ ============ */
export const DETENTION_MAX_PRISON_MINUTES = 60;  // максимум 60 минут
export const DETENTION_EDIT_HOURS = 36;          // автор может редактировать 36 часов

// Кто может досрочно освобождать (Старший сержант+)
export const CAN_RELEASE_EARLY = [
  'Старший сержант','Младший лейтенант','Лейтенант','Старший лейтенант',
  'Агент ОБН','Капитан','Майор','Подполковник','Руководитель ОБН',
  'Полковник','Генерал полиции','Губернатор','Администратор','Старший администратор','РП-Куратор'
];

// Кто может редактировать чужие записи (Подполковник+)
export const CAN_EDIT_ANY_DETENTION = [
  'Подполковник','Руководитель ОБН','Полковник','Генерал полиции',
  'Губернатор','Администратор','Старший администратор','РП-Куратор'
];

/* ============ СТАТУСЫ СОТРУДНИКОВ ============ */
export const STATUS_LABELS = {
  'active':   { label: 'Активен',        color: '#2ecc71' },
  'vacation': { label: 'В отпуске',      color: '#4a90e2' },
  'sick':     { label: 'На больничном',  color: '#f0b429' },
  'fired':    { label: 'Уволен',         color: '#e74c3c' }
};

/* ============ ПООЩРЕНИЯ ============ */
export const AWARD_TYPES = {
  'thanks': { label: '🏅 Благодарность', color: '#2ecc71', hasAmount: false },
  'bonus':  { label: '💰 Премия',        color: '#f0b429', hasAmount: true  }
};

export const CAN_GIVE_AWARDS = [
  'Полковник','Руководитель ОБН','Генерал полиции',
  'Губернатор','Администратор','Старший администратор','РП-Куратор'
];

/* ============ ОБЪЯВЛЕНИЯ ============ */
export const CAN_CREATE_ANNOUNCEMENTS_FROM_LEVEL = 10; // Майор+
export const CAN_PIN_ANNOUNCEMENTS_FROM_LEVEL = 13;    // Полковник+



/* ============ ТЕГИ ОТЧЁТОВ ============ */
export const REPORT_TAGS = [
  { id: 'dtp',       label: '#ДТП',       color: '#e67e22' },
  { id: 'chase',     label: '#погоня',    color: '#e74c3c' },
  { id: 'arrest',    label: '#арест',     color: '#3498db' },
  { id: 'raid',      label: '#рейд',      color: '#9b59b6' },
  { id: 'fine',      label: '#штраф',     color: '#f0b429' },
  { id: 'search',    label: '#обыск',     color: '#16a085' },
  { id: 'patrol',    label: '#патруль',   color: '#2ecc71' },
  { id: 'violation', label: '#нарушение', color: '#c0392b' },
  { id: 'incident',  label: '#инцидент',  color: '#8e44ad' },
  { id: 'killed',    label: '#убит',      color: '#e74c3c' }
];

/* ============ ЗАКРЕПЛЁННЫЕ ОТЧЁТЫ ============ */
export const CAN_PIN_REPORTS_FROM_LEVEL = 10;  // Майор+
export const CAN_UNPIN_ANY_FROM_LEVEL = 13;    // Полковник+