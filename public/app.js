'use strict';

let state = { materials: [], equipment: [], events: [], batches: [] };
let editingEventId = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw data;
  return data;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function fmtTime(t) {
  return t ? t.replace('T', ' ') : '—';
}
function allergenTags(list, emptyText = '无过敏原') {
  if (!list || !list.length) return `<span class="tag none">${esc(emptyText)}</span>`;
  return list.map((a) => `<span class="tag">${esc(a)}</span>`).join('');
}
function pathClass(p) {
  if (p.includes('设备残留')) return 'path-res';
  if (p.includes('批次引用')) return 'path-ref';
  return 'path-raw';
}

function notice(type, title, items) {
  const box = $('#notice');
  box.className = `notice ${type}`;
  const list = Array.isArray(items) && items.length
    ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
    : (items ? `<div>${esc(items)}</div>` : '');
  box.innerHTML = `<span class="close">×</span><b>${esc(title)}</b>${list}`;
  box.querySelector('.close').onclick = () => box.classList.add('hidden');
  clearTimeout(notice._t);
  if (type === 'ok') notice._t = setTimeout(() => box.classList.add('hidden'), 5000);
}

function reportInvalidated(list) {
  if (Array.isArray(list) && list.length) {
    notice('error', `重算后 ${list.length} 条放行记录已失效`,
      list.map((r) => `${r.batch_code}：${r.reason}`));
  }
}

function reportDeactivatedRolls(list) {
  if (Array.isArray(list) && list.length) {
    notice('error', `${list.length} 卷过敏原标签已永久停用（已贴数量待复核，不自动恢复）`,
      list.map((r) => `${r.batch_code ? r.batch_code + '：' : ''}${r.reason}`));
  }
}

// ================= 渲染 =================
async function refresh() {
  state = await api('/api/state');
  renderResidue();
  renderBatches();
  renderEvents();
  renderBase();
}

function renderResidue() {
  $('#residueCards').innerHTML = state.equipment.map((q) => `
    <div class="residue-card">
      <h4>${esc(q.name)} <span class="batch-meta">(${esc(q.code)})</span></h4>
      <div class="residue-meta">最后已核实清洗：${q.last_cleaned_at ? esc(fmtTime(q.last_cleaned_at)) : '无记录'}</div>
      ${q.allergens.length
        ? `<div class="tag-row">${allergenTags(q.allergens, '')}</div>
           <details><summary>查看残留来源路径（${Object.values(q.paths).reduce((n, p) => n + p.length, 0)} 条）</summary>
             ${renderPaths(q.paths)}</details>`
        : '<div class="residue-empty">✓ 当前无残留（已清洗或尚未加工）</div>'}
    </div>`).join('');
}

function renderPaths(paths) {
  const keys = Object.keys(paths);
  if (!keys.length) return '';
  return `<div class="paths">${keys.map((a) => `
    <div class="path-block">
      <span class="allergen-name">${esc(a)}</span>
      <ul class="path-list">
        ${paths[a].map((p) => `<li class="${pathClass(p)}">${esc(p)}</li>`).join('')}
      </ul>
    </div>`).join('')}</div>`;
}

function renderBatches() {
  $('#batchList').innerHTML = state.batches.map((b) => {
    const validRelease = (b.releases || []).find((r) => r.status === 'ACTIVE');
    const invalidReleases = (b.releases || []).filter((r) => r.status === 'INVALIDATED');
    return `
    <div class="batch-card">
      <div class="batch-head">
        <span class="batch-code">${esc(b.code)}</span>
        <span class="batch-meta">产出 ${b.produced_at ? esc(fmtTime(b.produced_at)) : '—'} · 设备 ${esc(b.equipment_code || '—')}</span>
        <span class="spacer"></span>
        ${validRelease
          ? '<span class="badge active">放行有效</span>'
          : (invalidReleases.length ? '<span class="badge invalid">放行已失效</span>' : '<span class="tag none">未放行</span>')}
        <button class="btn small primary" onclick="openRelease(${b.id})">登记放行</button>
      </div>
      <div style="margin-top:8px" class="tag-row">
        <b style="font-size:12.5px;color:var(--muted)">推导过敏原：</b>${allergenTags(b.allergens)}
      </div>
      ${renderPaths(b.paths)}
      <div class="release-box">
        ${(b.releases || []).map((r) => `
          <div class="release-item ${r.status === 'INVALIDATED' ? 'invalid' : ''}">
            <div class="rl-head">
              <span class="badge ${r.status === 'ACTIVE' ? 'active' : 'invalid'}">
                ${r.status === 'ACTIVE' ? '放行有效' : '已失效'}
              </span>
              <span class="muted">${esc(fmtTime(r.released_at))} · ${esc(r.released_by)}</span>
              <span class="spacer"></span>
              <span class="muted">登记时集合：${r.snapshot_allergens.length ? esc(r.snapshot_allergens.join('、')) : '无'}</span>
              <button class="btn small danger" onclick="deleteRelease(${r.id})">删除</button>
            </div>
            ${r.status === 'INVALIDATED' ? `<div class="invalid-reason">⚠ 失效原因：${esc(r.invalid_reason)}</div>` : ''}
          </div>`).join('')}
      </div>
      ${renderLabelRolls(b)}
    </div>`;
  }).join('') || '<div class="batch-meta">尚无批次，请先录入加工事件。</div>';
}

// ---------- 过敏原标签卷（按批次列出每卷印量/贴用/作废/剩余及停用原因） ----------
function renderLabelRolls(b) {
  const rolls = b.label_rolls || [];
  const head = `
    <div class="panel-head roll-head">
      <h3>过敏原标签卷</h3>
      <button class="btn small primary" onclick="openRoll(${b.id})">＋ 登记标签卷</button>
    </div>`;
  if (!rolls.length) {
    return `<div class="roll-box">${head}
      <div class="batch-meta">尚未登记标签卷。包装前请凭该批次的有效放行记录登记。</div>
    </div>`;
  }
  return `<div class="roll-box">${head}
    <div class="roll-list">
      ${rolls.map((r) => `
        <div class="roll-item ${r.status === 'DEACTIVATED' ? 'stopped' : ''}">
          <div class="roll-head-row">
            <span class="roll-code">${esc(r.roll_code)}</span>
            ${r.status === 'ACTIVE'
              ? '<span class="badge active">可用</span>'
              : '<span class="badge invalid">已永久停用</span>'}
            ${r.review_pending ? '<span class="tag warn">已贴数量待复核</span>' : ''}
            <span class="muted">${esc(fmtTime(r.registered_at))} · ${esc(r.registered_by)}</span>
            <span class="spacer"></span>
            ${r.status === 'ACTIVE'
              ? `<button class="btn small primary" onclick="openConsume(${r.id})">核销贴用/作废</button>`
              : ''}
          </div>
          <div class="roll-qty">
            <span>印量 <b>${r.printed_qty}</b></span>
            <span>贴用 <b class="qty-used">${r.applied_qty}</b></span>
            <span>作废 <b class="qty-void">${r.void_qty}</b></span>
            <span>剩余 <b class="${r.available_qty === 0 ? 'qty-zero' : 'qty-avail'}">${r.available_qty}</b></span>
            <span class="muted">当前修订号 ${r.revision}</span>
          </div>
          <div class="tag-row" style="margin-top:6px">
            <span class="batch-meta">拟印集合：</span>${allergenTags(r.allergens, '无过敏原')}
          </div>
          ${r.status === 'DEACTIVATED'
            ? `<div class="invalid-reason">⚠ 停用原因：${esc(r.deactivate_reason || '—')}${r.deactivated_at ? `（${esc(fmtTime(r.deactivated_at))}）` : ''}</div>`
            : ''}
          <details class="roll-ledger" data-roll-id="${r.id}">
            <summary>核销流水</summary>
            <div class="ledger-body"><span class="batch-meta">展开时加载…</span></div>
          </details>
        </div>`).join('')}
    </div>
  </div>`;
}

function renderEvents() {
  $('#eventList').innerHTML = state.events.map((ev) => {
    const eq = state.equipment.find((q) => q.id === ev.equipment_id);
    let body = '';
    if (ev.type === 'PROCESS') {
      const mats = ev.inputs.filter((i) => i.material_id);
      const refs = ev.inputs.filter((i) => i.ref_batch_id);
      body = `
        <div class="event-inputs"><b>产出：</b>${esc(ev.batch_code || '?')}
          ｜推导过敏原：<span class="tag-row" style="display:inline-flex">${allergenTags(ev.out_allergens)}</span>
        </div>
        <div class="event-inputs"><b>原料：</b>${mats.length ? mats.map((m) => `${esc(m.material_name)}(${esc(m.material_code)})`).join('、') : '—'}
          ｜<b>引用批次：</b>${refs.length ? refs.map((r) => esc(r.ref_batch_code)).join('、') : '—'}</div>`;
    } else {
      body = `<div class="event-inputs"><b>已核实清洗：</b>清空设备残留${ev.note ? `｜${esc(ev.note)}` : ''}</div>`;
    }
    return `
    <div class="event-item ${ev.type === 'CLEAN' ? 'clean' : ''}">
      <div class="event-head">
        <span class="event-time">${esc(fmtTime(ev.event_time))}</span>
        <span class="event-type ${ev.type}">${ev.type === 'PROCESS' ? '加工' : '已核实清洗'}</span>
        <span class="batch-meta">${esc(eq ? `${eq.name}(${eq.code})` : '?')}</span>
        ${ev.type === 'PROCESS' && ev.note ? `<span class="batch-meta">${esc(ev.note)}</span>` : ''}
      </div>
      ${body}
      ${ev.type === 'PROCESS' ? renderPaths(ev.out_paths) : ''}
      <div class="event-actions">
        <button class="btn small" onclick="editEvent(${ev.id})">更正</button>
        <button class="btn small danger" onclick="deleteEvent(${ev.id})">删除</button>
      </div>
    </div>`;
  }).join('') || '<div class="batch-meta">尚无事件。</div>';
}

function renderBase() {
  $('#materialRows').innerHTML = state.materials.map((m) => `
    <tr>
      <td>${esc(m.code)}</td>
      <td>${esc(m.name)}</td>
      <td>${allergenTags(m.allergens, '无')}</td>
      <td class="row-actions">
        <button class="btn small" onclick='editMaterial(${JSON.stringify(m).replace(/'/g, '&#39;')})'>编辑</button>
        <button class="btn small danger" onclick="deleteMaterial(${m.id})">删除</button>
      </td>
    </tr>`).join('');

  $('#equipmentRows').innerHTML = state.equipment.map((q) => `
    <tr>
      <td>${esc(q.code)}</td>
      <td>${esc(q.name)}</td>
      <td class="row-actions">
        <button class="btn small" onclick='editEquipment(${JSON.stringify({ id: q.id, code: q.code, name: q.name }).replace(/'/g, '&#39;')})'>编辑</button>
        <button class="btn small danger" onclick="deleteEquipment(${q.id})">删除</button>
      </td>
    </tr>`).join('');
}

// ================= Tabs =================
$$('.tab').forEach((t) => t.addEventListener('click', () => {
  $$('.tab').forEach((x) => x.classList.remove('active'));
  $$('.tab-panel').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  $(`#tab-${t.dataset.tab}`).classList.add('active');
}));

// ================= 事件弹窗 =================
function openEventModal() {
  editingEventId = null;
  $('#eventModalTitle').textContent = '录入事件';
  const form = $('#eventForm');
  form.reset();
  form.event_time.value = new Date().toISOString().slice(0, 16);
  fillEventModalOptions(null);
  $('#processFields').style.display = form.type.value === 'PROCESS' ? 'block' : 'none';
  $('#eventModal').classList.remove('hidden');
}
window.openEventModal = openEventModal;
$('#btnNewEvent').onclick = openEventModal;
$('#btnNewEventTop').onclick = () => {
  $$('.tab').find((x) => x.dataset.tab === 'events').click();
  openEventModal();
};
$('#eventCancel').onclick = () => $('#eventModal').classList.add('hidden');
$('#evType').onchange = (e) => {
  $('#processFields').style.display = e.target.value === 'PROCESS' ? 'block' : 'none';
};
$('#eventForm').addEventListener('input', (e) => {
  if (e.target.name === 'event_time') refreshRefBatchOptions();
});

function fillEventModalOptions(ev) {
  $('#evEquipment').innerHTML = state.equipment
    .map((q) => `<option value="${q.id}" ${ev && ev.equipment_id === q.id ? 'selected' : ''}>${esc(q.name)}（${esc(q.code)}）</option>`)
    .join('');
  $('#evMaterials').innerHTML = state.materials.map((m) => `
    <label><input type="checkbox" name="material_ids" value="${m.id}"
      ${ev && ev.inputs.some((i) => i.material_id === m.id) ? 'checked' : ''}>
      ${esc(m.name)} <span class="batch-meta">[${esc(m.allergens.join('/') || '无过敏原')}]</span></label>`).join('');
  refreshRefBatchOptions(ev);
}

function refreshRefBatchOptions(ev) {
  const t = $('#eventForm').event_time.value;
  const editingBatchId = ev ? ev.batch_id : null;
  // 只列出产出时间严格更早的批次（未来/同时刻由后端强制拒绝）
  const candidates = state.batches.filter((b) => {
    if (b.id === editingBatchId) return false;
    if (ev) {
      // 编辑时已选中的引用即便当前列表时间变化也保留显示
    }
    return b.produced_at && (!t || b.produced_at < t);
  });
  const selected = new Set(ev ? ev.inputs.filter((i) => i.ref_batch_id).map((i) => i.ref_batch_id) : []);
  // 编辑场景下已引用但时间不再满足的批次也显示，由后端报错提示
  if (ev) {
    for (const b of state.batches) {
      if (selected.has(b.id) && !candidates.includes(b)) candidates.push(b);
    }
  }
  $('#evBatches').innerHTML = candidates.length ? candidates.map((b) => `
    <label><input type="checkbox" name="ref_batch_ids" value="${b.id}" ${selected.has(b.id) ? 'checked' : ''}>
      ${esc(b.code)} <span class="batch-meta">(${esc(fmtTime(b.produced_at))})</span></label>`).join('')
    : '<small class="hint">所选时间之前没有可引用的批次</small>';
}

window.editEvent = function (id) {
  const ev = state.events.find((x) => x.id === id);
  if (!ev) return;
  editingEventId = id;
  $('#eventModalTitle').textContent = `更正事件 #${id}（${ev.type === 'PROCESS' ? '加工' : '已核实清洗'}）`;
  const form = $('#eventForm');
  form.type.value = ev.type;
  form.event_time.value = ev.event_time.length === 16 ? ev.event_time : ev.event_time.slice(0, 16);
  form.note.value = ev.note || '';
  form.batch_code.value = ev.batch_code || '';
  $('#processFields').style.display = ev.type === 'PROCESS' ? 'block' : 'none';
  fillEventModalOptions(ev);
  $('#eventModal').classList.remove('hidden');
};

$('#eventForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    event_time: f.event_time.value,
    type: f.type.value,
    equipment_id: parseInt(f.equipment_id.value, 10),
    note: f.note.value,
    batch_code: f.batch_code.value,
    material_ids: $$('#evMaterials input:checked').map((x) => parseInt(x.value, 10)),
    ref_batch_ids: $$('#evBatches input:checked').map((x) => parseInt(x.value, 10))
  };
  try {
    let r;
    if (editingEventId) {
      r = await api(`/api/events/${editingEventId}`, { method: 'PUT', body });
      notice('ok', '事件已更正，受影响批次与设备残留已重算');
    } else {
      r = await api('/api/events', { method: 'POST', body });
      notice('ok', '事件已录入并完成推导');
    }
    $('#eventModal').classList.add('hidden');
    await refresh();
    if (r.invalidated && r.invalidated.length) reportInvalidated(r.invalidated);
    if (r.deactivated_rolls && r.deactivated_rolls.length) reportDeactivatedRolls(r.deactivated_rolls);
  } catch (err) {
    notice('error', err.error || '提交失败', err.details);
  }
};

window.deleteEvent = async function (id) {
  if (!confirm('确定删除该事件？加工事件会同时删除其产出批次（整次提交仍会完整校验，失败则回滚）。')) return;
  try {
    const r = await api(`/api/events/${id}`, { method: 'DELETE' });
    await refresh();
    notice('ok', '事件已删除并重算');
    reportInvalidated(r.invalidated);
    reportDeactivatedRolls(r.deactivated_rolls);
  } catch (err) { notice('error', err.error || '删除失败', err.details); }
};

// ================= 原料 / 设备弹窗 =================
$('#btnNewMaterial').onclick = () => {
  const f = $('#materialForm');
  f.reset(); f.id.value = '';
  $('#materialModalTitle').textContent = '新增原料';
  $('#materialModal').classList.remove('hidden');
};
window.editMaterial = (m) => {
  const f = $('#materialForm');
  f.id.value = m.id; f.code.value = m.code; f.name.value = m.name;
  f.allergens.value = m.allergens.join(',');
  $('#materialModalTitle').textContent = '编辑原料';
  $('#materialModal').classList.remove('hidden');
};
$('#materialForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    code: f.code.value, name: f.name.value,
    allergens: f.allergens.value.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean)
  };
  try {
    if (f.id.value) {
      const r = await api(`/api/materials/${f.id.value}`, { method: 'PUT', body });
      await refresh();
      notice('ok', '原料已更新并重算');
      reportInvalidated(r.invalidated);
      reportDeactivatedRolls(r.deactivated_rolls);
    } else {
      await api('/api/materials', { method: 'POST', body });
      await refresh();
      notice('ok', '原料已新增');
    }
    $('#materialModal').classList.add('hidden');
  } catch (err) { notice('error', err.error || '保存失败', err.details); }
};
window.deleteMaterial = async (id) => {
  if (!confirm('删除该原料？已被事件引用的原料不允许删除。')) return;
  try { await api(`/api/materials/${id}`, { method: 'DELETE' }); await refresh(); }
  catch (err) { notice('error', err.error || '删除失败', err.details); }
};

$('#btnNewEquipment').onclick = () => {
  const f = $('#equipmentForm');
  f.reset(); f.id.value = '';
  $('#equipmentModalTitle').textContent = '新增设备';
  $('#equipmentModal').classList.remove('hidden');
};
window.editEquipment = (q) => {
  const f = $('#equipmentForm');
  f.id.value = q.id; f.code.value = q.code; f.name.value = q.name;
  $('#equipmentModalTitle').textContent = '编辑设备';
  $('#equipmentModal').classList.remove('hidden');
};
$('#equipmentForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { code: f.code.value, name: f.name.value };
  try {
    if (f.id.value) await api(`/api/equipment/${f.id.value}`, { method: 'PUT', body });
    else await api('/api/equipment', { method: 'POST', body });
    $('#equipmentModal').classList.add('hidden');
    await refresh();
  } catch (err) { notice('error', err.error || '保存失败', err.details); }
};
window.deleteEquipment = async (id) => {
  if (!confirm('删除该设备？其下仍有事件时不允许删除。')) return;
  try { await api(`/api/equipment/${id}`, { method: 'DELETE' }); await refresh(); }
  catch (err) { notice('error', err.error || '删除失败', err.details); }
};

$$('[data-close]').forEach((b) => b.onclick = (e) => e.target.closest('.modal').classList.add('hidden'));

// ================= 放行 =================
window.openRelease = function (batchId) {
  const b = state.batches.find((x) => x.id === batchId);
  if (!b) return;
  const f = $('#releaseForm');
  f.batch_id.value = b.id;
  f.batch_code.value = b.code;
  f.released_at.value = new Date().toISOString().slice(0, 16);
  f.released_by.value = '';
  $('#releaseAllergens').innerHTML = allergenTags(b.allergens);
  $('#releaseModal').classList.remove('hidden');
};
$('#releaseForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/api/releases', {
      method: 'POST',
      body: {
        batch_id: parseInt(f.batch_id.value, 10),
        released_at: f.released_at.value,
        released_by: f.released_by.value
      }
    });
    $('#releaseModal').classList.add('hidden');
    await refresh();
    notice('ok', '放行已按当时推导结果登记');
  } catch (err) { notice('error', err.error || '登记失败', err.details); }
};
window.deleteRelease = async (id) => {
  if (!confirm('删除该放行记录？绑定它的有效过敏原标签卷将被永久停用（已贴数量待复核，不自动恢复）。')) return;
  try {
    const r = await api(`/api/releases/${id}`, { method: 'DELETE' });
    await refresh();
    notice('ok', '放行记录已删除');
    reportDeactivatedRolls(r.deactivated_rolls);
  } catch (err) { notice('error', err.error || '删除失败', err.details); }
};

// ================= 过敏原标签卷 =================
window.openRoll = function (batchId) {
  const b = state.batches.find((x) => x.id === batchId);
  if (!b) return;
  const activeReleases = (b.releases || []).filter((r) => r.status === 'ACTIVE');
  if (!activeReleases.length) {
    notice('error', '该批次没有有效放行记录', '标签卷只能凭有效放行快照登记；请先登记放行。');
    return;
  }
  const f = $('#rollForm');
  f.reset();
  f.batch_id.value = b.id;
  f.batch_code.value = b.code;
  f.printed_qty.value = '';
  $('#rollCurrentAllergens').innerHTML = allergenTags(b.allergens);
  $('#rollRelease').innerHTML = activeReleases.map((r, i) =>
    `<option value="${r.id}"${i === 0 ? ' selected' : ''}>放行 #${r.id} · ${esc(fmtTime(r.released_at))} · ${esc(r.released_by)}（快照：${esc(r.snapshot_allergens.join('、') || '无过敏原')}）</option>`
  ).join('');
  // 拟印集合候选项：当前批次过敏原（默认全选）+ 全部已知过敏原名称；服务端强制三重一致
  const known = [...new Set(state.materials.flatMap((m) => m.allergens))];
  $('#rollAllergens').innerHTML = [...new Set(b.allergens.concat(known))].map((a) => `
    <label><input type="checkbox" name="allergens" value="${esc(a)}"
      ${b.allergens.includes(a) ? 'checked' : ''}> ${esc(a)}</label>`).join('');
  $('#rollModal').classList.remove('hidden');
};

$('#rollForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const r = await api('/api/label-rolls', {
      method: 'POST',
      body: {
        batch_id: parseInt(f.batch_id.value, 10),
        release_id: parseInt(f.release_id.value, 10),
        allergens: $$('#rollAllergens input:checked').map((x) => x.value),
        printed_qty: parseInt(f.printed_qty.value, 10),
        registered_by: f.registered_by.value
      }
    });
    $('#rollModal').classList.add('hidden');
    await refresh();
    notice('ok', `标签卷 ${r.roll_code} 已登记`, `可用张数 ${r.available_qty}（印量 ${r.printed_qty}），当前修订号 ${r.revision}`);
  } catch (err) { notice('error', err.error || '登记失败', err.details); }
};

window.openConsume = async function (rollId) {
  const f = $('#consumeForm');
  f.reset();
  let roll;
  try {
    roll = await api(`/api/label-rolls/${rollId}`);
  } catch (err) { notice('error', err.error || '加载失败', err.details); return; }
  f.roll_id.value = roll.id;
  f.roll_code.value = roll.roll_code;
  f.expected_revision.value = roll.revision;
  $('#consumeSummary').innerHTML =
    `<span>印量 <b>${roll.printed_qty}</b></span>
     <span>已贴 <b>${roll.applied_qty}</b></span>
     <span>已作废 <b>${roll.void_qty}</b></span>
     <span>可用 <b class="qty-avail">${roll.available_qty}</b></span>`;
  $('#consumeModal').classList.remove('hidden');
};

$('#consumeForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const r = await api(`/api/label-rolls/${parseInt(f.roll_id.value, 10)}/consume`, {
      method: 'POST',
      body: {
        expected_revision: parseInt(f.expected_revision.value, 10),
        applied_delta: parseInt(f.applied_delta.value || '0', 10),
        void_delta: parseInt(f.void_delta.value || '0', 10),
        operated_by: f.operated_by.value,
        note: f.note.value
      }
    });
    $('#consumeModal').classList.add('hidden');
    await refresh();
    notice('ok', `${r.roll_code} 核销成功`, `已贴 ${r.applied_qty} · 已作废 ${r.void_qty} · 剩余 ${r.available_qty} · 新修订号 ${r.revision}`);
  } catch (err) { notice('error', err.error || '核销被拒绝', err.details); }
};

// 核销流水懒加载（事件委托，refresh 后仍有效）
document.addEventListener('toggle', (e) => {
  const el = e.target;
  if (!el || !el.classList || !el.classList.contains('roll-ledger') || !el.open) return;
  const body = el.querySelector('.ledger-body');
  if (!body || body.dataset.loaded) return;
  body.dataset.loaded = '1';
  api(`/api/label-rolls/${el.dataset.rollId}`).then((r) => {
    if (!r.ledger || !r.ledger.length) {
      body.innerHTML = '<span class="batch-meta">暂无核销记录</span>';
      return;
    }
    body.innerHTML = `<table class="grid ledger-table">
      <thead><tr><th>时间</th><th>贴用</th><th>作废</th><th>核销后修订号</th><th>操作人</th><th>备注</th></tr></thead>
      <tbody>${r.ledger.map((g) => `
        <tr><td>${esc(fmtTime(g.created_at))}</td><td>${g.applied_delta}</td><td>${g.void_delta}</td>
        <td>${g.revision_after}</td><td>${esc(g.operated_by)}</td><td>${esc(g.note)}</td></tr>`).join('')}
      </tbody></table>`;
  }).catch((err) => { body.dataset.loaded = ''; notice('error', '流水加载失败', err.error); });
}, true);

// ================= 启动 =================
refresh().catch((err) => notice('error', '加载状态失败', err.message || String(err)));
