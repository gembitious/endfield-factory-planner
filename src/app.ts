import { CATALOG, CAT_COLOR, F } from './catalog';
import { initEditor } from './editor';
import { computeFlows } from './flows';
import {
  canPlace, dims, distToSeg, getPorts, moduleRect, portByKey, portDef,
} from './geometry';
import type { Pt } from './geometry';
import { computeRoutes, emptyRouteInfo, portAnchor, rectBlockedByRoutes, routeThrough } from './routing';
import type { RouteInfo } from './routing';
import {
  LS_THEME, decodeShareHash, deserializeInto, encodeShareHash, loadLocal, saveLocal, serialize,
} from './persist';
import { activeRecipe, clearIoCache, resolveIo } from './recipes';
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
  let pending: { moduleId: number; portKey: string; waypoints: { x: number; y: number }[] } | null = null;
  let mouseCell: Pt = { x: 0, y: 0 };
  let mousePx: Pt = { x: 0, y: 0 };

  let powerInfo: PowerInfo = { nodes: [], unpowered: new Set(), hasSource: false };
  let flowInfo: FlowInfo = { flows: {}, bottlenecks: new Set(), modWarn: {}, inByPort: {} };
  let routeInfo: RouteInfo = emptyRouteInfo();

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
    routeInfo = computeRoutes(state);
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
      const fp = F(m.typeId).footprint;
      const nd = nr % 180 === 0 ? { w: fp.w, h: fp.h } : { w: fp.h, h: fp.w };
      if (canPlace(state.modules, m.typeId, m.x, m.y, nr, m.id)
        && !rectBlockedByRoutes(routeInfo, state, { x: m.x, y: m.y, w: nd.w, h: nd.h }, m.id)) {
        m.rot = nr;
        recompute();
        scheduleSave();
      } else {
        toast('회전하면 다른 설비 또는 벨트/파이프와 겹칩니다');
      }
    }
  }
  function tryConnect(
    a: { moduleId: number; port: PortInfo },
    b: { moduleId: number; port: PortInfo },
    waypoints: { x: number; y: number }[] = [],
  ): boolean {
    let from: typeof a; let to: typeof a;
    if (a.port.kind === 'output' && b.port.kind === 'input') { from = a; to = b; }
    else if (a.port.kind === 'input' && b.port.kind === 'output') { from = b; to = a; }
    else { toast('출력(●) 포트와 입력(○) 포트를 연결해야 합니다'); return false; }
    if (from.moduleId === to.moduleId) { toast('같은 설비끼리는 연결할 수 없습니다'); return false; }
    const tpOut = from.port.transport ?? 'belt';
    const tpIn = to.port.transport ?? 'belt';
    if (tpOut !== tpIn) {
      toast('운송 종류 불일치: 벨트 포트끼리, 파이프 포트끼리만 연결할 수 있습니다');
      return false;
    }
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
    // 경유지는 출력 포트 기준 순서로 저장 (입력 포트부터 그렸다면 뒤집기)
    const wp = a.port.kind === 'output' ? waypoints : [...waypoints].reverse();
    const conn = {
      id: state.nextId++,
      fromModuleId: from.moduleId, fromPort: from.port.key,
      toModuleId: to.moduleId, toPort: to.port.key,
      ...(wp.length ? { waypoints: wp } : {}),
    };
    state.connections.push(conn);
    recompute();
    if (routeInfo.unrouted.has(conn.id)) {
      // 설비/기존 라인에 막혀 경로가 없으면 연결 자체를 취소
      state.connections = state.connections.filter((c) => c.id !== conn.id);
      recompute();
      toast('경로를 찾을 수 없습니다 — 경유지를 조정하거나 공간을 확보하세요');
      return false;
    }
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
  function connPoly(c: { id: number; fromModuleId: number; fromPort: string; toModuleId: number; toPort: string }): Pt[] | null {
    const poly = routeInfo.polys.get(c.id);
    if (poly) return poly;
    // 경로 실패 시 포트 간 직선 (빨간 점선 표시용)
    const fm = modById(c.fromModuleId);
    const tm = modById(c.toModuleId);
    if (!fm || !tm) return null;
    const a = portByKey(fm, c.fromPort);
    const b = portByKey(tm, c.toPort);
    return a && b ? [{ x: a.x, y: a.y }, { x: b.x, y: b.y }] : null;
  }
  function hitConn(wpt: Pt): Hover | null {
    const tol = Math.max(0.3, 7 / (CELL * view.scale));
    for (const c of state.connections) {
      const pts = connPoly(c);
      if (!pts) continue;
      for (let i = 0; i < pts.length - 1; i++) {
        if (distToSeg(wpt, pts[i], pts[i + 1]) <= tol) return { kind: 'conn', id: c.id };
      }
    }
    return null;
  }

  /* ── 이미지 캐시 (설비 썸네일) ── */
  const imgCache = new Map<string, HTMLImageElement>();
  function getImage(src: string): HTMLImageElement | null {
    let img = imgCache.get(src);
    if (!img) {
      img = new Image();
      img.src = import.meta.env.BASE_URL + src;
      img.onload = () => requestRender();
      imgCache.set(src, img);
    }
    return img.complete && img.naturalWidth > 0 ? img : null;
  }

  /* ── 렌더링 (필요 시에만 다시 그리기) ── */
  let renderQueued = false;
  function requestRender(): void {
    if (renderQueued) return;
    renderQueued = true;
    const run = () => { renderQueued = false; render(); };
    // 숨겨진 탭에서는 rAF가 멈추므로 setTimeout으로 폴백 (복귀 시 빈 화면 방지)
    if (document.hidden) setTimeout(run, 32);
    else requestAnimationFrame(run);
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
  function connTransport(c: { fromModuleId: number; fromPort: string }): 'belt' | 'pipe' {
    const m = modById(c.fromModuleId);
    return (m && portDef(m, c.fromPort)?.transport) ?? 'belt';
  }
  function drawConnections(): void {
    const s = CELL * view.scale;
    for (const c of state.connections) {
      const pts = connPoly(c);
      if (!pts) continue;
      const routed = !!routeInfo.polys.get(c.id);
      const isBottleneck = flowInfo.bottlenecks.has(c.id);
      const isSel = selected?.kind === 'conn' && selected.id === c.id;
      const isHover = hover?.kind === 'conn' && hover.id === c.id;
      const isPipe = connTransport(c) === 'pipe';
      const color = !routed ? cssVar('--danger')
        : isSel ? cssVar('--accent')
        : isBottleneck ? cssVar('--warn')
        : isHover ? cssVar('--text')
        : isPipe ? cssVar('--pipe') : cssVar('--belt');

      const trace = (): void => {
        ctx.beginPath();
        pts.forEach((p, i) => {
          const sp = sOf(p.x, p.y);
          if (i) ctx.lineTo(sp.x, sp.y); else ctx.moveTo(sp.x, sp.y);
        });
        ctx.stroke();
      };
      ctx.lineJoin = 'round';
      ctx.lineCap = 'butt';
      if (!routed) {
        // 경로 실패: 빨간 점선 직선
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;
        ctx.setLineDash([6, 5]);
        trace();
        ctx.setLineDash([]);
      } else {
        // 셀을 점유하는 두께로 그리기 (외곽 어두운 테두리 + 본체)
        const bodyW = isPipe ? Math.max(3, s * 0.26) : Math.max(4, s * 0.42);
        ctx.globalAlpha = 0.92;
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = bodyW + Math.max(2, s * 0.07);
        trace();
        ctx.strokeStyle = color;
        ctx.lineWidth = bodyW;
        trace();
        // 벨트 진행 방향 화살표(칸 간격마다)
        if (s > 14) {
          ctx.fillStyle = 'rgba(0,0,0,0.45)';
          for (let i = 1; i < pts.length - 1; i++) {
            const a0 = pts[i];
            const b0 = pts[i + 1];
            if (i % 2 && (a0.x !== b0.x || a0.y !== b0.y)) {
              const sp = sOf((a0.x + b0.x) / 2, (a0.y + b0.y) / 2);
              const ang = Math.atan2(b0.y - a0.y, b0.x - a0.x);
              const L = bodyW * 0.55;
              ctx.beginPath();
              ctx.moveTo(sp.x + L * Math.cos(ang), sp.y + L * Math.sin(ang));
              ctx.lineTo(sp.x + L * Math.cos(ang + 2.4), sp.y + L * Math.sin(ang + 2.4));
              ctx.lineTo(sp.x + L * Math.cos(ang - 2.4), sp.y + L * Math.sin(ang - 2.4));
              ctx.closePath();
              ctx.fill();
            }
          }
        }
        ctx.globalAlpha = 1;
      }
      // 종점 화살표
      const b = sOf(pts[pts.length - 1].x, pts[pts.length - 1].y);
      const a = sOf(pts[pts.length - 2].x, pts[pts.length - 2].y);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const L = Math.max(7, s * 0.28);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - L * Math.cos(ang - 0.5), b.y - L * Math.sin(ang - 0.5));
      ctx.lineTo(b.x - L * Math.cos(ang + 0.5), b.y - L * Math.sin(ang + 0.5));
      ctx.closePath();
      ctx.fill();
      if (isBottleneck || !routed) {
        const mid = pts[Math.floor(pts.length / 2)];
        const ms = sOf(mid.x, mid.y);
        ctx.font = '13px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(routed ? '⚠️' : '🚫', ms.x, ms.y - 10);
      }
      // 선택된 연결의 경유지 표시
      if (isSel && c.waypoints?.length) {
        for (const wpt of c.waypoints) {
          const cp = sOf(wpt.x + 0.5, wpt.y + 0.5);
          ctx.beginPath();
          ctx.arc(cp.x, cp.y, Math.max(3, s * 0.14), 0, Math.PI * 2);
          ctx.fillStyle = cssVar('--accent');
          ctx.fill();
        }
      }
    }
    // 교차 브리지 (직선×직선 교차 칸에 자동 생성)
    for (const br of routeInfo.bridges) {
      const cpt = sOf(br.x + 0.5, br.y + 0.5);
      const half = s * 0.32;
      ctx.fillStyle = cssVar('--bg-canvas');
      ctx.strokeStyle = br.transport === 'pipe' ? cssVar('--pipe') : cssVar('--belt');
      ctx.lineWidth = 2;
      roundRect(cpt.x - half, cpt.y - half, half * 2, half * 2, Math.min(4, half * 0.4));
      ctx.fill();
      ctx.stroke();
      // 위로 지나가는 방향 표시(수평선)
      ctx.beginPath();
      ctx.moveTo(cpt.x - half * 0.7, cpt.y);
      ctx.lineTo(cpt.x + half * 0.7, cpt.y);
      ctx.stroke();
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
      const nameShown = view.scale > 0.7 && Math.min(d.w, d.h) > 1;
      const img = t.image ? getImage(t.image) : null;
      if (img) {
        const size = Math.min(w, h) * (nameShown ? 0.62 : 0.78);
        if (size > 10) {
          ctx.drawImage(img, p0.x + (w - size) / 2, p0.y + (h - size) / 2 - (nameShown ? h * 0.07 : 0), size, size);
        }
      } else {
        const iconSize = Math.min(w, h) * 0.42;
        if (iconSize > 8) {
          ctx.font = `${iconSize}px sans-serif`;
          ctx.fillText(t.icon ?? '■', p0.x + w / 2, p0.y + h / 2 - (nameShown ? h * 0.08 : 0));
        }
      }
      if (nameShown) {
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
          // 벨트 포트 = 원, 파이프 포트 = 마름모
          const portShape = (rad: number) => {
            ctx.beginPath();
            if (port.transport === 'pipe') {
              ctx.moveTo(sp.x, sp.y - rad * 1.25);
              ctx.lineTo(sp.x + rad * 1.25, sp.y);
              ctx.lineTo(sp.x, sp.y + rad * 1.25);
              ctx.lineTo(sp.x - rad * 1.25, sp.y);
              ctx.closePath();
            } else {
              ctx.arc(sp.x, sp.y, rad, 0, Math.PI * 2);
            }
          };
          portShape(r);
          if (port.kind === 'output') {
            ctx.fillStyle = port.transport === 'pipe' ? cssVar('--pipe') : cssVar('--warn');
            ctx.fill();
          } else {
            ctx.fillStyle = cssVar('--bg-canvas');
            ctx.fill();
            ctx.strokeStyle = port.transport === 'pipe' ? cssVar('--pipe') : cssVar('--ok');
            ctx.lineWidth = 2;
            ctx.stroke();
          }
          const isPortHover = hover?.kind === 'port' && hover.moduleId === m.id && hover.port?.key === port.key;
          if (isPendingStart || isPortHover) {
            portShape(r + 3);
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
    const A = portAnchor(m, pending.portKey);
    if (!p || !A) { pending = null; return; }
    const s = CELL * view.scale;
    const isPipe = (p.transport ?? 'belt') === 'pipe';
    const occ = isPipe ? routeInfo.pipeUse : routeInfo.beltUse;

    // 커서 위치까지의 실시간 경로 미리보기 (경유지 경유)
    const target = { x: Math.floor(mouseCell.x), y: Math.floor(mouseCell.y) };
    const cells = routeThrough(A, { cell: target, axis: null }, pending.waypoints, routeInfo.blocked, occ);

    if (cells) {
      const pts: Pt[] = [A.point, ...cells.map((c) => ({ x: c.x + 0.5, y: c.y + 0.5 }))];
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = isPipe ? cssVar('--pipe') : cssVar('--belt');
      ctx.lineWidth = isPipe ? Math.max(3, s * 0.26) : Math.max(4, s * 0.42);
      ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach((pt, i) => {
        const sp = sOf(pt.x, pt.y);
        if (i) ctx.lineTo(sp.x, sp.y); else ctx.moveTo(sp.x, sp.y);
      });
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else {
      // 현재 커서까지는 경로 불가 → 빨간 점선 안내
      const a = sOf(p.x, p.y);
      ctx.strokeStyle = cssVar('--danger');
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(mousePx.x, mousePx.y); ctx.stroke();
      ctx.setLineDash([]);
    }
    // 경유지 마커
    for (const wpt of pending.waypoints) {
      const c = sOf(wpt.x + 0.5, wpt.y + 0.5);
      const r = Math.max(3, s * 0.14);
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fillStyle = cssVar('--accent');
      ctx.fill();
    }
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
    const gimg = t.image ? getImage(t.image) : null;
    if (gimg) {
      const size = Math.min(d.w * s, d.h * s) * 0.7;
      ctx.drawImage(gimg, p0.x + (d.w * s - size) / 2, p0.y + (d.h * s - size) / 2, size, size);
    } else {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `${Math.min(d.w, d.h) * s * 0.4}px sans-serif`;
      ctx.fillText(t.icon ?? '■', p0.x + (d.w * s) / 2, p0.y + (d.h * s) / 2);
    }
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
        const iconHtml = f.image
          ? `<img class="pal-icon-img" src="${esc(import.meta.env.BASE_URL + f.image)}" alt="">`
          : `<span class="pal-icon">${f.icon ?? '■'}</span>`;
        el.innerHTML = `${iconHtml}
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
    ghost.valid = canPlace(state.modules, ghost.typeId, ghost.x, ghost.y, ghost.rot, null)
      && !rectBlockedByRoutes(routeInfo, state, { x: ghost.x, y: ghost.y, w: d.w, h: d.h }, null);
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
        pending = { moduleId: ph.moduleId, portKey: ph.port.key, waypoints: [] };
      } else if (pending.moduleId === ph.moduleId && pending.portKey === ph.port.key) {
        pending = null; // 같은 포트 재클릭 → 취소
      } else {
        const sm = modById(pending.moduleId);
        const sp = sm ? portByKey(sm, pending.portKey) : null;
        if (sp && tryConnect({ moduleId: pending.moduleId, port: sp }, { moduleId: ph.moduleId, port: ph.port }, pending.waypoints)) {
          pending = null; // 성공 시에만 종료 — 실패하면 그리던 경로 유지
        }
      }
      return;
    }

    // 연결 그리는 중: 클릭한 칸을 경유지로 추가
    if (pending) {
      const cell = { x: Math.floor(w.x), y: Math.floor(w.y) };
      if (hitModule(w)) {
        toast('설비 위로는 지나갈 수 없습니다 — 포트를 클릭해 연결을 끝내세요');
        return;
      }
      const last = pending.waypoints[pending.waypoints.length - 1];
      if (!last || last.x !== cell.x || last.y !== cell.y) pending.waypoints.push(cell);
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
        if (!canPlace(state.modules, m.typeId, m.x, m.y, m.rot, m.id)
          || rectBlockedByRoutes(routeInfo, state, moduleRect(m), m.id)) {
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
    else if (e.key === 'Backspace' && pending) {
      // 그리는 중: 마지막 경유지 취소 (없으면 그리기 자체를 취소)
      if (pending.waypoints.length) pending.waypoints.pop();
      else pending = null;
    } else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
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
      const tp = hover.port.transport === 'pipe' ? '파이프' : '벨트';
      const res = hover.port.resource === 'any' ? '모든 리소스' : hover.port.resource;
      html = `<div class="tt-title">${label} 포트 (${tp})</div>${esc(res)} · ${hover.port.rate}/분<br><span class="dim">클릭 후 빈 칸을 찍어 경로를 그리고, 반대 포트 클릭으로 완성</span>`;
    } else if (hover.kind === 'module' && hover.id !== undefined) {
      const m = modById(hover.id);
      if (!m) return;
      const t = F(m.typeId);
      html = `<div class="tt-title">${t.icon ?? ''} ${esc(t.name)}</div>`;
      html += `<span class="dim">${esc(t.category)} · ${t.footprint.w}×${t.footprint.h}`;
      if (t.powerRange && t.powerRange > 0) html += ` · 범위 ${t.powerRange}m`;
      else if (t.powerDraw && t.powerDraw > 0) html += ` · 전력 ${t.powerDraw}`;
      html += `</span>`;
      const rec = activeRecipe(m);
      if (rec) html += `<br><span class="dim">레시피:</span> ${esc(rec.name)}`;
      const ioTxt = (arr: { resource: string; rate: number; transport?: string }[] | undefined) => {
        const seen = new Map<string, { n: number; p: { resource: string; rate: number; transport?: string } }>();
        for (const p of arr ?? []) {
          const k = `${p.resource}|${p.transport ?? 'belt'}`;
          const e = seen.get(k);
          if (e) e.n++;
          else seen.set(k, { n: 1, p });
        }
        return [...seen.values()].map(({ n, p }) =>
          `${esc(p.resource === 'any' ? '자유 포트' : p.resource)}${p.transport === 'pipe' ? '💧' : ''}${n > 1 ? `×${n}` : ''}${p.resource === 'any' ? '' : ` ${p.rate}/분`}`).join(', ');
      };
      const mio = resolveIo(m);
      if (mio.inputs.length) html += `<br><span class="dim">입력:</span> ` + ioTxt(mio.inputs);
      if (mio.outputs.length) html += `<br><span class="dim">출력:</span> ` + ioTxt(mio.outputs);
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
        원형 포트/회색 실선 = 벨트 · <span style="color:var(--pipe)">마름모 포트/청록 점선 = 파이프💧</span><br>
        <span style="color:var(--warn)">⚠️ 주황 연결</span> = 병목(공급 &lt; 수요)<br>
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
        · 포트 클릭 → <b>빈 칸을 클릭할 때마다 경유지 추가</b> →<br>
        &nbsp;&nbsp;반대 포트 클릭으로 연결 완성<br>
        · 그리는 중 <kbd>Backspace</kbd> = 경유지 되돌리기<br>
        · 경유지 없이 포트→포트 클릭 = 자동 경로<br>
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
      const isPipeConn = connTransport(c) === 'pipe';
      const cellCount = routeInfo.cells.get(c.id)?.length ?? null;
      el.innerHTML = `
        <h2>${isPipeConn ? '🧪 파이프' : '🛝 컨베이어 벨트'}</h2>
        <div class="sect"><div class="sect-title">구간</div>
          <div class="io-row"><span>${esc(F(fm.typeId).name)}</span><span>→</span><span>${esc(F(tm.typeId).name)}</span></div>
          <div class="io-row"><span>점유 길이</span><span class="rate">${cellCount !== null ? `${cellCount}칸` : '경로 없음'}</span></div>
          <div class="io-row"><span>경유지</span><span class="rate">${c.waypoints?.length ? `${c.waypoints.length}개 (수동 경로)` : '없음 (자동 경로)'}</span></div>
        </div>
        <div class="sect"><div class="sect-title">운반 흐름</div>
          ${entries.length
            ? entries.map(([r, v]) => `<div class="io-row"><span>${esc(r)}</span><span class="rate">${round1(v)}/분</span></div>`).join('')
            : '<div class="empty">흐름 없음</div>'}
        </div>
        ${flowInfo.bottlenecks.has(c.id) ? '<div class="warn-box">⚠️ 병목 구간입니다. 공급 라인을 추가하세요.</div>' : ''}
        ${routeInfo.unrouted.has(c.id) ? '<div class="danger-box">🚫 경로를 찾지 못했습니다. 주변 설비/라인을 옮겨 공간을 확보하세요.</div>' : ''}
        <div class="btn-row"><button class="btn danger" id="btnDelConn">🗑 연결 삭제</button></div>
      ` + legend;
      $('btnDelConn').addEventListener('click', deleteSelected);
      return;
    }

    const m = modById(selected.id);
    if (!m) { selected = null; renderInfo(); return; }
    const t = F(m.typeId);
    const catColor = CAT_COLOR[t.category] ?? '#888';
    const infoIcon = t.image
      ? `<img class="info-icon" src="${esc(import.meta.env.BASE_URL + t.image)}" alt="">`
      : (t.icon ?? '');
    let html = `<h2>${infoIcon} ${esc(t.name)} <span class="chip" style="background:${catColor}">${esc(t.category)}</span></h2>
      <div style="color:var(--text-dim)">${t.footprint.w}×${t.footprint.h} · 회전 ${m.rot}° · 위치 (${m.x}, ${m.y})</div>`;
    if (t.powerRange && t.powerRange > 0) html += `<div style="color:var(--text-dim)">전력 공급 범위: ${t.powerRange}m${t.powerSource ? ' (전력원)' : ' (코어 연쇄 필요)'}</div>`;
    else if (t.powerDraw && t.powerDraw > 0) html += `<div style="color:var(--text-dim)">전력 소비량: ${t.powerDraw}</div>`;
    if (t.maxPerBase) html += `<div style="color:var(--text-dim)">최대 배치 ${t.maxPerBase}개 (연구로 확장)</div>`;

    // 레시피 선택
    const act = activeRecipe(m);
    if (t.recipes?.length && act) {
      html += `<div class="sect"><div class="sect-title">레시피 (${t.recipes.length}종)</div>
        <select id="recipeSel" class="recipe-sel">${t.recipes.map((r) =>
          `<option value="${esc(r.id)}" ${r.id === act.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>
        ${act.note ? `<div class="note-box">💡 ${esc(act.note)}</div>` : ''}</div>`;
    }

    // 같은 리소스의 여러 포트 = 병렬 레인 → 리소스 단위로 묶어 표시
    interface IoGroup { resource: string; rate: number; transport?: string; portIdx: number[] }
    const groupIo = (arr: typeof t.inputs): IoGroup[] => {
      const gs: IoGroup[] = [];
      (arr ?? []).forEach((p, i) => {
        const key = `${p.resource}|${p.transport ?? 'belt'}`;
        const g = gs.find((x) => `${x.resource}|${x.transport ?? 'belt'}` === key);
        if (g) g.portIdx.push(i);
        else gs.push({ resource: p.resource, rate: p.rate, transport: p.transport, portIdx: [i] });
      });
      return gs;
    };
    const io = resolveIo(m);
    if (io.inputs.length) {
      html += `<div class="sect"><div class="sect-title">입력 (수요)</div>`;
      for (const g of groupIo(io.inputs)) {
        const ics = g.portIdx.flatMap((i) => flowInfo.inByPort[`${m.id}|in:${i}`] ?? []);
        let supply = 0;
        for (const ic of ics) {
          const f = flowInfo.flows[ic.id] ?? {};
          supply += g.resource === 'any'
            ? Object.values(f).reduce((a, b) => a + b, 0)
            : (f[g.resource] ?? 0) + (f.any ?? 0);
        }
        const label = g.resource === 'any' ? '자유 입력' : g.resource;
        const ports = g.portIdx.length > 1 ? ` ×${g.portIdx.length}` : '';
        if (g.resource === 'any') {
          html += `<div class="io-row"><span>${esc(label)}${g.transport === 'pipe' ? ' 💧' : ''}${ports}</span>
            <span class="rate">${ics.length ? `유입 ${round1(supply)}/분` : '미연결'}</span></div>`;
          continue;
        }
        const short = ics.length > 0 && supply < g.rate - 1e-6;
        const supplyTxt = ics.length ? ` (공급 ${round1(supply)})` : ' (미연결)';
        html += `<div class="io-row ${short ? 'short' : ''}">
          <span>${esc(label)}${g.transport === 'pipe' ? ' 💧' : ''}${ports}</span>
          <span class="rate">${g.rate}/분${supplyTxt}</span></div>`;
      }
      html += `</div>`;
    }
    if (io.outputs.length) {
      html += `<div class="sect"><div class="sect-title">출력 (생산)</div>`;
      for (const g of groupIo(io.outputs)) {
        const label = g.resource === 'any' ? '자유 출력' : g.resource;
        const ports = g.portIdx.length > 1 ? ` ×${g.portIdx.length}` : '';
        const rateTxt = g.resource === 'any'
          ? (g.rate > 0 ? `포트당 최대 ${g.rate}/분` : '—')
          : `${g.rate}/분`;
        html += `<div class="io-row"><span>${esc(label)}${g.transport === 'pipe' ? ' 💧' : ''}${ports}</span><span class="rate">${rateTxt}</span></div>`;
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
    const sel = document.getElementById('recipeSel') as HTMLSelectElement | null;
    if (sel) {
      sel.addEventListener('change', () => {
        m.recipeId = sel.value;
        recompute();
        scheduleSave();
      });
    }
  }

  /* ── 상태 바 ── */
  function updateStatus(): void {
    const nWarn = Object.keys(flowInfo.modWarn).length;
    const nUnpow = powerInfo.unpowered.size;
    let html = `<span>설비 <b>${state.modules.length}</b></span><span>연결 <b>${state.connections.length}</b></span>`;
    if (nWarn) html += `<span class="w-belt">⚠️ 병목 ${nWarn}</span>`;
    if (nUnpow) html += `<span class="w-power">⚡ 전력 부족 ${nUnpow}</span>`;
    if (routeInfo.unrouted.size) html += `<span class="w-power">🚫 경로 없음 ${routeInfo.unrouted.size}</span>`;
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
      // 카탈로그 변경 후: 캐시 무효화, 사라진 타입/레시피/포트 정리
      clearIoCache();
      state.modules = state.modules.filter((m) => F(m.typeId));
      state.modules.forEach((mm) => {
        if (mm.recipeId && !F(mm.typeId).recipes?.some((r) => r.id === mm.recipeId)) mm.recipeId = undefined;
      });
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
