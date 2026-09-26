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
  'Старший администратор': { level: 100, police: false }
};

// Порядок для выпадающих списков (от старших к младшим)
export const ROLES_ORDERED = [
  'Старший администратор','Администратор','Губернатор','Правительство',
  'Генерал полиции','Полковник','Руководитель ОБН','Подполковник',
  'Майор','Капитан','Агент ОБН','Старший лейтенант','Лейтенант',
  'Младший лейтенант','SWAT','Старший сержант','Сержант','Капрал',
  'Рядовой','Гражданский'
];

export const MAX_STAFF = 24;

/* ============ КТО МОЖЕТ ЧТО ============ */
export const CAN_MANAGE_STAFF = [
  'Полковник','Генерал полиции','Губернатор',
  'Администратор','Старший администратор'
];

export const CAN_DELETE_REPORTS = [
  'Подполковник','Полковник','Генерал полиции',
  'Губернатор','Администратор','Старший администратор'
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
export const TESTS = [
  {
    id:'ustav-test',
    title:'Тест: Устав Полиции',
    passScore: 80,
    questions: [
      { q:'Что обязан делать сотрудник при виде нарушения?',
        options:['Игнорировать','Вмешаться и зафиксировать','Уйти с места'],
        correct: 1 },
      { q:'Обязан ли сотрудник представиться при задержании?',
        options:['Да','Нет','Только если попросят'], correct: 0 }
    ]
  }
];

export const CAN_RESET_PASSWORDS_FROM_LEVEL = 13;