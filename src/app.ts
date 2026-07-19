import { CATALOG, CAT_COLOR, F } from './catalog';
import { initEditor } from './editor';
import { computeFlows } from './flows';
import {
  canPlace, connPath, dims, distToSeg, getPorts, portByKey,
} from './geometry';
import type { Pt } from './geometry';
import {
  LS_THEME, decodeShareHash, deserializeInto, encodeShareHash, loadLocal, saveLocal, serialize,
} from './persist';
import { computePower } from './power';
import type {
  FlowInfo, LayoutState, ModuleInst, PortInfo, PowerInfo,
} from './types';

const CELL = 32; // 1 그리드 셀 = 32px (줌 1 기준)

interface Selection { kind: 'module' | 'conn'; id: number }
interface Hover {
  kind: 'module' | 'conn' | 'port';
  id?: number;
  moduleId?: number;
  port?: PortInfo;
}
interface Ghost { typeId: string; rot: number; x: number; y: number; valid: boolean; onCanvas: boolean }

export function startApp(): void {
  const state: LayoutState = { modules: [], connections: [], nextId: 1 };
  const view = { x: 0, y: 0, scale: 1 };

  let selected: Selection | null = null;
  let hover: Hover | null = null;
  let ghost: Ghost | null = null;
  let armedType: string | null = null;
  let paletteDrag: { typeId: string; startX: number; startY: number; moved: boolean } | null = null;
  let moveDrag: { id: number; offX: number; offY: number; origX: number; origY: number; moved: boolean } | null = null;
  let pan: { sx: number; sy: number; vx: number; vy: number; moved: boolean } | null = null;
  let pending: { moduleId: number; portKey: string } | null = null;
  let mouseCell: Pt = { x: 0, y: 0 };
  let mousePx: Pt = { x: 0, y: 0 };

  let powerInfo: PowerInfo = { nodes: [], unpowered: new Set(), hasSource: false };
  let flowInfo: FlowInfo = { flows: {}, bottlenecks: new Set(), modWarn: {}, inByPort: {} };

  const cv = document.getElementById('cv') as HTMLCanvasElement;
  const ctx = cv.getContext('2d')!;
  const wrap = document.getElementById('canvasWrap')!;
  const tooltip = document.getElementById('tooltip')!;

  const $ = (id: string) => document.getElementById(id)!;
  const modById = (id: number) => state.modules.find((m) => m.id === id);
  const round1 = (v: number) => Math.round(v * 10) / 10;
  const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>
  )[c]);

  function toast(msg: string, ms = 2200): void {
    const el = $('toast') as HTMLElement & { _t?: number };
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = window.setTimeout(() => el.classList.remove('show'), ms);
  }

  /* ── 좌표 변환 ── */
  const sOf = (wx: number, wy: number): Pt => ({ x: wx * CELL * view.scale + view.x, y: wy * CELL * view.scale + view.y });
  const wOf = (sx: number, sy: number): Pt => ({ x: (sx - view.x) / (CELL * view.scale), y: (sy - view.y) / (CELL * view.scale) });

  /* ── 파생 상태 재계산 ── */
  let saveTimer = 0;
  function scheduleSave(): void {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => saveLocal(state), 300);
  }
  function recompute(): void {
    powerInfo = computePower(state);
    flowInfo = computeFlows(state);
    updateStatus();
    renderInfo();
    requestRender();
  }

  /* ── 조작(뮤테이션) ── */
  function addModule(typeId: string, x: number, y: number, rot: number): ModuleInst {
    const m: ModuleInst = { id: state.nextId++, typeId, x, y, rot: rot || 0 };
    state.modules.push(m);
    selected = { kind: 'module', id: m.id };
    recompute();
    scheduleSave();
    return m;
  }
  function deleteSelected(): void {
    if (!selected) return;
    if (selected.kind === 'module') {
      const id = selected.id;
      state.modules = state.modules.filter((m) => m.id !== id);
      state.connections = state.connections.filter((c) => c.fromModuleId !== id && c.toModuleId !== id);
    } else {
      const id = selected.id;
      state.connections = state.connections.filter((c) => c.id !== id);
    }
    selected = null;
    recompute();
    scheduleSave();
  }
  function rotateTarget(): void {
    if (ghost) { ghost.rot = (ghost.rot + 90) % 360; updateGhostPos(); requestRender(); return; }
    if (selected?.kind === 'module') {
      const m = modById(selected.id);
      if (!m) return;
      const nr = (m.rot + 90) % 360;
      if (canPlace(state.modules, m.typeId, m.x, m.y, nr, m.id)) {
        m.rot = nr;
        recompute();
        scheduleSave();
      } else {
        toast('회전하면 다른 설비와 겹칩니다');
      }
    }
  }
  function tryConnect(a: { moduleId: number; port: PortInfo }, b: { moduleId: number; port: PortInfo }): boolean {
    let from: typeof a; let to: typeof a;
    if (a.port.kind === 'output' && b.port.kind === 'input') { from = a; to = b; }
    else if (a.port.kind === 'input' && b.port.kind === 'output') { from = b; to = a; }
    else { toast('출력(●) 포트와 입력(○) 포트를 연결해야 합니다'); return false; }
    if (from.moduleId === to.moduleId) { toast('같은 설비끼리는 연결할 수 없습니다'); return false; }
    const rOut = from.port.resource;
    const rIn = to.port.resource;
    if (rOut !== 'any' && rIn !== 'any' && rOut !== rIn) {
      toast(`리소스 불일치: [${rOut}] → [${rIn}] 연결 불가`);
      return false;
    }
    if (state.connections.some((c) => c.fromModuleId === from.moduleId && c.fromPort === from.port.key
      && c.toModuleId === to.moduleId && c.toPort === to.port.key)) {
      toast('이미 연결되어 있습니다');
      return false;
    }
    state.connections.push({
      id: state.nextId++,
      fromModuleId: from.moduleId, fromPort: from.port.key,
      toModuleId: to.moduleId, toPort: to.port.key,
    });
    recompute();
    scheduleSave();
    return true;
  }

  /* ── 히트 테스트 ── */
  function hitPort(wpt: Pt): Hover | null {
    const rad = Math.max(0.28, 9 / (CELL * view.scale));
    for (const m of state.modules) {
      for (const p of getPorts(m)) {
        if (Math.hypot(p.x - wpt.x, p.y - wpt.y) <= rad) return { kind: 'port', moduleId: m.id, port: p };
      }
    }
    return null;
  }
  function hitModule(wpt: Pt): Hover | null {
    for (let i = state.modules.length - 1; i >= 0; i--) {
      const m = state.modules[i];
      const d = dims(m);
      if (wpt.x >= m.x && wpt.x <= m.x + d.w && wpt.y >= m.y && wpt.y <= m.y + d.h) return { kind: 'module', id: m.id };
    }
    return null;
  }
  function hitConn(wpt: Pt): Hover | null {
    const tol = Math.max(0.22, 7 / (CELL * view.scale));
    for (const c of state.connections) {
      const pts = connPath(c, modById);
      if (!pts) continue;
      for (let i = 0; i < pts.length - 1; i++) {
        if (distToSeg(wpt, pts[i], pts[i + 1]) <= tol) return { kind: 'conn', id: c.id };
      }
    }
    return null;
  }

  /* ── 렌더링 (필요 시에만 다시 그리기) ── */
  let renderQueued = false;
  function requestRender(): void {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }
  function resize(): void {
    const dpr = window.devicePixelRatio || 1;
    cv.width = wrap.clientWidth * dpr;
    cv.height = wrap.clientHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function cssVar(name: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  function render(): void {
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    ctx.clearRect(0, 0, W, H);
    drawGrid(W, H);
    drawPowerRanges();
    drawConnections();
    drawModules();
    drawPending();
    drawGhost();
  }
  function drawGrid(W: number, H: number): void {
    const s = CELL * view.scale;
    const x0 = Math.floor(-view.x / s);
    const x1 = Math.ceil((W - view.x) / s);
    const y0 = Math.floor(-view.y / s);
    const y1 = Math.ceil((H - view.y) / s);
    ctx.lineWidth = 1;
    for (let gx = x0; gx <= x1; gx++) {
      const sx = gx * s + view.x;
      ctx.strokeStyle = gx % 8 === 0 ? cssVar('--grid-major') : cssVar('--grid-line');
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H); ctx.stroke();
    }
    for (let gy = y0; gy <= y1; gy++) {
      const sy = gy * s + view.y;
      ctx.strokeStyle = gy % 8 === 0 ? cssVar('--grid-major') : cssVar('--grid-line');
      ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(W, sy); ctx.stroke();
    }
    const o = sOf(0, 0);
    ctx.fillStyle = cssVar('--grid-major');
    ctx.beginPath(); ctx.arc(o.x, o.y, 3, 0, Math.PI * 2); ctx.fill();
  }
  function drawPowerRanges(): void {
    for (const n of powerInfo.nodes) {
      const c = sOf(n.cx, n.cy);
      const r = n.r * CELL * view.scale;
      ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      if (n.active) {
        ctx.fillStyle = 'rgba(234,179,8,0.055)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(234,179,8,0.4)';
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = 'rgba(148,163,184,0.4)';
        ctx.setLineDash([6, 5]);
      }
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  function drawConnections(): void {
    for (const c of state.connections) {
      const pts = connPath(c, modById);
      if (!pts) continue;
      const isBottleneck = flowInfo.bottlenecks.has(c.id);
      const isSel = selected?.kind === 'conn' && selected.id === c.id;
      const isHover = hover?.kind === 'conn' && hover.id === c.id;
      ctx.strokeStyle = isSel ? cssVar('--accent') : isBottleneck ? cssVar('--warn') : isHover ? cssVar('--text') : cssVar('--belt');
      ctx.lineWidth = isBottleneck || isSel ? 3.5 : 2.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach((p, i) => {
        const s = sOf(p.x, p.y);
        if (i) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y);
      });
      ctx.stroke();
      // 종점 화살표
      const b = sOf(pts[pts.length - 1].x, pts[pts.length - 1].y);
      const a = sOf(pts[pts.length - 2].x, pts[pts.length - 2].y);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const L = 7;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - L * Math.cos(ang - 0.5), b.y - L * Math.sin(ang - 0.5));
      ctx.lineTo(b.x - L * Math.cos(ang + 0.5), b.y - L * Math.sin(ang + 0.5));
      ctx.closePath();
      ctx.fill();
      if (isBottleneck) {
        const mid = pts[Math.floor(pts.length / 2)];
        const ms = sOf(mid.x, mid.y);
        ctx.font = '13px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('⚠️', ms.x, ms.y - 10);
      }
    }
  }
  function drawModules(): void {
    const s = CELL * view.scale;
    for (const m of state.modules) {
      const t = F(m.typeId);
      const d = dims(m);
      const p0 = sOf(m.x, m.y);
      const w = d.w * s;
      const h = d.h * s;
      const catColor = CAT_COLOR[t.category] ?? '#64748b';
      const unpowered = powerInfo.unpowered.has(m.id);
      const warned = !!flowInfo.modWarn[m.id];
      const isSel = selected?.kind === 'module' && selected.id === m.id;
      const isHover = hover?.kind === 'module' && hover.id === m.id;

      ctx.fillStyle = catColor + (isHover || isSel ? '55' : '38');
      roundRect(p0.x + 1.5, p0.y + 1.5, w - 3, h - 3, Math.min(6, s * 0.2));
      ctx.fill();
      if (unpowered) {
        ctx.fillStyle = 'rgba(239,68,68,0.22)';
        roundRect(p0.x + 1.5, p0.y + 1.5, w - 3, h - 3, Math.min(6, s * 0.2));
        ctx.fill();
      }
      ctx.strokeStyle = isSel ? cssVar('--accent') : unpowered ? cssVar('--danger') : catColor;
      ctx.lineWidth = isSel || unpowered ? 2.5 : 1.5;
      roundRect(p0.x + 1.5, p0.y + 1.5, w - 3, h - 3, Math.min(6, s * 0.2));
      ctx.stroke();

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const iconSize = Math.min(w, h) * 0.42;
      if (iconSize > 8) {
        ctx.font = `${iconSize}px sans-serif`;
        ctx.fillText(t.icon ?? '■', p0.x + w / 2, p0.y + h / 2 - (view.scale > 0.7 && Math.min(d.w, d.h) > 1 ? h * 0.08 : 0));
      }
      if (view.scale > 0.7 && Math.min(d.w, d.h) > 1) {
        ctx.font = `${Math.max(9, s * 0.28)}px sans-serif`;
        ctx.fillStyle = cssVar('--text');
        ctx.fillText(t.name, p0.x + w / 2, p0.y + h - Math.max(8, s * 0.3), w - 6);
      }
      let bx = p0.x + w - 10;
      ctx.font = '13px sans-serif';
      if (warned) { ctx.fillText('⚠️', bx, p0.y + 10); bx -= 16; }
      if (unpowered) ctx.fillText('⚡', bx, p0.y + 10);

      if (view.scale > 0.45) {
        for (const port of getPorts(m)) {
          const sp = sOf(port.x, port.y);
          const r = Math.max(3.5, s * 0.13);
          const isPendingStart = pending && pending.moduleId === m.id && pending.portKey === port.key;
          ctx.beginPath(); ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
          if (port.kind === 'output') {
            ctx.fillStyle = cssVar('--warn');
            ctx.fill();
          } else {
            ctx.fillStyle = cssVar('--bg-canvas');
            ctx.fill();
            ctx.strokeStyle = cssVar('--ok');
            ctx.lineWidth = 2;
            ctx.stroke();
          }
          const isPortHover = hover?.kind === 'port' && hover.moduleId === m.id && hover.port?.key === port.key;
          if (isPendingStart || isPortHover) {
            ctx.beginPath(); ctx.arc(sp.x, sp.y, r + 3, 0, Math.PI * 2);
            ctx.strokeStyle = cssVar('--accent');
            ctx.lineWidth = 2;
            ctx.stroke();
          }
        }
      }
    }
  }
  function drawPending(): void {
    if (!pending) return;
    const m = modById(pending.moduleId);
    if (!m) { pending = null; return; }
    const p = portByKey(m, pending.portKey);
    if (!p) { pending = null; return; }
    const a = sOf(p.x, p.y);
    ctx.strokeStyle = cssVar('--accent');
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(mousePx.x, mousePx.y); ctx.stroke();
    ctx.setLineDash([]);
  }
  function drawGhost(): void {
    if (!ghost || !ghost.onCanvas) return;
    const t = F(ghost.typeId);
    const fp = t.footprint;
    const d = ghost.rot % 180 === 0 ? { w: fp.w, h: fp.h } : { w: fp.h, h: fp.w };
    const s = CELL * view.scale;
    const p0 = sOf(ghost.x, ghost.y);
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = ghost.valid ? 'rgba(74,222,128,0.25)' : 'rgba(248,113,113,0.3)';
    roundRect(p0.x, p0.y, d.w * s, d.h * s, 5);
    ctx.fill();
    ctx.strokeStyle = ghost.valid ? cssVar('--ok') : cssVar('--danger');
    ctx.lineWidth = 2;
    roundRect(p0.x, p0.y, d.w * s, d.h * s, 5);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${Math.min(d.w, d.h) * s * 0.4}px sans-serif`;
    ctx.fillText(t.icon ?? '■', p0.x + (d.w * s) / 2, p0.y + (d.h * s) / 2);
    ctx.globalAlpha = 1;
    if (t.powerRange && t.powerRange > 0) {
      const c = sOf(ghost.x + d.w / 2, ghost.y + d.h / 2);
      ctx.beginPath();
      ctx.arc(c.x, c.y, (t.powerRange / (CATALOG.metersPerCell || 4)) * s, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(234,179,8,0.5)';
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  function roundRect(x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ── 팔레트 ── */
  function buildPalette(): void {
    const pal = $('palette');
    pal.innerHTML = '';
    const byCat: Record<string, typeof CATALOG.facilities> = {};
    for (const f of CATALOG.facilities) (byCat[f.category] ??= []).push(f);
    for (const [cat, items] of Object.entries(byCat)) {
      const head = document.createElement('div');
      head.className = 'cat-header';
      head.innerHTML = `<span class="cat-dot" style="background:${CAT_COLOR[cat] ?? '#888'}"></span>${esc(cat)}`;
      pal.appendChild(head);
      for (const f of items) {
        const el = document.createElement('div');
        el.className = 'pal-item';
        el.dataset.typeId = f.id;
        el.style.setProperty('--cat-color', CAT_COLOR[cat] ?? '#888');
        const power = f.powerRange && f.powerRange > 0
          ? `범위 ${f.powerRange}m`
          : f.powerDraw && f.powerDraw > 0 ? `전력 ${f.powerDraw}` : '무전력';
        el.innerHTML = `<span class="pal-icon">${f.icon ?? '■'}</span>
          <span><div class="pal-name">${esc(f.name)}</div>
          <div class="pal-meta">${f.footprint.w}×${f.footprint.h} · ${esc(power)}</div></span>`;
        el.addEventListener('mousedown', (e) => {
          e.preventDefault();
          paletteDrag = { typeId: f.id, startX: e.clientX, startY: e.clientY, moved: false };
          ghost = { typeId: f.id, rot: 0, x: 0, y: 0, valid: false, onCanvas: false };
        });
        pal.appendChild(el);
      }
    }
  }
  function setArmed(typeId: string | null): void {
    armedType = typeId;
    document.querySelectorAll<HTMLElement>('.pal-item').forEach((el) => {
      el.classList.toggle('armed', el.dataset.typeId === typeId);
    });
    if (typeId) {
      if (!ghost || ghost.typeId !== typeId) {
        ghost = { typeId, rot: ghost ? ghost.rot : 0, x: 0, y: 0, valid: false, onCanvas: false };
      }
    } else if (!paletteDrag) {
      ghost = null;
    }
    requestRender();
  }

  /* ── 마우스/키보드 ── */
  function canvasPos(e: MouseEvent): Pt {
    const r = wrap.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function updateGhostPos(): void {
    if (!ghost) return;
    const fp = F(ghost.typeId).footprint;
    const d = ghost.rot % 180 === 0 ? { w: fp.w, h: fp.h } : { w: fp.h, h: fp.w };
    ghost.x = Math.round(mouseCell.x - d.w / 2);
    ghost.y = Math.round(mouseCell.y - d.h / 2);
    ghost.valid = canPlace(state.modules, ghost.typeId, ghost.x, ghost.y, ghost.rot, null);
  }

  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    requestRender();
    const p = canvasPos(e);
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const ns = Math.max(0.25, Math.min(3, view.scale * factor));
    const w = wOf(p.x, p.y);
    view.scale = ns;
    view.x = p.x - w.x * CELL * ns;
    view.y = p.y - w.y * CELL * ns;
    updateStatus();
  }, { passive: false });

  wrap.addEventListener('mousedown', (e) => {
    requestRender();
    const p = canvasPos(e);
    if (e.button === 1 || e.button === 2) {
      pan = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    mousePx = p;
    mouseCell = wOf(p.x, p.y);
    const w = mouseCell;

    // 배치 모드(팔레트 클릭으로 무장)
    if (armedType && ghost) {
      ghost.onCanvas = true;
      updateGhostPos();
      if (ghost.valid) {
        addModule(ghost.typeId, ghost.x, ghost.y, ghost.rot);
        if (!e.shiftKey) setArmed(null);
      } else {
        toast('겹치는 위치에는 배치할 수 없습니다');
      }
      return;
    }

    // 포트 클릭 → 연결 시작/완료
    const ph = hitPort(w);
    if (ph && ph.moduleId !== undefined && ph.port) {
      if (!pending) {
        pending = { moduleId: ph.moduleId, portKey: ph.port.key };
      } else {
        const sm = modById(pending.moduleId);
        const sp = sm ? portByKey(sm, pending.portKey) : null;
        if (sp && tryConnect({ moduleId: pending.moduleId, port: sp }, { moduleId: ph.moduleId, port: ph.port })) {
          pending = null;
        } else if (sp && pending.moduleId === ph.moduleId && pending.portKey === ph.port.key) {
          pending = null; // 같은 포트 다시 클릭 → 취소
        }
      }
      return;
    }

    // 모듈 클릭 → 선택 + 이동 시작
    const mh = hitModule(w);
    if (mh && mh.id !== undefined) {
      pending = null;
      selected = { kind: 'module', id: mh.id };
      const m = modById(mh.id)!;
      moveDrag = { id: m.id, offX: w.x - m.x, offY: w.y - m.y, origX: m.x, origY: m.y, moved: false };
      renderInfo();
      return;
    }

    // 연결선 클릭 → 선택
    const ch = hitConn(w);
    if (ch && ch.id !== undefined) {
      pending = null;
      selected = { kind: 'conn', id: ch.id };
      renderInfo();
      return;
    }

    pending = null;
    selected = null;
    renderInfo();
  });

  window.addEventListener('mousemove', (e) => {
    requestRender();
    const p = canvasPos(e);
    mousePx = p;
    mouseCell = wOf(p.x, p.y);
    const overCanvas = p.x >= 0 && p.y >= 0 && p.x <= wrap.clientWidth && p.y <= wrap.clientHeight;

    if (pan) {
      view.x = pan.vx + (e.clientX - pan.sx);
      view.y = pan.vy + (e.clientY - pan.sy);
      if (Math.abs(e.clientX - pan.sx) + Math.abs(e.clientY - pan.sy) > 3) pan.moved = true;
      return;
    }
    if (paletteDrag) {
      if (Math.abs(e.clientX - paletteDrag.startX) + Math.abs(e.clientY - paletteDrag.startY) > 4) paletteDrag.moved = true;
      if (ghost) { ghost.onCanvas = overCanvas; updateGhostPos(); }
      return;
    }
    if (armedType && ghost) {
      ghost.onCanvas = overCanvas;
      updateGhostPos();
    }
    if (moveDrag) {
      const m = modById(moveDrag.id);
      if (m) {
        const nx = Math.round(mouseCell.x - moveDrag.offX);
        const ny = Math.round(mouseCell.y - moveDrag.offY);
        if (nx !== m.x || ny !== m.y) {
          m.x = nx; m.y = ny;
          moveDrag.moved = true;
          recompute();
        }
      }
      return;
    }
    if (overCanvas) {
      hover = hitPort(mouseCell) ?? hitModule(mouseCell) ?? hitConn(mouseCell);
      updateTooltip(p);
    } else {
      hover = null;
      tooltip.style.display = 'none';
    }
  });

  window.addEventListener('mouseup', (e) => {
    requestRender();
    if (pan) { pan = null; return; }
    if (paletteDrag) {
      const p = canvasPos(e);
      const overCanvas = p.x >= 0 && p.y >= 0 && p.x <= wrap.clientWidth && p.y <= wrap.clientHeight;
      if (paletteDrag.moved && overCanvas && ghost) {
        updateGhostPos();
        if (ghost.valid) addModule(ghost.typeId, ghost.x, ghost.y, ghost.rot);
        else toast('겹치는 위치에는 배치할 수 없습니다');
        ghost = null;
        setArmed(null);
      } else if (!paletteDrag.moved) {
        // 클릭 → 배치 모드 무장 (Esc/우클릭 해제, Shift+클릭 연속 배치)
        setArmed(armedType === paletteDrag.typeId ? null : paletteDrag.typeId);
      } else {
        ghost = null;
        setArmed(null);
      }
      paletteDrag = null;
      return;
    }
    if (moveDrag) {
      const m = modById(moveDrag.id);
      if (m && moveDrag.moved) {
        if (!canPlace(state.modules, m.typeId, m.x, m.y, m.rot, m.id)) {
          m.x = moveDrag.origX;
          m.y = moveDrag.origY;
          toast('겹치는 위치에는 놓을 수 없습니다');
          recompute();
        } else {
          scheduleSave();
        }
      }
      moveDrag = null;
    }
  });

  wrap.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    requestRender();
    if (!pan || !pan.moved) {
      if (armedType || ghost || pending) {
        setArmed(null);
        ghost = null;
        pending = null;
      }
    }
  });

  window.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    requestRender();
    if (e.key === 'r' || e.key === 'R' || e.key === 'ㄱ') rotateTarget();
    else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
    else if (e.key === 'Escape') {
      setArmed(null);
      ghost = null;
      pending = null;
      selected = null;
      renderInfo();
    }
  });

  /* ── 툴팁 ── */
  function updateTooltip(p: Pt): void {
    if (!hover || moveDrag || paletteDrag || armedType) { tooltip.style.display = 'none'; return; }
    let html = '';
    if (hover.kind === 'port' && hover.port) {
      const label = hover.port.kind === 'output' ? '출력' : '입력';
      const res = hover.port.resource === 'any' ? '모든 리소스' : hover.port.resource;
      html = `<div class="tt-title">${label} 포트</div>${esc(res)} · ${hover.port.rate}/분<br><span class="dim">클릭해서 벨트/파이프 연결</span>`;
    } else if (hover.kind === 'module' && hover.id !== undefined) {
      const m = modById(hover.id);
      if (!m) return;
      const t = F(m.typeId);
      html = `<div class="tt-title">${t.icon ?? ''} ${esc(t.name)}</div>`;
      html += `<span class="dim">${esc(t.category)} · ${t.footprint.w}×${t.footprint.h}`;
      if (t.powerRange && t.powerRange > 0) html += ` · 범위 ${t.powerRange}m`;
      else if (t.powerDraw && t.powerDraw > 0) html += ` · 전력 ${t.powerDraw}`;
      html += `</span>`;
      if (t.inputs?.length) {
        html += `<br><span class="dim">입력:</span> ` + t.inputs.map((i) => `${esc(i.resource === 'any' ? '모든 리소스' : i.resource)} ${i.rate}/분`).join(', ');
      }
      if (t.outputs?.length) {
        html += `<br><span class="dim">출력:</span> ` + t.outputs.map((o) => `${esc(o.resource === 'any' ? '모든 리소스' : o.resource)} ${o.rate}/분`).join(', ');
      }
      if (powerInfo.unpowered.has(m.id)) html += `<br><span class="bad">⚡ 전력 범위 밖!</span>`;
      for (const w of flowInfo.modWarn[m.id] ?? []) html += `<br><span class="warn">⚠️ ${esc(w)}</span>`;
    } else if (hover.kind === 'conn' && hover.id !== undefined) {
      const c = state.connections.find((x) => x.id === hover!.id);
      if (!c) return;
      const flow = flowInfo.flows[c.id] ?? {};
      const entries = Object.entries(flow).filter(([, v]) => v > 1e-6);
      html = `<div class="tt-title">벨트/파이프</div>`;
      html += entries.length
        ? entries.map(([r, v]) => `${esc(r)} ${round1(v)}/분`).join('<br>')
        : `<span class="dim">흐름 없음</span>`;
      if (flowInfo.bottlenecks.has(c.id)) html += `<br><span class="warn">⚠️ 병목 구간 — 공급이 수요보다 부족</span>`;
    }
    tooltip.innerHTML = html;
    tooltip.style.display = 'block';
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    let tx = p.x + 16;
    let ty = p.y + 16;
    if (tx + tw > wrap.clientWidth - 8) tx = p.x - tw - 12;
    if (ty + th > wrap.clientHeight - 8) ty = p.y - th - 12;
    tooltip.style.left = `${tx}px`;
    tooltip.style.top = `${ty}px`;
  }

  /* ── 정보 패널 ── */
  function renderInfo(): void {
    const el = $('info');
    const legend = `
      <div class="legend">
        <span class="dot" style="background:var(--warn)"></span>출력 포트 &nbsp;
        <span class="dot" style="border:2px solid var(--ok); background:transparent"></span>입력 포트<br>
        <span style="color:var(--warn)">⚠️ 주황 벨트</span> = 병목(공급 &lt; 수요)<br>
        <span style="color:var(--danger)">⚡ 빨간 테두리</span> = 전력 범위 밖<br>
        노란 원 = 활성 전력 범위 · 점선 원 = 비활성(코어 미연결)
      </div>`;

    if (!selected) {
      el.innerHTML = `<div class="empty">
        설비나 벨트를 클릭하면 상세 정보가 표시됩니다.<br><br>
        <b>조작법</b><br>
        · 팔레트 드래그/클릭 → 배치<br>
        · <kbd>Shift</kbd>+클릭 배치 → 연속 배치<br>
        · <kbd>R</kbd> 회전 · <kbd>Del</kbd> 삭제 · <kbd>Esc</kbd> 취소<br>
        · 포트 ● 클릭 → 다른 포트 클릭으로 연결<br>
        · 휠 줌 · 우클릭/휠클릭 드래그 이동<br><br>
        설비 데이터는 <b>public/data/facilities.json</b>에서 직접 수정할 수 있습니다.
      </div>` + legend;
      return;
    }

    if (selected.kind === 'conn') {
      const c = state.connections.find((x) => x.id === selected!.id);
      if (!c) { selected = null; renderInfo(); return; }
      const fm = modById(c.fromModuleId)!;
      const tm = modById(c.toModuleId)!;
      const flow = flowInfo.flows[c.id] ?? {};
      const entries = Object.entries(flow).filter(([, v]) => v > 1e-6);
      el.innerHTML = `
        <h2>🛝 벨트/파이프</h2>
        <div class="sect"><div class="sect-title">구간</div>
          <div class="io-row"><span>${esc(F(fm.typeId).name)}</span><span>→</span><span>${esc(F(tm.typeId).name)}</span></div>
        </div>
        <div class="sect"><div class="sect-title">운반 흐름</div>
          ${entries.length
            ? entries.map(([r, v]) => `<div class="io-row"><span>${esc(r)}</span><span class="rate">${round1(v)}/분</span></div>`).join('')
            : '<div class="empty">흐름 없음</div>'}
        </div>
        ${flowInfo.bottlenecks.has(c.id) ? '<div class="warn-box">⚠️ 병목 구간입니다. 공급 라인을 추가하세요.</div>' : ''}
        <div class="btn-row"><button class="btn danger" id="btnDelConn">🗑 연결 삭제</button></div>
      ` + legend;
      $('btnDelConn').addEventListener('click', deleteSelected);
      return;
    }

    const m = modById(selected.id);
    if (!m) { selected = null; renderInfo(); return; }
    const t = F(m.typeId);
    const catColor = CAT_COLOR[t.category] ?? '#888';
    let html = `<h2>${t.icon ?? ''} ${esc(t.name)} <span class="chip" style="background:${catColor}">${esc(t.category)}</span></h2>
      <div style="color:var(--text-dim)">${t.footprint.w}×${t.footprint.h} · 회전 ${m.rot}° · 위치 (${m.x}, ${m.y})</div>`;
    if (t.powerRange && t.powerRange > 0) html += `<div style="color:var(--text-dim)">전력 공급 범위: ${t.powerRange}m${t.powerSource ? ' (전력원)' : ' (코어 연쇄 필요)'}</div>`;
    else if (t.powerDraw && t.powerDraw > 0) html += `<div style="color:var(--text-dim)">전력 소비량: ${t.powerDraw}</div>`;
    if (t.maxPerBase) html += `<div style="color:var(--text-dim)">최대 배치 ${t.maxPerBase}개 (연구로 확장)</div>`;

    if (t.inputs?.length) {
      html += `<div class="sect"><div class="sect-title">입력 (수요)</div>`;
      t.inputs.forEach((inp, i) => {
        const ics = flowInfo.inByPort[`${m.id}|in:${i}`] ?? [];
        let supply = 0;
        for (const ic of ics) {
          const f = flowInfo.flows[ic.id] ?? {};
          supply += inp.resource === 'any'
            ? Object.values(f).reduce((a, b) => a + b, 0)
            : f[inp.resource] ?? 0;
        }
        const short = ics.length > 0 && inp.resource !== 'any' && supply < inp.rate - 1e-6;
        const supplyTxt = ics.length ? ` (공급 ${round1(supply)})` : ' (미연결)';
        html += `<div class="io-row ${short ? 'short' : ''}">
          <span>${esc(inp.resource === 'any' ? '모든 리소스' : inp.resource)}</span>
          <span class="rate">${inp.rate}/분${supplyTxt}</span></div>`;
      });
      html += `</div>`;
    }
    if (t.outputs?.length) {
      html += `<div class="sect"><div class="sect-title">출력 (생산)</div>`;
      for (const o of t.outputs) {
        html += `<div class="io-row"><span>${esc(o.resource === 'any' ? '모든 리소스' : o.resource)}</span><span class="rate">${o.rate}/분</span></div>`;
      }
      html += `</div>`;
    }
    if (t.note) html += `<div class="note-box">💡 ${esc(t.note)}</div>`;
    if (powerInfo.unpowered.has(m.id)) html += `<div class="danger-box">⚡ 전력 범위 밖입니다. 중계기/전력 공급기를 근처에 배치하세요.</div>`;
    for (const w of flowInfo.modWarn[m.id] ?? []) html += `<div class="warn-box">⚠️ ${esc(w)}</div>`;
    html += `<div class="btn-row">
      <button class="btn" id="btnRotSel">↻ 회전</button>
      <button class="btn danger" id="btnDelSel">🗑 삭제</button>
    </div>` + legend;
    el.innerHTML = html;
    $('btnRotSel').addEventListener('click', rotateTarget);
    $('btnDelSel').addEventListener('click', deleteSelected);
  }

  /* ── 상태 바 ── */
  function updateStatus(): void {
    const nWarn = Object.keys(flowInfo.modWarn).length;
    const nUnpow = powerInfo.unpowered.size;
    let html = `<span>설비 <b>${state.modules.length}</b></span><span>연결 <b>${state.connections.length}</b></span>`;
    if (nWarn) html += `<span class="w-belt">⚠️ 병목 ${nWarn}</span>`;
    if (nUnpow) html += `<span class="w-power">⚡ 전력 부족 ${nUnpow}</span>`;
    if (!powerInfo.hasSource && state.modules.some((m) => (F(m.typeId).powerDraw ?? 0) > 0)) {
      html += `<span>전력원(프로토콜 코어) 없음 — 전력 검사 생략</span>`;
    }
    html += `<span style="margin-left:auto">줌 ${Math.round(view.scale * 100)}%</span>`;
    $('statusbar').innerHTML = html;
    $('hint').style.display = state.modules.length ? 'none' : 'block';
  }

  /* ── 툴바 ── */
  $('btnRotate').addEventListener('click', rotateTarget);
  $('btnDelete').addEventListener('click', deleteSelected);
  $('btnClear').addEventListener('click', () => {
    if (!state.modules.length || confirm('배치를 모두 지울까요?')) {
      state.modules = [];
      state.connections = [];
      state.nextId = 1;
      selected = null;
      pending = null;
      recompute();
      scheduleSave();
    }
  });
  $('btnExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(serialize(state), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    a.download = `endfield-layout-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('btnImport').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const skipped = deserializeInto(state, JSON.parse(await file.text()));
      selected = null;
      pending = null;
      if (skipped) toast(`알 수 없는 항목 ${skipped}개는 건너뛰었습니다`);
      else toast('레이아웃을 불러왔습니다');
      recompute();
      scheduleSave();
    } catch (err) {
      toast(`가져오기 실패: ${(err as Error).message}`);
    }
    input.value = '';
  });
  $('btnShare').addEventListener('click', async () => {
    if (!state.modules.length) { toast('공유할 배치가 없습니다'); return; }
    const base = location.origin === 'null' || location.protocol === 'file:'
      ? location.href.split('#')[0]
      : location.origin + location.pathname;
    const link = base + encodeShareHash(state);
    try {
      await navigator.clipboard.writeText(link);
      toast('공유 URL이 클립보드에 복사되었습니다');
    } catch {
      prompt('아래 URL을 복사하세요', link);
    }
  });
  $('btnTheme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    $('btnTheme').textContent = next === 'dark' ? '🌙' : '☀️';
    try { localStorage.setItem(LS_THEME, next); } catch { /* 무시 */ }
    requestRender();
  });

  /* ── 초기화 ── */
  function tryLoadFromHash(): boolean {
    let data;
    try {
      data = decodeShareHash(location.hash);
    } catch {
      toast('공유 URL 해석에 실패했습니다');
      return false;
    }
    if (!data) return false;
    try {
      const skipped = deserializeInto(state, data);
      selected = null;
      pending = null;
      if (skipped) toast(`알 수 없는 항목 ${skipped}개는 건너뛰었습니다`);
      else toast('공유 URL에서 레이아웃을 불러왔습니다');
      history.replaceState(null, '', location.pathname + location.search);
      recompute();
      scheduleSave();
      return true;
    } catch {
      toast('공유 URL 해석에 실패했습니다');
      return false;
    }
  }

  initEditor({
    isTypeInUse: (typeId) => state.modules.some((m) => m.typeId === typeId),
    onCatalogChanged: () => {
      // 카탈로그 변경 후: 사라진 타입의 모듈, 유효하지 않은 포트를 참조하는 연결 정리
      state.modules = state.modules.filter((m) => F(m.typeId));
      state.connections = state.connections.filter((c) => {
        const fm = modById(c.fromModuleId);
        const tm = modById(c.toModuleId);
        return !!(fm && tm && portByKey(fm, c.fromPort) && portByKey(tm, c.toPort));
      });
      if (selected?.kind === 'module' && !modById(selected.id)) selected = null;
      buildPalette();
      recompute();
      scheduleSave();
    },
    toast,
  });

  const theme = (() => { try { return localStorage.getItem(LS_THEME); } catch { return null; } })() ?? 'dark';
  document.documentElement.dataset.theme = theme;
  $('btnTheme').textContent = theme === 'dark' ? '🌙' : '☀️';

  buildPalette();
  resize();
  // 탭이 백그라운드 등으로 아직 레이아웃되지 않았으면(크기 0) 첫 리사이즈 때 원점을 화면 중앙으로
  let viewCentered = false;
  function centerViewIfNeeded(): void {
    if (viewCentered || !wrap.clientWidth) return;
    view.x = wrap.clientWidth / 2;
    view.y = wrap.clientHeight / 2;
    viewCentered = true;
  }
  centerViewIfNeeded();

  if (!tryLoadFromHash()) {
    const saved = loadLocal();
    if (saved) {
      try { deserializeInto(state, saved); } catch (e) { console.warn('저장 데이터 복원 실패', e); }
    }
  }
  recompute();
  new ResizeObserver(() => { resize(); centerViewIfNeeded(); render(); }).observe(wrap);
  window.addEventListener('hashchange', () => { tryLoadFromHash(); });
  requestRender();
}
