'use strict';
// 过敏原标签卷：包装前按“现有批次 + 有效放行记录”登记一卷拟印标签，
// 登记后按“预期修订号”逐笔核销贴用/作废；集合改变或绑定放行失效/删除时永久停用。
//
//   POST /api/label-rolls              登记一卷（拟印集合须与当前批次推导结果
//                                      及所选有效放行快照完全一致，否则整次拒绝）
//   POST /api/label-rolls/:id/consume  核销贴用/作废（凭 expected_revision，
//                                      旧修订号/负数/超量整次拒绝）
//   GET  /api/label-rolls/:id          卷详情（含核销流水）
//
// 停用（终态，不自动恢复）统一由 recompute() 在重算后核对：
//   - 原料或加工事件变更（含换线整组确认应用）使批次集合与拟印集合不一致；
//   - 绑定的放行记录失效；
// 放行记录删除时由删除接口在同一事务内停用。

const { sortedJson, nowLocal } = require('./recompute');

class LabelError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'LabelError';
    this.code = code; // LABEL_REJECTED(400) / LABEL_CONFLICT(409) / LABEL_NOT_FOUND(404)
    this.details = details || [];
  }
}

function normalizeAllergenSet(raw) {
  if (!Array.isArray(raw)) throw new LabelError('LABEL_REJECTED', 'allergens 必须是字符串数组');
  return [...new Set(raw.map((a) => String(a).trim()).filter(Boolean))];
}

// 正整数：拒绝缺省、小数、负数与非数字；接受数字或数字字符串。
function positiveInt(v, field) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v.trim()) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) {
    throw new LabelError('LABEL_REJECTED', `${field}必须为正整数`);
  }
  return n;
}
function nonNegInt(v, field) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v.trim()) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) {
    throw new LabelError('LABEL_REJECTED', `${field}必须为非负整数`);
  }
  return n;
}

const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

// 严格正整数 id：拒绝缺省、小数、带杂字符（parseInt('2x') 之类）。
function parseId(v, msg) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v.trim()) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) {
    throw new LabelError('LABEL_REJECTED', msg);
  }
  return n;
}

// ---------- 登记一卷 ----------
// body: { batch_id, release_id, allergens:[...], printed_qty, registered_by?, registered_at? }
function register(db, body) {
  body = body || {};
  const batch_id = parseId(body.batch_id, '请选择批次');
  const release_id = parseId(body.release_id, '请选择一条有效放行记录');
  const printed_qty = positiveInt(body.printed_qty, '印量');
  const allergens = normalizeAllergenSet(body.allergens);
  const registered_by = String(body.registered_by || '').trim() || '未署名';
  const registered_at = body.registered_at ? String(body.registered_at).trim() : nowLocal();
  if (!TIME_RE.test(registered_at)) {
    throw new LabelError('LABEL_REJECTED', '登记时间格式应为 YYYY-MM-DDTHH:MM');
  }

  let response;
  const tx = db.transaction(() => {
    const batch = db.prepare(
      `SELECT b.id, b.code, bo.allergens
         FROM batches b
         LEFT JOIN batch_outputs bo ON bo.batch_id = b.id
        WHERE b.id = ?`
    ).get(batch_id);
    if (!batch) throw new LabelError('LABEL_REJECTED', '批次不存在');
    if (batch.allergens == null) {
      throw new LabelError('LABEL_REJECTED', '该批次尚无加工/推导结果，无法登记过敏原标签卷');
    }

    const rel = db.prepare(
      'SELECT id, batch_id, status, snapshot_allergens FROM releases WHERE id = ?'
    ).get(release_id);
    if (!rel) throw new LabelError('LABEL_REJECTED', '所选放行记录不存在');
    if (rel.batch_id !== batch_id) {
      throw new LabelError('LABEL_REJECTED', '所选放行记录不属于该批次');
    }
    if (rel.status !== 'ACTIVE') {
      throw new LabelError('LABEL_REJECTED', '所选放行记录已失效，请先以当前推导结果重新登记放行');
    }

    const wantJson = sortedJson(allergens);
    const batchJson = sortedJson(JSON.parse(batch.allergens));
    const releaseJson = sortedJson(JSON.parse(rel.snapshot_allergens));
    if (wantJson !== batchJson) {
      throw new LabelError('LABEL_REJECTED', '拟印过敏原集合与当前批次推导结果不一致，整次拒绝',
        mismatchDetails(allergens, JSON.parse(batchJson), '当前批次推导结果'));
    }
    if (wantJson !== releaseJson) {
      throw new LabelError('LABEL_REJECTED', '拟印过敏原集合与所选放行快照不一致，整次拒绝',
        mismatchDetails(allergens, JSON.parse(releaseJson), '所选放行快照'));
    }

    const seq = 1 + (db.prepare('SELECT COUNT(*) AS c FROM label_rolls').get().c);
    const roll_code = `LR-${String(seq).padStart(4, '0')}`;
    const info = db.prepare(
      `INSERT INTO label_rolls
         (roll_code, batch_id, release_id, allergens, printed_qty,
          used_qty, void_qty, status, review_pending, revision,
          registered_at, registered_by)
       VALUES (?,?,?,?,?,0,0,'ACTIVE',0,1,?,?)`
    ).run(roll_code, batch_id, release_id, wantJson, printed_qty,
          registered_at, registered_by);

    response = {
      ok: true,
      id: info.lastInsertRowid,
      roll_code,
      batch_id,
      release_id,
      allergens: JSON.parse(wantJson),
      printed_qty,
      applied_qty: 0,
      void_qty: 0,
      available_qty: printed_qty,
      revision: 1,
      status: 'ACTIVE',
      registered_at,
      registered_by
    };
  });
  tx();
  return response;
}

function mismatchDetails(want, actual, label) {
  const missing = actual.filter((a) => !want.includes(a));
  const extra = want.filter((a) => !actual.includes(a));
  const parts = [];
  if (missing.length) parts.push(`${label}中缺少：${missing.join('、')}`);
  if (extra.length) parts.push(`拟印集合多出：${extra.join('、')}`);
  return parts.length ? parts : [`拟印集合与${label}不一致`];
}

// ---------- 核销贴用 / 作废 ----------
// body: { expected_revision, applied_delta?, void_delta?, operated_by?, note? }
// 整次事务化：旧修订号(409)、负数(400)、累计超量(400) 全部整次拒绝，不写入流水。
function consume(db, rollId, body) {
  body = body || {};
  const expected_revision = parseInt(body.expected_revision, 10);
  if (!Number.isInteger(expected_revision) || expected_revision <= 0) {
    throw new LabelError('LABEL_REJECTED', 'expected_revision 必须为正整数（请携带该卷当前修订号）');
  }
  // 停用优先判定：已停用卷即使不填张数也一律按“停用冲突”拒绝（余量不可再贴）。
  const pre = db.prepare("SELECT status, deactivate_reason FROM label_rolls WHERE id = ?").get(rollId);
  if (!pre) throw new LabelError('LABEL_NOT_FOUND', '标签卷不存在');
  if (pre.status !== 'ACTIVE') {
    throw new LabelError('LABEL_CONFLICT',
      `该卷已永久停用（${pre.deactivate_reason || '见停用原因'}），余量不可再贴；已贴数量待复核`,
      [pre.deactivate_reason].filter(Boolean));
  }
  const applied_delta = body.applied_delta === undefined ? 0 : nonNegInt(body.applied_delta, '贴用张数');
  const void_delta = body.void_delta === undefined ? 0 : nonNegInt(body.void_delta, '作废张数');
  if (applied_delta === 0 && void_delta === 0) {
    throw new LabelError('LABEL_REJECTED', '贴用张数与作废张数不能同时为 0');
  }
  const operated_by = String(body.operated_by || '').trim() || '未署名';
  const note = String(body.note || '').trim();

  let response;
  const tx = db.transaction(() => {
    const roll = db.prepare('SELECT * FROM label_rolls WHERE id = ?').get(rollId);
    if (roll.status !== 'ACTIVE') {
      throw new LabelError('LABEL_CONFLICT',
        `该卷已永久停用（${roll.deactivate_reason || '见停用原因'}），余量不可再贴；已贴数量待复核`,
        [roll.deactivate_reason].filter(Boolean));
    }
    if (roll.revision !== expected_revision) {
      throw new LabelError('LABEL_CONFLICT',
        `修订号已过期：该卷当前修订号为 ${roll.revision}，提交的预期修订号为 ${expected_revision}；整次拒绝`);
    }
    const usedNext = roll.used_qty + applied_delta;
    const voidNext = roll.void_qty + void_delta;
    if (usedNext + voidNext > roll.printed_qty) {
      const remain = roll.printed_qty - roll.used_qty - roll.void_qty;
      throw new LabelError('LABEL_REJECTED',
        `本次核销累计将超过印量（印量 ${roll.printed_qty}，已贴 ${roll.used_qty}，` +
        `已作废 ${roll.void_qty}，当前可用 ${remain}，本次申请贴用 ${applied_delta} / 作废 ${void_delta}）；整次拒绝`);
    }
    const revision_after = roll.revision + 1;
    const created_at = nowLocal();
    db.prepare(
      `UPDATE label_rolls
          SET used_qty = ?, void_qty = ?, revision = ?
        WHERE id = ?`
    ).run(usedNext, voidNext, revision_after, roll.id);
    db.prepare(
      `INSERT INTO label_roll_ledger
         (roll_id, applied_delta, void_delta, revision_after, operated_by, note, created_at)
       VALUES (?,?,?,?,?,?,?)`
    ).run(roll.id, applied_delta, void_delta, revision_after, operated_by, note, created_at);

    response = {
      ok: true,
      id: roll.id,
      roll_code: roll.roll_code,
      revision: revision_after,
      applied_qty: usedNext,
      void_qty: voidNext,
      available_qty: roll.printed_qty - usedNext - voidNext,
      status: 'ACTIVE'
    };
  });
  tx();
  return response;
}

// ---------- 卷详情（含逐笔核销流水） ----------
function detail(db, rollId) {
  const roll = db.prepare(
    `SELECT lr.*, b.code AS batch_code
       FROM label_rolls lr JOIN batches b ON b.id = lr.batch_id
      WHERE lr.id = ?`
  ).get(rollId);
  if (!roll) throw new LabelError('LABEL_NOT_FOUND', '标签卷不存在');
  const ledger = db.prepare(
    `SELECT id, applied_delta, void_delta, revision_after, operated_by, note, created_at
       FROM label_roll_ledger WHERE roll_id = ? ORDER BY id`
  ).all(rollId);
  return formatRoll(roll, ledger);
}

function formatRoll(roll, ledger) {
  const allergens = JSON.parse(roll.allergens || '[]');
  return {
    id: roll.id,
    roll_code: roll.roll_code,
    batch_id: roll.batch_id,
    batch_code: roll.batch_code,
    release_id: roll.release_id,
    allergens,
    printed_qty: roll.printed_qty,
    applied_qty: roll.used_qty,
    void_qty: roll.void_qty,
    available_qty: roll.printed_qty - roll.used_qty - roll.void_qty,
    status: roll.status,
    review_pending: !!roll.review_pending,
    revision: roll.revision,
    registered_at: roll.registered_at,
    registered_by: roll.registered_by,
    deactivated_at: roll.deactivated_at,
    deactivate_reason: roll.deactivate_reason,
    ledger: ledger || []
  };
}

module.exports = { LabelError, register, consume, detail, formatRoll };
