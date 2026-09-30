'use strict';
// 过敏原标签卷：端到端 HTTP 测试。
// 启动一个使用临时 SQLite 文件的真实服务实例（含演示数据），逐条验证需求。
//   node scripts/test-labels.js
// 退出码 0 表示全部通过。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = '39118';
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labels-test-'));
const dbPath = path.join(tmpDir, 'test.db');

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

async function api(method, urlPath, body) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* 非 JSON */ }
  return { status: res.status, json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(proc) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE + '/api/state');
      if (res.ok) return;
    } catch (_) { /* 未就绪 */ }
    if (proc.exitCode !== null) throw new Error('服务提前退出');
    await sleep(250);
  }
  throw new Error('服务启动超时');
}

async function main() {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT, HOST: '127.0.0.1', DB_PATH: dbPath, SEED_DEMO: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  try {
    await waitReady(proc);
    console.log('服务已就绪，开始测试');

    let state = (await api('GET', '/api/state')).json;
    const batchByCode = (code) => state.batches.find((b) => b.code === code);
    const eventByCode = (code) => state.events.find((e) => e.batch_code === code);
    const mat = (code) => state.materials.find((m) => m.code === code);
    const D = '2026-09-30T';

    // 演示数据已为 BATCH-003 登记一卷 LR-0001
    const b3 = batchByCode('BATCH-003');
    const seedRoll = b3.label_rolls[0];
    console.log('0) 演示数据自带一卷标签');
    check('BATCH-003 有 1 卷', b3.label_rolls.length === 1, b3.label_rolls);
    check('卷号 LR-0001', seedRoll.roll_code === 'LR-0001', seedRoll);
    check('印量500/贴用120/作废3/剩余377',
      seedRoll.printed_qty === 500 && seedRoll.applied_qty === 120 &&
      seedRoll.void_qty === 3 && seedRoll.available_qty === 377, seedRoll);
    check('修订号为 2', seedRoll.revision === 2, seedRoll);
    check('状态 ACTIVE', seedRoll.status === 'ACTIVE', seedRoll);

    // ---------- 1. 登记：三重一致成功，返回卷号与可用张数 ----------
    console.log('1) 登记标签卷：拟印集合=当前推导=有效放行快照');
    const releaseId = b3.releases.find((r) => r.status === 'ACTIVE').id;
    let r = await api('POST', '/api/label-rolls', {
      batch_id: b3.id, release_id: releaseId,
      allergens: b3.allergens, printed_qty: 100, registered_by: '测试-张三'
    });
    check('登记 200', r.status === 200, r);
    check('返回卷号 LR-0002', r.json.roll_code === 'LR-0002', r.json);
    check('返回可用张数=100、修订号=1',
      r.json.available_qty === 100 && r.json.revision === 1, r.json);
    const roll2 = r.json;

    // ---------- 2. 登记拒绝：拟印集合与当前推导不一致 ----------
    console.log('2) 拟印集合与批次推导不一致 → 400 整次拒绝');
    r = await api('POST', '/api/label-rolls', {
      batch_id: b3.id, release_id: releaseId,
      allergens: b3.allergens.concat(['不存在的过敏原']), printed_qty: 100
    });
    check('返回 400 LABEL_REJECTED',
      r.status === 400 && r.json.code === 'LABEL_REJECTED', r);
    check('拒绝原因提示“不一致”', r.json.error.includes('不一致'), r.json);

    // ---------- 2b. 登记拒绝：印量非正整数 ----------
    console.log('2b) 印量为 0 / 负数 / 小数 → 400');
    for (const qty of [0, -5, 1.5, 'abc']) {
      r = await api('POST', '/api/label-rolls', {
        batch_id: b3.id, release_id: releaseId, allergens: b3.allergens, printed_qty: qty
      });
      check(`印量 ${JSON.stringify(qty)} 被拒`, r.status === 400 && r.json.code === 'LABEL_REJECTED', r);
    }

    // ---------- 2c. 登记拒绝：绑定失效放行 / 不属于该批次 ----------
    console.log('2c) 放行选择校验');
    r = await api('POST', '/api/label-rolls', {
      batch_id: b3.id, release_id: 999999, allergens: b3.allergens, printed_qty: 10
    });
    check('不存在的放行 → 400', r.status === 400, r);
    const b1 = batchByCode('BATCH-001');
    r = await api('POST', '/api/label-rolls', {
      batch_id: b1.id, release_id: releaseId, allergens: b1.allergens, printed_qty: 10
    });
    check('放行不属于该批次 → 400', r.status === 400, r);

    // ---------- 3. 核销成功：贴用+作废，修订号递增 ----------
    console.log('3) 核销：贴用/作废成功，修订号 +1，余量更新');
    r = await api('POST', `/api/label-rolls/${roll2.id}/consume`, {
      expected_revision: 1, applied_delta: 30, void_delta: 2, operated_by: '测试-李四'
    });
    check('核销 200', r.status === 200, r);
    check('贴用30/作废2/剩余68/修订号2',
      r.json.applied_qty === 30 && r.json.void_qty === 2 &&
      r.json.available_qty === 68 && r.json.revision === 2, r.json);

    // ---------- 4. 旧修订号整次拒绝（409，状态不变） ----------
    console.log('4) 旧修订号 → 409 整次拒绝，状态不变');
    r = await api('POST', `/api/label-rolls/${roll2.id}/consume`, {
      expected_revision: 1, applied_delta: 5, void_delta: 0
    });
    check('返回 409 LABEL_CONFLICT',
      r.status === 409 && r.json.code === 'LABEL_CONFLICT', r);
    let detail = (await api('GET', `/api/label-rolls/${roll2.id}`)).json;
    check('拒绝后贴用仍 30、修订号仍 2',
      detail.applied_qty === 30 && detail.revision === 2, detail);
    check('流水仅 1 笔', detail.ledger.length === 1, detail.ledger);

    // ---------- 5. 负数核销拒绝（400） ----------
    console.log('5) 负数张数 → 400 整次拒绝');
    r = await api('POST', `/api/label-rolls/${roll2.id}/consume`, {
      expected_revision: 2, applied_delta: -1, void_delta: 0
    });
    check('贴用负数 → 400', r.status === 400 && r.json.code === 'LABEL_REJECTED', r);
    r = await api('POST', `/api/label-rolls/${roll2.id}/consume`, {
      expected_revision: 2, applied_delta: 0, void_delta: -3
    });
    check('作废负数 → 400', r.status === 400 && r.json.code === 'LABEL_REJECTED', r);

    // ---------- 6. 累计超量拒绝（400，整次不生效） ----------
    console.log('6) 累计超过印量 → 400 整次拒绝');
    r = await api('POST', `/api/label-rolls/${roll2.id}/consume`, {
      expected_revision: 2, applied_delta: 68, void_delta: 1 // 合计 101 > 100
    });
    check('超量 → 400', r.status === 400 && r.json.code === 'LABEL_REJECTED', r);
    detail = (await api('GET', `/api/label-rolls/${roll2.id}`)).json;
    check('超量拒绝后状态不变（仍 30/2/68，修订 2）',
      detail.applied_qty === 30 && detail.void_qty === 2 &&
      detail.available_qty === 68 && detail.revision === 2, detail);
    check('超量不产生流水（仍 1 笔）', detail.ledger.length === 1, detail.ledger);

    // ---------- 6b. 恰好贴满允许；再贴拒绝 ----------
    console.log('6b) 贴到印量边界成功，余量 0 后不可再贴');
    r = await api('POST', `/api/label-rolls/${roll2.id}/consume`, {
      expected_revision: 2, applied_delta: 60, void_delta: 8
    });
    check('贴满 100 → 200，剩余 0，修订 3',
      r.status === 200 && r.json.available_qty === 0 &&
      r.json.applied_qty === 90 && r.json.void_qty === 10 && r.json.revision === 3, r.json);
    r = await api('POST', `/api/label-rolls/${roll2.id}/consume`, {
      expected_revision: 3, applied_delta: 1, void_delta: 0
    });
    check('贴满后再贴 1 张 → 400', r.status === 400, r);

    // ---------- 7. 集合改变 → 卷永久停用、已贴待复核、余量不可再贴 ----------
    console.log('7) 原料/加工事件变更使集合改变：卷永久停用（终态，不自动恢复）');
    // 演示时间线：BATCH-001(麸质) → 清洗 → BATCH-002(乳,蛋) → BATCH-003(芝麻,乳,蛋，引用 BATCH-002)
    // 给 BATCH-001 加入全蛋液：09:00 清洗清空 LINE-A，残留不传播，故改用“给 BATCH-002 加花生”，
    // 经引用传播到 BATCH-003，集合新增花生。
    const e2 = eventByCode('BATCH-002');
    const peanut = mat('PEANUT-01').id;
    r = await api('PUT', `/api/events/${e2.id}`, {
      type: 'PROCESS',
      event_time: e2.event_time,
      equipment_id: e2.equipment_id,
      note: e2.note || '',
      batch_code: e2.batch_code,
      material_ids: e2.inputs.filter((i) => i.material_id).map((i) => i.material_id).concat(peanut),
      ref_batch_ids: e2.inputs.filter((i) => i.ref_batch_id).map((i) => i.ref_batch_id)
    });
    check('更正事件 200', r.status === 200, r);
    check('返回停用卷列表（含 2 卷：LR-0001 已贴120、LR-0002 已贴90）',
      Array.isArray(r.json.deactivated_rolls) && r.json.deactivated_rolls.length === 2,
      r.json.deactivated_rolls);
    check('返回失效放行列表',
      Array.isArray(r.json.invalidated) && r.json.invalidated.some((x) => x.batch_code === 'BATCH-003'),
      r.json.invalidated);

    detail = (await api('GET', `/api/label-rolls/${roll2.id}`)).json;
    check('LR-0002 已 DEACTIVATED', detail.status === 'DEACTIVATED', detail);
    check('已贴数量标记待复核', detail.review_pending === true, detail);
    check('停用原因含“不一致”', detail.deactivate_reason.includes('不一致'), detail);
    check('停用原因含“新增：花生”', detail.deactivate_reason.includes('花生'), detail);
    check('有停用时间', !!detail.deactivated_at, detail);

    r = await api('POST', `/api/label-rolls/${roll2.id}/consume`, {
      expected_revision: 3, applied_delta: 0, void_delta: 0
    });
    check('停用后任何核销 → 409', r.status === 400 || r.status === 409, r);
    // 明确语义：停用为冲突类 409
    check('停用核销 code=LABEL_CONFLICT(409)',
      r.status === 409 && r.json.code === 'LABEL_CONFLICT', r);

    // ---------- 8. 即使集合恢复也不自动解冻 ----------
    console.log('8) 集合后来恢复，已停用卷不自动解冻');
    r = await api('PUT', `/api/events/${e2.id}`, {
      type: 'PROCESS',
      event_time: e2.event_time,
      equipment_id: e2.equipment_id,
      note: e2.note || '',
      batch_code: e2.batch_code,
      material_ids: e2.inputs.filter((i) => i.material_id).map((i) => i.material_id),
      ref_batch_ids: e2.inputs.filter((i) => i.ref_batch_id).map((i) => i.ref_batch_id)
    });
    check('恢复更正 200', r.status === 200, r);
    state = (await api('GET', '/api/state')).json;
    const b3again = state.batches.find((b) => b.code === 'BATCH-003');
    check('集合恢复不含花生', !b3again.allergens.includes('花生'), b3again.allergens);
    detail = (await api('GET', `/api/label-rolls/${roll2.id}`)).json;
    check('已停用卷仍 DEACTIVATED（不自动恢复）', detail.status === 'DEACTIVATED', detail);
    check('待复核标记仍保留', detail.review_pending === true, detail);
    // 失效放行不会因集合恢复而复活（既有语义）
    check('旧放行仍 INVALIDATED',
      b3again.releases.every((x) => x.status === 'INVALIDATED'), b3again.releases);

    // ---------- 9. 放行删除：绑定卷永久停用 ----------
    console.log('9) 删除放行 → 绑定的有效卷永久停用');
    // 先为 BATCH-003 重新登记一条有效放行（集合已恢复）
    r = await api('POST', '/api/releases', {
      batch_id: b3.id, released_at: D + '16:00', released_by: '复检员'
    });
    check('重新登记放行 200', r.status === 200, r);
    state = (await api('GET', '/api/state')).json;
    const newRel = state.batches.find((b) => b.code === 'BATCH-003')
      .releases.find((x) => x.status === 'ACTIVE');
    r = await api('POST', '/api/label-rolls', {
      batch_id: b3.id, release_id: newRel.id,
      allergens: newRel.snapshot_allergens, printed_qty: 50, registered_by: '测试-王五'
    });
    check('新卷登记成功', r.status === 200 && r.json.roll_code === 'LR-0003', r);
    const roll3Id = r.json.id;

    // 先核销一笔
    r = await api('POST', `/api/label-rolls/${roll3Id}/consume`, {
      expected_revision: 1, applied_delta: 7, void_delta: 0
    });
    check('新卷核销一笔成功', r.status === 200 && r.json.revision === 2, r);

    r = await api('DELETE', `/api/releases/${newRel.id}`);
    check('删除放行 200', r.status === 200, r);
    check('返回停用卷',
      Array.isArray(r.json.deactivated_rolls) && r.json.deactivated_rolls.length === 1,
      r.json);
    detail = (await api('GET', `/api/label-rolls/${roll3Id}`)).json;
    check('LR-0003 永久停用', detail.status === 'DEACTIVATED', detail);
    check('停用原因为放行删除', detail.deactivate_reason.includes('放行记录已被删除'), detail);
    check('release_id 已置空（卷记录保留）', detail.release_id === null, detail);
    check('已贴 7 张待复核', detail.review_pending === true && detail.applied_qty === 7, detail);
    r = await api('POST', `/api/label-rolls/${roll3Id}/consume`, {
      expected_revision: 2, void_delta: 1
    });
    check('停用卷不可核销 → 409', r.status === 409 && r.json.code === 'LABEL_CONFLICT', r);

    // ---------- 10. 没有效放行时不能登记新卷 ----------
    console.log('10) 放行全失效/删除后无法再登记新卷');
    r = await api('POST', '/api/label-rolls', {
      batch_id: b3.id, release_id: newRel.id,
      allergens: state.batches.find((b) => b.code === 'BATCH-003').allergens, printed_qty: 10
    });
    check('引用已删除放行 → 400', r.status === 400, r);

    // ---------- 11. 整组预演/确认应用：使集合改变时停用，且预演不动正式卷 ----------
    console.log('11) replan 确认应用使集合改变 → 停用卷；预演不影响正式卷');
    // 重新放行 BATCH-003，再登记一卷；用 replan 在 BATCH-002 之前(BATCH-002@10:00 之前，
    // 09:00 清洗之后)插入清洗不改变结果，因此改为更正 BATCH-002 加花生来制造集合变化。
    state = (await api('GET', '/api/state')).json;
    let b3s = state.batches.find((b) => b.code === 'BATCH-003');
    r = await api('POST', '/api/releases', {
      batch_id: b3s.id, released_at: D + '16:20', released_by: '复检员2'
    });
    check('再次登记放行 200', r.status === 200, r);
    state = (await api('GET', '/api/state')).json;
    b3s = state.batches.find((b) => b.code === 'BATCH-003');
    const activeRel = b3s.releases.find((x) => x.status === 'ACTIVE');
    r = await api('POST', '/api/label-rolls', {
      batch_id: b3s.id, release_id: activeRel.id,
      allergens: b3s.allergens, printed_qty: 80
    });
    check('再登记一卷 LR-0004', r.status === 200 && r.json.roll_code === 'LR-0004', r);
    const roll4Id = r.json.id;

    const e2now = state.events.find((e) => e.batch_code === 'BATCH-002');
    const change = {
      op: 'update', event_id: e2now.id, type: 'PROCESS',
      event_time: e2now.event_time, equipment_id: e2now.equipment_id, note: e2now.note || '',
      batch_code: e2now.batch_code,
      material_ids: e2now.inputs.filter((i) => i.material_id).map((i) => i.material_id).concat(peanut),
      ref_batch_ids: e2now.inputs.filter((i) => i.ref_batch_id).map((i) => i.ref_batch_id)
    };
    r = await api('POST', '/api/replan/preview', { changes: [change] });
    check('预演 200', r.status === 200, r);
    const version = r.json.version;
    const relDiff = r.json.diff.releases.find((x) => x.batch_code === 'BATCH-003');
    check('预演差异显示放行将失效',
      relDiff && relDiff.before_status === 'ACTIVE' && relDiff.after_status === 'INVALIDATED', relDiff);
    // 预演不得停用正式卷
    detail = (await api('GET', `/api/label-rolls/${roll4Id}`)).json;
    check('预演后正式卷仍 ACTIVE', detail.status === 'ACTIVE', detail);

    // 预演后的标签登记/核销不影响推导结果，不应使预演版本过期
    r = await api('POST', `/api/label-rolls/${roll4Id}/consume`, {
      expected_revision: 1, applied_delta: 2, void_delta: 0, operated_by: '并发核销'
    });
    check('预演期间核销另一卷成功', r.status === 200, r);

    r = await api('POST', '/api/replan/apply', { version, changes: [change] });
    check('标签核销未使预演版本过期：应用 200', r.status === 200, r);
    check('应用返回停用卷',
      Array.isArray(r.json.deactivated_rolls) &&
      r.json.deactivated_rolls.some((x) => x.id === roll4Id), r.json.deactivated_rolls);
    detail = (await api('GET', `/api/label-rolls/${roll4Id}`)).json;
    check('应用后 LR-0004 已停用', detail.status === 'DEACTIVATED', detail);

    // ---------- 12. 既有事件/放行/预演接口字段语义保持不变 ----------
    console.log('12) 既有接口回归：放行登记/删除仍按原语义工作');
    state = (await api('GET', '/api/state')).json;
    const b3final = state.batches.find((b) => b.code === 'BATCH-003');
    // 批次无加工记录的拒绝（BATCH-005 是清洗后空白验证批，可正常放行/登记）
    r = await api('POST', '/api/label-rolls', {
      batch_id: 999999, release_id: 1, allergens: [], printed_qty: 1
    });
    check('不存在批次 → 400', r.status === 400, r);
    check('state 中每批次都带 label_rolls 数组',
      state.batches.every((b) => Array.isArray(b.label_rolls)), state.batches.map((b) => !!b.label_rolls));

  } finally {
    proc.kill('SIGTERM');
    await sleep(300);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
  }

  if (failures) {
    console.error(`\n失败 ${failures} 项`);
    process.exit(1);
  }
  console.log('\n全部通过');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
