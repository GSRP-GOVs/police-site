/* ============================================================
   PPD — Автоматический бэкап Firestore (для GitHub Actions)
   Запускается по расписанию, пишет JSON-файл в текущую папку.
   Требует переменную окружения FIREBASE_SERVICE_ACCOUNT —
   содержимое serviceAccountKey.json (целиком, одной строкой).
   ============================================================ */

const admin = require('firebase-admin');
const fs = require('fs');

// --- Инициализация Admin SDK ---
const rawSa = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!rawSa) {
  console.error('❌ Не задан FIREBASE_SERVICE_ACCOUNT');
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(rawSa);
} catch (e) {
  console.error('❌ Не удалось распарсить FIREBASE_SERVICE_ACCOUNT:', e.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// --- Что бэкапим ---
// invites и passwordResets исключены намеренно (персональные данные)
const COLLECTIONS = [
  'users',
  'reports',
  'detentions',
  'fines',
  'announcements',
  'tests',
  'testResults'
];
const CONFIG_IDS = ['dashboard', 'promotion'];

// --- Firestore Timestamp → ISO ---
function replacer(key, value) {
  if (value && typeof value === 'object' && typeof value.toDate === 'function') {
    return { __timestamp: value.toDate().toISOString() };
  }
  return value;
}

(async () => {
  console.log('📦 Начинаю бэкап...');
  const startedAt = Date.now();

  const backup = {
    meta: {
      generatedAt: new Date().toISOString(),
      generatedBy: 'github-actions',
      version: '1.0',
      excludedCollections: ['invites', 'passwordResets']
    },
    collections: {}
  };

  let totalRows = 0;

  for (const name of COLLECTIONS) {
    try {
      const snap = await db.collection(name).get();
      backup.collections[name] = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
      totalRows += snap.size;
      console.log(`  ✓ ${name}: ${snap.size}`);
    } catch (e) {
      console.error(`  ✗ ${name}: ${e.message}`);
      backup.collections[name] = [];
    }
  }

  // config
  backup.collections.config = {};
  for (const cfgId of CONFIG_IDS) {
    try {
      const cfgDoc = await db.collection('config').doc(cfgId).get();
      if (cfgDoc.exists) {
        backup.collections.config[cfgId] = cfgDoc.data();
        console.log(`  ✓ config/${cfgId}`);
      }
    } catch (e) {
      console.error(`  ✗ config/${cfgId}: ${e.message}`);
    }
  }

  const json = JSON.stringify(backup, replacer, 2);

  const stamp = new Date().toISOString().slice(0, 10);          // YYYY-MM-DD
  const fileName = `ppd-backup-${stamp}.json`;
  fs.writeFileSync(fileName, json, 'utf8');

  const took = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n✅ Готово: ${fileName}`);
  console.log(`   Записей: ${totalRows}`);
  console.log(`   Размер:  ${(json.length / 1024).toFixed(1)} КБ`);
  console.log(`   Время:   ${took}s`);
})().catch(err => {
  console.error('❌ Критическая ошибка:', err);
  process.exit(1);
});