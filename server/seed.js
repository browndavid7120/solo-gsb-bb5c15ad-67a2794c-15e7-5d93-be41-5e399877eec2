'use strict';
// 首次启动时写入演示数据（仅当原料表为空时），随后执行一次全量推导。
const { getDb } = require('./db');
const { recompute, sortedJson } = require('./recompute');

function seedIfEmpty() {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) AS c FROM materials').get().c;
  if (count > 0) return false;

  const batchIds = {};
  const insertBase = db.transaction(() => {
    const insMaterial = db.prepare(
      'INSERT INTO materials (code, name, allergens) VALUES (?,?,?)'
    );
    const insEquip = db.prepare(
      'INSERT INTO equipment (code, name) VALUES (?,?)'
    );
    const insBatch = db.prepare('INSERT INTO batches (code) VALUES (?)');
    const insEvent = db.prepare(
      `INSERT INTO events (event_time, type, equipment_id, batch_id, note)
       VALUES (?,?,?,?,?)`
    );
    const insInput = db.prepare(
      'INSERT INTO process_inputs (event_id, material_id, batch_id) VALUES (?,?,?)'
    );

    const mats = {};
    const addMat = (code, name, allergens) => {
      mats[code] = insMaterial.run(code, name, JSON.stringify(allergens)).lastInsertRowid;
    };
    addMat('WHEAT-01', '小麦面粉', ['含麸质的谷物']);
    addMat('SOY-01', '酿造酱油', ['大豆', '含麸质的谷物']);
    addMat('MILK-01', '全脂奶粉', ['乳']);
    addMat('EGG-01', '全蛋液', ['蛋']);
    addMat('SESAME-01', '芝麻酱', ['芝麻']);
    addMat('PEANUT-01', '花生碎', ['花生']);
    addMat('SALT-01', '食用盐', []);

    const lineA = insEquip.run('LINE-A', '烘焙A线').lastInsertRowid;
    const fryerB = insEquip.run('FRYER-B', '油炸B线').lastInsertRowid;

    ['BATCH-001', 'BATCH-002', 'BATCH-003', 'BATCH-004', 'BATCH-005']
      .forEach((code) => { batchIds[code] = insBatch.run(code).lastInsertRowid; });

    const D = '2026-09-30T';
    const process = (time, equip, bid, note) =>
      insEvent.run(D + time, 'PROCESS', equip, bid, note).lastInsertRowid;
    const clean = (time, equip, note) =>
      insEvent.run(D + time, 'CLEAN', equip, null, note).lastInsertRowid;
    const matInput = (eid, code) => insInput.run(eid, mats[code], null);
    const batchInput = (eid, code) => insInput.run(eid, null, batchIds[code]);

    const e1 = process('08:00', lineA, batchIds['BATCH-001'], '早班面团');
    matInput(e1, 'WHEAT-01');
    matInput(e1, 'SALT-01');

    clean('09:00', lineA, '换线前已核实清洗');

    const e3 = process('10:00', lineA, batchIds['BATCH-002'], '蛋糕糊');
    matInput(e3, 'MILK-01');
    matInput(e3, 'EGG-01');

    const e4 = process('11:00', lineA, batchIds['BATCH-003'], '芝麻风味蛋糕糊（引用上一批）');
    matInput(e4, 'SESAME-01');
    batchInput(e4, 'BATCH-002');

    const e5 = process('12:00', fryerB, batchIds['BATCH-004'], '裹粉花生');
    matInput(e5, 'PEANUT-01');
    matInput(e5, 'SOY-01');

    clean('13:00', fryerB, '已核实清洗（CIP + 目视复核）');

    const e7 = process('14:00', fryerB, batchIds['BATCH-005'], '清洗后空白验证批');
    matInput(e7, 'SALT-01');

    clean('15:00', lineA, '班后已核实清洗');
  });
  insertBase();

  // 推导一次后，按“当时结果”为 BATCH-003 登记放行
  recompute(db);
  const out = db.prepare(
    'SELECT allergens FROM batch_outputs WHERE batch_id = ?'
  ).get(batchIds['BATCH-003']);
  const releaseInfo = db.prepare(
    `INSERT INTO releases (batch_id, released_at, released_by, snapshot_allergens, status, created_event_seq)
     VALUES (?,?,?,?,'ACTIVE',(SELECT COUNT(*) FROM events))`
  ).run(batchIds['BATCH-003'], '2026-09-30T11:30', '质检员-王敏',
        sortedJson(JSON.parse(out.allergens)));
  const releaseId = releaseInfo.lastInsertRowid;

  // 包装前登记一卷 BATCH-003 的过敏原标签（集合与当前推导、放行快照一致）：
  // 印量 500，演示已贴 120、作废 3。按 README“快速体验”给 BATCH-001 加入全蛋液后，
  // 重算使 BATCH-003 集合新增“蛋”，本卷将被永久停用、已贴数量进入待复核。
  db.prepare(
    `INSERT INTO label_rolls
       (roll_code, batch_id, release_id, allergens, printed_qty,
        used_qty, void_qty, status, review_pending, revision,
        registered_at, registered_by)
     VALUES ('LR-0001', ?, ?, ?, 500, 120, 3, 'ACTIVE', 0, 2,
             '2026-09-30T11:35', '包装班长-李强')`
  ).run(batchIds['BATCH-003'], releaseId, sortedJson(JSON.parse(out.allergens)));
  db.prepare(
    `INSERT INTO label_roll_ledger
       (roll_id, applied_delta, void_delta, revision_after, operated_by, note, created_at)
     VALUES (1, 120, 3, 2, '包装班长-李强', '首批领用核销', '2026-09-30T12:10:00')`
  ).run();

  return true;
}

module.exports = { seedIfEmpty };

if (require.main === module) {
  const seeded = seedIfEmpty();
  console.log(seeded ? '演示数据已初始化' : '数据已存在，跳过演示数据');
}
