// js/survey.js — Encuesta pública · Cantera RM
import { db } from "./firebase-init.js";
import {
  doc, getDoc, addDoc, collection, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let surveyData  = null;
let surveyId    = null;
let scaleLabels = ['Muy bajo','Bajo','Correcto','Bueno','Excelente'];

// Exponer answers y highlights globalmente para oninput/onchange inline
window.answers    = {};
window.highlights = {};  // { "aIdx_qIdx": "texto marcado" }
const answers = window.answers;

const show = id => document.getElementById(id).style.display = '';
const hide = id => document.getElementById(id).style.display = 'none';

function showView(name) {
  ['viewLoading','viewInvalid','viewSurvey','viewReview','viewSent'].forEach(v => hide(v));
  show(name);
}
function showInvalid(msg) {
  document.getElementById('invalidMsg').textContent = msg;
  showView('viewInvalid');
}

// ── Cookie ────────────────────────────────────────────────
function setCookie(name, value, days) {
  const d = new Date();
  d.setTime(d.getTime() + days*24*60*60*1000);
  document.cookie = `${name}=${value};expires=${d.toUTCString()};path=/;SameSite=Strict`;
}
function getCookie(name) {
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return match ? match[2] : null;
}

// ── INIT ──────────────────────────────────────────────────
(async function init() {
  const params = new URLSearchParams(window.location.search);
  surveyId     = params.get('survey');

  if (!surveyId) {
    showInvalid("No se ha proporcionado ningún enlace de encuesta válido.");
    return;
  }

  const isPreview = params.get('preview') === '1';

  try {
    const surveySnap = await getDoc(doc(db, "survey", surveyId));
    if (!surveySnap.exists()) { showInvalid("Esta encuesta no existe."); return; }

    surveyData = { id: surveySnap.id, ...surveySnap.data() };

    if (surveyData.active === false) {
      showInvalid("Esta encuesta no está disponible actualmente.");
      return;
    }

    // Comprobar cookie solo si limitOnePerDevice está activo
    if (!isPreview && surveyData.limitOnePerDevice === true) {
      const cookieKey = `survey_done_${surveyId}`;
      if (getCookie(cookieKey)) {
        showInvalid("Ya has completado esta encuesta en este dispositivo.");
        return;
      }
    }

    if (surveyData.scaleLabels?.length === 5) scaleLabels = surveyData.scaleLabels;

    renderSurvey();
    showView('viewSurvey');
    show('progressWrap');
    updateProgress();

  } catch (err) {
    console.error(err);
    showInvalid("Error al cargar la encuesta. Inténtalo de nuevo.");
  }
})();

// ── Renderizar input por tipo ─────────────────────────────
function renderQuestionInput(qn, aIdx, qIdx) {
  const key = `${aIdx}_${qIdx}`;
  switch(qn.type) {
    case 'scale':
      return `<div class="rating-group" data-aspect="${aIdx}" data-question="${qIdx}">
        ${[1,2,3,4,5].map(n => `<button class="rating-btn" data-val="${n}" title="${n} · ${scaleLabels[n-1]}">${n}</button>`).join('')}
      </div>`;
    case 'text':
      return `<div class="text-answer-wrap" data-key="${key}">
        <textarea class="comment-input" data-text-answer="${key}"
          placeholder="Escribe tu respuesta…" rows="3"
          oninput="window.answers['${key}']=this.value.trim()||this.value;updateTextPreview('${key}')"></textarea>
        <div class="text-preview" id="preview_${key}" style="display:none"></div>
        <div class="highlight-toolbar" id="toolbar_${key}" style="display:none">
          <span class="highlight-toolbar-label">Selección:</span>
          <span class="highlight-selection-text" id="sel_${key}"></span>
          <button class="btn-highlight" onclick="applyHighlight('${key}')">⭐ Marcar</button>
          <button class="btn-highlight-remove" onclick="removeHighlight('${key}')">✕ Quitar</button>
        </div>
        <div class="highlight-current" id="marked_${key}" style="display:none">
          <span style="font-size:11px;color:var(--text-mut)">Marcado: </span>
          <span class="highlight-badge" id="markedbadge_${key}"></span>
          <button class="btn-highlight-remove" onclick="removeHighlight('${key}')" style="margin-left:6px">✕</button>
        </div>
      </div>`;
    case 'yesno':
      return `<div class="rating-group yesno-group">
        <button class="rating-btn yesno-btn" data-key="${key}" data-val="Sí" onclick="selectYesNo(this,'${key}')">Sí</button>
        <button class="rating-btn yesno-btn" data-key="${key}" data-val="No" onclick="selectYesNo(this,'${key}')">No</button>
      </div>`;
    case 'radio':
      return `<div class="options-group" data-key="${key}">
        ${(qn.options||[]).map(opt => `
          <label class="option-label">
            <input type="radio" name="q_${key}" value="${opt}"
              onchange="window.answers['${key}']=this.value;updateProgress()">
            <span>${opt}</span>
          </label>`).join('')}
      </div>`;
    case 'checkbox':
      return `<div class="options-group" data-key="${key}">
        ${(qn.options||[]).map(opt => `
          <label class="option-label">
            <input type="checkbox" value="${opt}"
              onchange="updateCheckbox('${key}',this)">
            <span>${opt}</span>
          </label>`).join('')}
      </div>`;
    case 'select':
      return `<select class="form-select-survey"
        onchange="window.answers['${key}']=this.value;updateProgress()">
        <option value="">Selecciona una opción…</option>
        ${(qn.options||[]).map(opt => `<option value="${opt}">${opt}</option>`).join('')}
      </select>`;
    case 'groups':
      return renderGroupsInput(key);

    default:
      return `<div class="rating-group" data-aspect="${aIdx}" data-question="${qIdx}">
        ${[1,2,3,4,5].map(n => `<button class="rating-btn" data-val="${n}">${n}</button>`).join('')}
      </div>`;
  }
}

// ── TIPO GRUPOS ───────────────────────────────────────────
function renderGroupsInput(key) {
  // Si ya hay datos guardados, restaurar directamente
  const saved = window.answers[key];
  if (saved && saved.groups) {
    return renderGroupsFromData(key, saved);
  }
  return `
    <div class="groups-wrap" id="gw_${key}">
      <div class="groups-step" id="gstep1_${key}">
        <div class="groups-row">
          <label class="groups-label">Total de personas</label>
          <input class="form-input groups-num-input" id="gtotal_${key}" type="number" min="1" max="100"
            placeholder="ej: 10" style="width:90px;height:36px">
        </div>
        <div class="groups-row" style="margin-top:8px">
          <label class="groups-label">Distribución</label>
          <input class="form-input groups-dist-input" id="gdist_${key}"
            placeholder="ej: 5+5 o 4+3+3" style="flex:1;height:36px"
            oninput="validateGroupDist('${key}')">
        </div>
        <div class="groups-error" id="gerr_${key}" style="display:none"></div>
        <button class="btn-primary" style="margin-top:10px;height:36px" onclick="generateGroups('${key}')">
          Generar grupos
        </button>
      </div>
      <div id="ggroups_${key}"></div>
    </div>`;
}

function renderGroupsFromData(key, data) {
  const groupsHtml = data.groups.map((g, gi) => `
    <div class="group-card">
      <div class="group-header">Grupo ${gi + 1} <span style="font-size:11px;color:var(--text-mut)">(${g.members.length + 1} personas)</span></div>
      <div class="group-member group-responsible">
        <span class="group-resp-badge">Responsable</span>
        <input class="form-input group-name-input" type="text"
          placeholder="Nombre responsable"
          value="${(g.responsible||'').replace(/"/g,'&quot;')}"
          oninput="updateGroupMember('${key}',${gi},'responsible',this.value)">
      </div>
      ${g.members.map((m, mi) => `
        <div class="group-member">
          <span class="group-member-num">${mi + 2}</span>
          <input class="form-input group-name-input" type="text"
            placeholder="Nombre ${mi + 2}"
            value="${(m||'').replace(/"/g,'&quot;')}"
            oninput="updateGroupMember('${key}',${gi},'member',this.value,${mi})">
        </div>`).join('')}
    </div>`).join('');

  return `
    <div class="groups-wrap" id="gw_${key}">
      <div class="groups-meta">
        <span class="groups-meta-text">Total: <strong>${data.total}</strong> · Distribución: <strong>${data.distribution.join('+')} </strong></span>
        <button class="btn-highlight-remove" onclick="resetGroups('${key}')">Reconfigurar</button>
      </div>
      <div id="ggroups_${key}" class="groups-grid">${groupsHtml}</div>
    </div>`;
}

// Distribuir automáticamente
window.autoDistribute = function(key) {
  const total = parseInt(document.getElementById(`gtotal_${key}`)?.value);
  if (!total || total < 1) { alert('Introduce primero el total de personas.'); return; }
  const distInput = document.getElementById(`gdist_${key}`);
  if (!distInput) return;
  // Pedir número de grupos si distribución vacía
  const existing = distInput.value.trim();
  if (!existing) {
    const ng = parseInt(prompt('¿En cuántos grupos?', '2'));
    if (!ng || ng < 1) return;
    const base = Math.floor(total / ng);
    const rem  = total % ng;
    const dist = Array.from({length: ng}, (_, i) => i < rem ? base + 1 : base);
    distInput.value = dist.join('+');
  } else {
    // Re-balancear con el mismo número de grupos
    const parts = existing.split('+').filter(Boolean);
    const ng = parts.length || 2;
    const base = Math.floor(total / ng);
    const rem  = total % ng;
    const dist = Array.from({length: ng}, (_, i) => i < rem ? base + 1 : base);
    distInput.value = dist.join('+');
  }
  validateGroupDist(key);
};

// Validar distribución
window.validateGroupDist = function(key) {
  const total   = parseInt(document.getElementById(`gtotal_${key}`)?.value) || 0;
  const distStr = document.getElementById(`gdist_${key}`)?.value?.trim() || '';
  const errEl   = document.getElementById(`gerr_${key}`);
  if (!errEl) return false;
  if (!distStr) { errEl.style.display = 'none'; return false; }
  const parts = distStr.split('+').map(v => parseInt(v.trim())).filter(v => !isNaN(v) && v > 0);
  const sum   = parts.reduce((a,b) => a+b, 0);
  if (sum !== total) {
    errEl.textContent = `❌ La suma (${sum}) no coincide con el total (${total})`;
    errEl.style.display = 'block';
    errEl.style.color = 'var(--red)';
    return false;
  }
  errEl.textContent = `✅ Correcto: ${parts.join(' + ')} = ${sum}`;
  errEl.style.display = 'block';
  errEl.style.color = 'var(--green)';
  return true;
};

// Generar grupos
window.generateGroups = function(key) {
  const total   = parseInt(document.getElementById(`gtotal_${key}`)?.value);
  const distStr = document.getElementById(`gdist_${key}`)?.value?.trim() || '';
  if (!total) { alert('Introduce el total de personas.'); return; }
  if (!distStr) { autoDistribute(key); return; }
  if (!validateGroupDist(key)) return;

  const dist = distStr.split('+').map(v => parseInt(v.trim())).filter(v => !isNaN(v) && v > 0);
  const data = {
    total,
    distribution: dist,
    groups: dist.map(size => ({
      responsible: '',
      members: Array(size - 1).fill('')
    }))
  };
  window.answers[key] = data;
  updateProgress();

  // Re-render el wrap completo
  const wrap = document.getElementById(`gw_${key}`);
  if (wrap) wrap.outerHTML = renderGroupsFromData(key, data).replace(
    `id="gw_${key}"`,
    `id="gw_${key}"`
  );
  // Reemplazar el contenedor padre
  const parent = document.querySelector(`[data-key-groups="${key}"]`);
  if (parent) parent.innerHTML = renderGroupsFromData(key, data);
};

// Actualizar miembro del grupo
window.updateGroupMember = function(key, gi, role, value, mi) {
  const data = window.answers[key];
  if (!data || !data.groups) return;
  if (role === 'responsible') {
    data.groups[gi].responsible = value;
  } else {
    data.groups[gi].members[mi] = value;
  }
  window.answers[key] = data;
};

// Reconfigurar grupos
window.resetGroups = function(key) {
  if (!confirm('¿Reconfigurar los grupos? Se perderán los nombres introducidos.')) return;
  delete window.answers[key];
  updateProgress();
  const wrap = document.getElementById(`gw_${key}`);
  if (wrap) wrap.outerHTML = `<div class="groups-wrap" id="gw_${key}">${renderGroupsInput(key).replace('<div class="groups-wrap" id="gw_' + key + '">', '').slice(0,-6)}</div>`;
  // Simplest: re-render the question row
  const parent = wrap?.closest('.question-row');
  if (parent) {
    const label = parent.querySelector('.question-label')?.outerHTML || '';
    parent.innerHTML = label + renderGroupsInput(key);
  }
};

window.selectYesNo = function(btn, key) {
  btn.closest('.yesno-group').querySelectorAll('.yesno-btn').forEach(b => b.className = 'rating-btn yesno-btn');
  btn.classList.add('selected-5');
  window.answers[key] = btn.dataset.val;
  updateProgress();
};

window.updateCheckbox = function(key, input) {
  const checked = Array.from(input.closest('.options-group').querySelectorAll('input:checked')).map(i => i.value);
  window.answers[key] = checked.length ? checked.join(', ') : null;
  updateProgress();
};

// ── Renderizar encuesta ───────────────────────────────────
function renderSurvey() {
  document.getElementById('headerTitle').textContent  = surveyData.title || 'Encuesta de Valoración';
  document.getElementById('headerSeason').textContent = surveyData.season || 'Cantera';
  document.getElementById('surveyTitle').textContent  = surveyData.title || '';
  document.getElementById('surveyDesc').textContent   = surveyData.description || '';

  // Actualizar pills con etiquetas personalizadas
  document.querySelectorAll('.scale-pills .pill').forEach((pill, i) => {
    pill.textContent = `${i+1} · ${scaleLabels[i]}`;
  });

  const legendEl = document.querySelector('.scale-legend');
  if (legendEl) legendEl.textContent = surveyData.scaleLegendLabel || 'Escala de valoración:';

  // Ocultar leyenda si no hay preguntas tipo escala, o si showScale===false
  const hasScaleQuestion = (surveyData.aspects || []).some(a =>
    a.active && (a.questions || []).some(q => (typeof q === 'string' ? 'scale' : (q.type || 'scale')) === 'scale')
  );
  if (surveyData.showScale === false || !hasScaleQuestion) {
    const scaleWrap = document.querySelector('.scale-legend');
    const pillsWrap = document.querySelector('.scale-pills');
    if (scaleWrap) scaleWrap.style.display = 'none';
    if (pillsWrap) pillsWrap.style.display = 'none';
  }
  const container = document.getElementById('aspectsContainer');
  container.innerHTML = '';

  (surveyData.aspects || []).forEach((aspect, aIdx) => {
    if (!aspect.active) return;
    const card = document.createElement('div');
    card.className = 'card aspect-card';

    const questionsHtml = (aspect.questions || []).map((q, qIdx) => {
      const qn = typeof q === 'string' ? { text: q, type: 'scale', options: [] } : q;
      const inputHtml    = renderQuestionInput(qn, aIdx, qIdx);
      const needsComment = qn.type === 'scale';
      const optLabel     = qn.required === false
        ? ' <span style="font-size:11px;color:var(--text-mut);font-weight:400">(opcional)</span>' : '';
      return `
        <div class="question-row">
          <label class="question-label">${qn.text}${optLabel}</label>
          ${inputHtml}
          ${needsComment ? `<textarea class="comment-input question-comment"
            data-question-comment="${aIdx}_${qIdx}"
            placeholder="Comentario (opcional)…" rows="2"></textarea>` : ''}
        </div>`;
    }).join('');

    const isTwoCol = aspect.twoColumns === true && !aspect.isFixed;
    const isFixed  = aspect.isFixed === true;
    if (isFixed) card.classList.add('aspect-card-fixed');

    card.innerHTML = `
      <div class="aspect-header">
        <span class="aspect-icon">${aspect.icon || '📋'}</span>
        <h3 class="aspect-title">${aspect.title}</h3>
      </div>
      ${isTwoCol ? `<div class="two-col-grid">${questionsHtml}</div>` : questionsHtml}
      <div class="comment-wrap">
        <label class="comment-label">Comentario sobre este aspecto <span class="optional">(opcional)</span></label>
        <textarea class="comment-input" data-aspect-comment="${aIdx}"
          placeholder="Escribe aquí tu comentario…" rows="3"></textarea>
      </div>
    `;
    container.appendChild(card);
  });

  attachRatingEvents();
  attachTextSelectEvents();
}

// ── Highlight (texto libre) ──────────────────────────────
window.updateTextPreview = function(key) {
  const textarea = document.querySelector(`[data-text-answer="${key}"]`);
  const preview  = document.getElementById(`preview_${key}`);
  if (!textarea || !preview) return;
  const text = textarea.value;
  const hl   = window.highlights[key];
  if (hl && text.includes(hl)) {
    const escaped = hl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    preview.innerHTML = text.replace(
      new RegExp(escaped, 'g'),
      `<mark class="highlight-mark">${hl}</mark>`
    ).replace(/\n/g, '<br>');
    preview.style.display = 'block';
    textarea.style.display = 'none';
    updateMarkedBadge(key, hl);
  } else {
    preview.style.display = 'none';
    textarea.style.display = '';
    updateMarkedBadge(key, hl);
  }
};

window.applyHighlight = function(key) {
  const textarea = document.querySelector(`[data-text-answer="${key}"]`);
  if (!textarea) return;
  const sel = textarea.value.substring(textarea.selectionStart, textarea.selectionEnd).trim();
  if (!sel) { alert('Selecciona primero el texto que quieres marcar.'); return; }
  window.highlights[key] = sel;
  updateTextPreview(key);
  document.getElementById(`toolbar_${key}`).style.display = 'none';
};

window.removeHighlight = function(key) {
  delete window.highlights[key];
  const preview  = document.getElementById(`preview_${key}`);
  const textarea = document.querySelector(`[data-text-answer="${key}"]`);
  if (preview)  preview.style.display = 'none';
  if (textarea) textarea.style.display = '';
  updateMarkedBadge(key, null);
  document.getElementById(`toolbar_${key}`).style.display = 'none';
};

function updateMarkedBadge(key, hl) {
  const marked  = document.getElementById(`marked_${key}`);
  const badge   = document.getElementById(`markedbadge_${key}`);
  if (!marked || !badge) return;
  if (hl) {
    badge.textContent = hl;
    marked.style.display = 'flex';
  } else {
    marked.style.display = 'none';
  }
}

// Mostrar toolbar al seleccionar texto en textarea
function attachTextSelectEvents() {
  document.querySelectorAll('.text-answer-wrap').forEach(wrap => {
    const key      = wrap.dataset.key;
    const textarea = wrap.querySelector('textarea');
    const toolbar  = document.getElementById(`toolbar_${key}`);
    if (!textarea || !toolbar) return;
    textarea.addEventListener('mouseup', () => {
      const sel = textarea.value.substring(textarea.selectionStart, textarea.selectionEnd).trim();
      if (sel) {
        document.getElementById(`sel_${key}`).textContent = `"${sel}"`;
        toolbar.style.display = 'flex';
      } else {
        toolbar.style.display = 'none';
      }
    });
    textarea.addEventListener('keyup', () => {
      const sel = textarea.value.substring(textarea.selectionStart, textarea.selectionEnd).trim();
      if (sel) {
        document.getElementById(`sel_${key}`).textContent = `"${sel}"`;
        toolbar.style.display = 'flex';
      } else {
        toolbar.style.display = 'none';
      }
    });
    // Click en preview — volver a textarea para editar
    const preview = document.getElementById(`preview_${key}`);
    if (preview) {
      preview.addEventListener('click', () => {
        preview.style.display = 'none';
        textarea.style.display = '';
        textarea.focus();
      });
    }
  });
}

function attachRatingEvents() {
  document.querySelectorAll('.rating-group').forEach(group => {
    group.querySelectorAll('.rating-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const val  = parseInt(btn.dataset.val);
        group.querySelectorAll('.rating-btn').forEach(b => b.className = 'rating-btn');
        btn.classList.add(`selected-${val}`);
        const field = group.dataset.field;
        const aIdx  = group.dataset.aspect;
        const qIdx  = group.dataset.question;
        if (field) window.answers[field] = val;
        else window.answers[`${aIdx}_${qIdx}`] = val;
        updateProgress();
      });
    });
  });
}

// ── Progreso ──────────────────────────────────────────────
function updateProgress() {
  const total    = countRequired();
  const answered = Object.keys(window.answers).filter(k => window.answers[k] != null).length;
  const pct      = total === 0 ? 0 : Math.round((answered / total) * 100);
  document.getElementById('progressBar').style.width = pct + '%';
  document.getElementById('progressLabel').textContent = `${answered} / ${total}`;
}
window.updateProgress = updateProgress;

function countRequired() {
  if (!surveyData) return 0;
  let count = 0;
  (surveyData.aspects || []).forEach(a => {
    if (!a.active) return;
    (a.questions || []).forEach(q => {
      const qn = typeof q === 'string' ? { type:'scale', required:true } : q;
      // text es obligatorio si required===true explícitamente; checkbox siempre opcional
      if (qn.required !== false && qn.type !== 'checkbox') count++;
    });
  });
  return count;
}

// ── Toast de aviso ───────────────────────────────────────
function showToast(msg) {
  let toast = document.getElementById('surveyToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'surveyToast';
    toast.className = 'survey-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('visible');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('visible'), 3500);
}

// ── Validación ────────────────────────────────────────────
window.showReview = function() {
  let hasError  = false;
  let firstElem = null;
  const missing = [];

  (surveyData.aspects || []).forEach((a, aIdx) => {
    if (!a.active) return;
    (a.questions || []).forEach((q, qIdx) => {
      const qn = typeof q === 'string' ? { type:'scale', required:true } : q;
      // checkbox siempre opcional; text y groups respetan el campo required
      const isRequired = qn.required !== false && qn.type !== 'checkbox';
      if (!isRequired) return;

      const ansVal = window.answers[`${aIdx}_${qIdx}`];
      let isMissing = false;
      let missingDetail = '';

      if (qn.type === 'groups') {
        if (!ansVal || !ansVal.groups) {
          isMissing = true;
        } else {
          // Validar que todos los nombres estén rellenos
          const emptyNames = [];
          ansVal.groups.forEach((g, gi) => {
            if (!g.responsible?.trim()) emptyNames.push(`Grupo ${gi+1} Responsable`);
            g.members.forEach((m, mi) => {
              if (!m?.trim()) emptyNames.push(`Grupo ${gi+1} posición ${mi+2}`);
            });
          });
          if (emptyNames.length) {
            isMissing = true;
            missingDetail = ` (faltan ${emptyNames.length} nombres)`;
          }
        }
      } else if (qn.type === 'text') {
        isMissing = !ansVal?.trim();
      } else {
        isMissing = !ansVal;
      }

      if (isMissing) {
        hasError = true;
        missing.push((qn.text || `Pregunta ${qIdx+1} de ${a.title}`) + missingDetail);
        const group = document.querySelector(`.rating-group[data-aspect="${aIdx}"][data-question="${qIdx}"]`)
          || document.querySelector(`.options-group[data-key="${aIdx}_${qIdx}"]`)
          || document.getElementById(`gw_${aIdx}_${qIdx}`)
          || document.querySelector(`[data-text-answer="${aIdx}_${qIdx}"]`);
        if (group && !firstElem) firstElem = group;
        if (group) {
          group.style.outline = '2px solid var(--red)';
          group.style.borderRadius = 'var(--rs)';
          setTimeout(() => { group.style.outline = ''; group.style.borderRadius = ''; }, 1200);
        }
      }
    });
  });

  if (hasError) {
    const plural = missing.length === 1 ? 'campo obligatorio' : 'campos obligatorios';
    showToast(`⚠ Faltan ${missing.length} ${plural} por rellenar: ${missing.slice(0,2).join(', ')}${missing.length > 2 ? '…' : ''}`);
    if (firstElem) firstElem.closest('.card')?.scrollIntoView({ behavior:'smooth', block:'center' });
    return;
  }

  buildReview();
  showView('viewReview');
  window.scrollTo({ top:0, behavior:'smooth' });
};

function buildReview() {
  const container = document.getElementById('reviewContent');
  container.innerHTML = '';

  (surveyData.aspects || []).forEach((a, aIdx) => {
    if (!a.active) return;
    const sec = document.createElement('div');
    sec.className = 'review-section';
    sec.innerHTML = `<div class="review-section-title">${a.icon || ''} ${a.title}</div>`;
    (a.questions || []).forEach((q, qIdx) => {
      const qText = typeof q === 'string' ? q : (q.text || '—');
      const qType = typeof q === 'string' ? 'scale' : (q.type || 'scale');
      const score = window.answers[`${aIdx}_${qIdx}`];

      if (qType === 'groups') {
        const data = score;
        if (data && data.groups) {
          sec.innerHTML += `<div class="review-row" style="flex-direction:column;align-items:flex-start;gap:6px">
            <span class="review-q">${qText}</span>
            <div style="width:100%">
              ${data.groups.map((g, gi) => `
                <div style="margin-bottom:6px;padding:8px;background:var(--surface-alt);border-radius:var(--rs)">
                  <div style="font-size:11px;font-weight:700;color:var(--rm-blue);margin-bottom:4px">Grupo ${gi+1}</div>
                  <div style="font-size:12px"><strong>Responsable:</strong> ${g.responsible || '—'}</div>
                  ${g.members.map((m,mi) => `<div style="font-size:12px;color:var(--text-sec)">${mi+2}. ${m || '—'}</div>`).join('')}
                </div>`).join('')}
            </div>
          </div>`;
        } else {
          sec.innerHTML += `<div class="review-row"><span class="review-q">${qText}</span><em style="color:var(--text-mut)">Sin completar</em></div>`;
        }
        return;
      }

      const scoreDisplay = qType === 'scale'
        ? `${score} / 5`
        : (score || '<em style="color:var(--text-mut)">Sin respuesta</em>');
      sec.innerHTML += `
        <div class="review-row">
          <span class="review-q">${qText}</span>
          <span class="review-score score-${score}">${scoreDisplay}</span>
        </div>`;
      const qc = document.querySelector(`[data-question-comment="${aIdx}_${qIdx}"]`)?.value?.trim();
      if (qc) sec.innerHTML += `<div class="review-comment">"${qc}"</div>`;
    });
    const ac = document.querySelector(`[data-aspect-comment="${aIdx}"]`)?.value?.trim();
    if (ac) sec.innerHTML += `<div class="review-comment">💬 ${ac}</div>`;
    container.appendChild(sec);
  });
}

window.backToSurvey = function() {
  showView('viewSurvey');
  window.scrollTo({ top:0, behavior:'smooth' });
};

// ── ENVIAR ────────────────────────────────────────────────
window.submitSurvey = async function() {
  if (new URLSearchParams(window.location.search).get('preview') === '1') {
    alert('Modo preview — las respuestas no se guardan.');
    return;
  }
  const btn = document.getElementById('btnConfirm');
  btn.disabled = true;
  btn.textContent = 'Enviando…';

  try {
    const aspectComments   = {};
    const questionComments = {};
    (surveyData.aspects || []).forEach((a, aIdx) => {
      if (!a.active) return;
      const ac = document.querySelector(`[data-aspect-comment="${aIdx}"]`)?.value?.trim();
      if (ac) aspectComments[aIdx] = ac;
      (a.questions || []).forEach((_, qIdx) => {
        const qc = document.querySelector(`[data-question-comment="${aIdx}_${qIdx}"]`)?.value?.trim();
        if (qc) questionComments[`${aIdx}_${qIdx}`] = qc;
      });
    });

    const aspectAverages = {};
    (surveyData.aspects || []).forEach((a, aIdx) => {
      if (!a.active) return;
      // Solo calcular media para preguntas de tipo escala
      const scores = (a.questions || []).map((q, qIdx) => {
        const qType = typeof q === 'string' ? 'scale' : (q.type || 'scale');
        if (qType !== 'scale') return null;
        const v = window.answers[`${aIdx}_${qIdx}`];
        return typeof v === 'number' ? v : null;
      }).filter(v => v !== null);
      if (scores.length) aspectAverages[a.title] = +(scores.reduce((s,v)=>s+v,0)/scores.length).toFixed(2);
    });

    const allAvgs = Object.values(aspectAverages);
    // globalAverage solo si hay aspectos con escala
    const globalAverage = allAvgs.length ? +(allAvgs.reduce((s,v)=>s+v,0)/allAvgs.length).toFixed(2) : null;

    await addDoc(collection(db, 'surveyResponses'), {
      surveyId,
      submittedAt:    serverTimestamp(),
      answers:        window.answers,
      highlights:     window.highlights,
      aspectComments,
      questionComments,
      aspectAverages,
      globalAverage,
    });

    if (surveyData.limitOnePerDevice === true) {
      setCookie(`survey_done_${surveyId}`, '1', 365);
    }
    showView('viewSent');
    hide('progressWrap');

  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.textContent = 'Enviar encuesta definitivamente';
    alert('Error al enviar. Inténtalo de nuevo.\n' + err.message);
  }
};
