import {
  CATALOG, CAT_COLOR, applyCatalog, clearCatalogOverride, getDefaultCatalog, saveCatalogOverride,
} from './catalog';
import type { FacilityType, IoPort } from './types';

export interface EditorHooks {
  /** 배치된 모듈이 이 설비 타입을 참조 중인지 */
  isTypeInUse(typeId: string): boolean;
  /** 카탈로그 변경 후 팔레트/검증 갱신 */
  onCatalogChanged(): void;
  toast(msg: string): void;
}

const DEFAULT_COLOR = '#64748b';

export function initEditor(hooks: EditorHooks): void {
  const overlay = document.createElement('div');
  overlay.id = 'editorOverlay';
  overlay.innerHTML = `
    <div id="editorModal">
      <div class="ed-head">
        <b>🛠 설비 데이터 에디터</b>
        <span class="ed-hint">수정 사항은 이 브라우저(localStorage)에 저장됩니다. 저장소에 반영하려면 JSON을 내보내 public/data/facilities.json을 교체하세요.</span>
        <button class="btn" id="edClose">✕ 닫기</button>
      </div>
      <div class="ed-body">
        <aside class="ed-list">
          <input type="text" id="edSearch" placeholder="설비 검색…">
          <div id="edItems"></div>
        </aside>
        <main class="ed-form" id="edForm"></main>
      </div>
      <div class="ed-foot">
        <button class="btn" id="edNew">＋ 새 설비</button>
        <button class="btn" id="edDup">⧉ 복제</button>
        <button class="btn danger" id="edDel">🗑 삭제</button>
        <span class="spacer"></span>
        <button class="btn" id="edExport">⬇ JSON 내보내기</button>
        <button class="btn danger" id="edReset">↺ 기본값 복원</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>
  )[c]);

  let selectedId: string | null = null;
  let search = '';

  function open(): void {
    overlay.style.display = 'flex';
    if (!selectedId && CATALOG.facilities.length) selectedId = CATALOG.facilities[0].id;
    renderList();
    renderForm();
  }
  function close(): void {
    overlay.style.display = 'none';
  }

  function commit(): void {
    applyCatalog(CATALOG); // 조회 맵 재구축
    saveCatalogOverride();
    hooks.onCatalogChanged();
    renderList();
  }

  /* ── 목록 ── */
  function renderList(): void {
    const box = $('edItems');
    const q = search.trim().toLowerCase();
    const byCat: Record<string, FacilityType[]> = {};
    for (const f of CATALOG.facilities) {
      if (q && !f.name.toLowerCase().includes(q) && !f.id.toLowerCase().includes(q)) continue;
      (byCat[f.category] ??= []).push(f);
    }
    let html = '';
    for (const [cat, items] of Object.entries(byCat)) {
      html += `<div class="ed-cat"><span class="cat-dot" style="background:${CAT_COLOR[cat] ?? DEFAULT_COLOR}"></span>${esc(cat)}</div>`;
      for (const f of items) {
        html += `<div class="ed-item ${f.id === selectedId ? 'sel' : ''}" data-id="${esc(f.id)}">
          <span>${f.icon ?? '■'}</span> ${esc(f.name)} <span class="ed-id">${esc(f.id)}</span></div>`;
      }
    }
    box.innerHTML = html || '<div class="ed-empty">검색 결과 없음</div>';
    box.querySelectorAll<HTMLElement>('.ed-item').forEach((el) => {
      el.addEventListener('click', () => {
        selectedId = el.dataset.id!;
        renderList();
        renderForm();
      });
    });
  }

  /* ── 폼 ── */
  function ioRowHtml(p: Partial<IoPort>): string {
    const sideOpt = (v: string, label: string) =>
      `<option value="${v}" ${(p.side ?? '') === v ? 'selected' : ''}>${label}</option>`;
    return `
      <input type="text" class="ed-io-res" value="${esc(p.resource ?? '')}" placeholder="리소스 (any = 전체)">
      <input type="number" class="ed-io-rate" value="${p.rate ?? 30}" step="0.5" min="0" title="분당 개수">
      <select class="ed-io-tp" title="운송 종류">
        <option value="belt" ${(p.transport ?? 'belt') === 'belt' ? 'selected' : ''}>벨트</option>
        <option value="pipe" ${p.transport === 'pipe' ? 'selected' : ''}>파이프</option>
      </select>
      <select class="ed-io-side" title="포트가 붙는 변 (자동 = 입력 W / 출력 E 분배)">
        ${sideOpt('', '자동')}${sideOpt('N', '북(N)')}${sideOpt('E', '동(E)')}${sideOpt('S', '남(S)')}${sideOpt('W', '서(W)')}
      </select>
      <input type="number" class="ed-io-pos" value="${p.pos ?? 0}" min="0" max="19" title="변 위의 칸 번호(0부터)" ${p.side ? '' : 'disabled'}>
      <button class="btn danger ed-io-del" title="포트 삭제">✕</button>`;
  }
  function ioRows(kind: 'inputs' | 'outputs', arr: IoPort[] | undefined): string {
    const rows = (arr ?? []).map((p) => `<div class="ed-io-row" data-kind="${kind}">${ioRowHtml(p)}</div>`).join('');
    return `${rows}<button class="btn ed-io-add" data-kind="${kind}">＋ ${kind === 'inputs' ? '입력' : '출력'} 포트 추가</button>`;
  }
  function wireIoRow(row: HTMLElement): void {
    row.querySelector('.ed-io-del')!.addEventListener('click', () => row.remove());
    const sideSel = row.querySelector('.ed-io-side') as HTMLSelectElement;
    const posInput = row.querySelector('.ed-io-pos') as HTMLInputElement;
    sideSel.addEventListener('change', () => { posInput.disabled = !sideSel.value; });
  }

  function renderForm(): void {
    const form = $('edForm');
    const f = CATALOG.facilities.find((x) => x.id === selectedId);
    if (!f) {
      form.innerHTML = '<div class="ed-empty">좌측에서 설비를 선택하거나 "새 설비"를 추가하세요.</div>';
      return;
    }
    const cats = Object.keys(CATALOG.categories ?? {});
    form.innerHTML = `
      <div class="ed-grid">
        <label>ID <input type="text" id="efId" value="${esc(f.id)}" ${hooks.isTypeInUse(f.id) ? 'disabled title="배치된 설비가 참조 중이라 변경 불가"' : ''}></label>
        <label>이름 <input type="text" id="efName" value="${esc(f.name)}"></label>
        <label>카테고리 <input type="text" id="efCat" value="${esc(f.category)}" list="efCatList">
          <datalist id="efCatList">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label>
        <label>아이콘 (이모지 폴백) <input type="text" id="efIcon" value="${esc(f.icon ?? '')}" maxlength="4"></label>
        <label>이미지 경로 <input type="text" id="efImage" value="${esc(f.image ?? '')}" placeholder="icons/xxx.png (public/ 기준)"></label>
        <label>가로(칸) <input type="number" id="efW" value="${f.footprint.w}" min="1" max="20"></label>
        <label>세로(칸) <input type="number" id="efH" value="${f.footprint.h}" min="1" max="20"></label>
        <label>전력 소비량 <input type="number" id="efPower" value="${f.powerDraw ?? 0}" min="0"></label>
        <label>전력 범위(m) <input type="number" id="efRange" value="${f.powerRange ?? 0}" min="0" title="0 = 전력 공급 설비 아님"></label>
        <label>최대 배치 수 <input type="number" id="efMax" value="${f.maxPerBase ?? 0}" min="0" title="0 = 제한 없음"></label>
        <label class="ed-check"><input type="checkbox" id="efSource" ${f.powerSource ? 'checked' : ''}> 전력원 (코어)</label>
        <label class="ed-check"><input type="checkbox" id="efPass" ${f.passthrough ? 'checked' : ''}> 물류 통과 (passthrough)</label>
        <label class="ed-check"><input type="checkbox" id="efLimiter" ${f.limiter ? 'checked' : ''}> 통과 제한 설정 가능 (컨트롤 포트)</label>
      </div>
      <label class="ed-note">설명 (정보 패널에 💡로 표시)
        <textarea id="efNote" rows="2">${esc(f.note ?? '')}</textarea></label>
      <div class="ed-io">
        <div><div class="sect-title">입력 (수요, 분당)</div><div id="efInputs">${ioRows('inputs', f.inputs)}</div></div>
        <div><div class="sect-title">출력 (생산, 분당)</div><div id="efOutputs">${ioRows('outputs', f.outputs)}</div></div>
      </div>
      <label class="ed-note">레시피 (JSON 배열 — 각 항목: {"id","name","inputs":[{"resource","rate","transport"?}],"outputs":[...],"note"?}. 비우면 레시피 없음)
        <textarea id="efRecipes" rows="8" spellcheck="false">${esc(f.recipes?.length ? JSON.stringify(f.recipes, null, 1) : '')}</textarea></label>
      <div class="ed-apply"><button class="btn" id="efApply">✔ 이 설비 저장</button></div>`;

    // IO 행 추가/삭제 (폼 안에서만 동작, 저장 시 일괄 반영)
    form.querySelectorAll<HTMLButtonElement>('.ed-io-add').forEach((btn) => {
      btn.addEventListener('click', () => {
        const kind = btn.dataset.kind as 'inputs' | 'outputs';
        const row = document.createElement('div');
        row.className = 'ed-io-row';
        row.dataset.kind = kind;
        row.innerHTML = ioRowHtml({});
        wireIoRow(row);
        btn.before(row);
      });
    });
    form.querySelectorAll<HTMLElement>('.ed-io-row').forEach(wireIoRow);

    $('efApply').addEventListener('click', () => {
      const newId = ($('efId') as HTMLInputElement).value.trim();
      const name = ($('efName') as HTMLInputElement).value.trim();
      const cat = ($('efCat') as HTMLInputElement).value.trim();
      if (!newId || !name || !cat) { hooks.toast('ID·이름·카테고리는 필수입니다'); return; }
      if (newId !== f.id && CATALOG.facilities.some((x) => x.id === newId)) {
        hooks.toast(`ID "${newId}"는 이미 사용 중입니다`);
        return;
      }
      const readIo = (boxId: string): IoPort[] => {
        const out: IoPort[] = [];
        $(boxId).querySelectorAll<HTMLElement>('.ed-io-row').forEach((row) => {
          const res = (row.querySelector('.ed-io-res') as HTMLInputElement).value.trim();
          const rate = parseFloat((row.querySelector('.ed-io-rate') as HTMLInputElement).value);
          if (!res) return;
          const port: IoPort = { resource: res, rate: Number.isFinite(rate) ? rate : 0 };
          const tp = (row.querySelector('.ed-io-tp') as HTMLSelectElement).value;
          if (tp === 'pipe') port.transport = 'pipe';
          const side = (row.querySelector('.ed-io-side') as HTMLSelectElement).value;
          if (side) {
            port.side = side as IoPort['side'];
            port.pos = Math.max(0, parseInt((row.querySelector('.ed-io-pos') as HTMLInputElement).value, 10) || 0);
          }
          out.push(port);
        });
        return out;
      };
      // 레시피 JSON 파싱·검증
      const recipesRaw = ($('efRecipes') as HTMLTextAreaElement).value.trim();
      let recipes: FacilityType['recipes'];
      if (recipesRaw) {
        try {
          recipes = JSON.parse(recipesRaw);
          if (!Array.isArray(recipes)) throw new Error('배열이어야 합니다');
          for (const r of recipes) {
            if (typeof r.id !== 'string' || !r.id || typeof r.name !== 'string' || !r.name) {
              throw new Error('각 레시피에 id와 name이 필요합니다');
            }
            for (const key of ['inputs', 'outputs'] as const) {
              const arr = r[key];
              if (arr !== undefined) {
                if (!Array.isArray(arr)) throw new Error(`${r.id}의 ${key}는 배열이어야 합니다`);
                for (const p of arr) {
                  if (typeof p.resource !== 'string' || typeof p.rate !== 'number') {
                    throw new Error(`${r.id}의 ${key} 항목에 resource(문자열)와 rate(숫자)가 필요합니다`);
                  }
                }
              }
            }
          }
          if (new Set(recipes.map((r) => r.id)).size !== recipes.length) {
            throw new Error('레시피 id가 중복됩니다');
          }
        } catch (err) {
          hooks.toast(`레시피 JSON 오류: ${(err as Error).message}`);
          return;
        }
      }
      f.id = newId;
      f.name = name;
      f.category = cat;
      f.recipes = recipes?.length ? recipes : undefined;
      f.icon = ($('efIcon') as HTMLInputElement).value.trim() || undefined;
      f.image = ($('efImage') as HTMLInputElement).value.trim() || undefined;
      f.footprint = {
        w: Math.max(1, parseInt(($('efW') as HTMLInputElement).value, 10) || 1),
        h: Math.max(1, parseInt(($('efH') as HTMLInputElement).value, 10) || 1),
      };
      const num = (id: string) => parseFloat(($(id) as HTMLInputElement).value) || 0;
      f.powerDraw = num('efPower') || undefined;
      f.powerRange = num('efRange') || undefined;
      f.maxPerBase = num('efMax') || undefined;
      f.powerSource = ($('efSource') as HTMLInputElement).checked || undefined;
      f.passthrough = ($('efPass') as HTMLInputElement).checked || undefined;
      f.limiter = ($('efLimiter') as HTMLInputElement).checked || undefined;
      f.note = ($('efNote') as HTMLTextAreaElement).value.trim() || undefined;
      f.inputs = readIo('efInputs');
      f.outputs = readIo('efOutputs');
      if (!(cat in (CATALOG.categories ?? {}))) {
        (CATALOG.categories ??= {})[cat] = { color: DEFAULT_COLOR };
      }
      selectedId = newId;
      commit();
      renderForm();
      hooks.toast(`"${name}" 저장됨`);
    });
  }

  /* ── 하단 버튼 ── */
  $('edClose').addEventListener('click', close);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  ($('edSearch') as HTMLInputElement).addEventListener('input', (e) => {
    search = (e.target as HTMLInputElement).value;
    renderList();
  });
  $('edNew').addEventListener('click', () => {
    let n = 1;
    while (CATALOG.facilities.some((f) => f.id === `new_facility_${n}`)) n++;
    const f: FacilityType = {
      id: `new_facility_${n}`, name: '새 설비',
      category: Object.keys(CATALOG.categories ?? {})[0] ?? '기타',
      icon: '🏗️', footprint: { w: 1, h: 1 }, inputs: [], outputs: [],
    };
    CATALOG.facilities.push(f);
    selectedId = f.id;
    commit();
    renderForm();
  });
  $('edDup').addEventListener('click', () => {
    const f = CATALOG.facilities.find((x) => x.id === selectedId);
    if (!f) return;
    const copy = structuredClone(f);
    let n = 1;
    while (CATALOG.facilities.some((x) => x.id === `${f.id}_copy${n}`)) n++;
    copy.id = `${f.id}_copy${n}`;
    copy.name = `${f.name} (복제)`;
    CATALOG.facilities.push(copy);
    selectedId = copy.id;
    commit();
    renderForm();
  });
  $('edDel').addEventListener('click', () => {
    const f = CATALOG.facilities.find((x) => x.id === selectedId);
    if (!f) return;
    if (hooks.isTypeInUse(f.id)) {
      hooks.toast('배치된 설비가 이 타입을 사용 중입니다. 먼저 캔버스에서 제거하세요.');
      return;
    }
    if (!confirm(`설비 "${f.name}"(${f.id})을 삭제할까요?`)) return;
    CATALOG.facilities = CATALOG.facilities.filter((x) => x.id !== f.id);
    selectedId = CATALOG.facilities[0]?.id ?? null;
    commit();
    renderForm();
  });
  $('edExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(CATALOG, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'facilities.json';
    a.click();
    URL.revokeObjectURL(a.href);
    hooks.toast('내보낸 파일로 public/data/facilities.json을 교체하면 저장소에 반영됩니다');
  });
  $('edReset').addEventListener('click', () => {
    if (!confirm('모든 수정 사항을 버리고 기본 데이터로 복원할까요?')) return;
    clearCatalogOverride();
    applyCatalog(getDefaultCatalog());
    selectedId = CATALOG.facilities[0]?.id ?? null;
    hooks.onCatalogChanged();
    renderList();
    renderForm();
    hooks.toast('기본 데이터로 복원했습니다');
  });

  document.getElementById('btnEditor')!.addEventListener('click', open);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.style.display === 'flex') close();
  });
}
