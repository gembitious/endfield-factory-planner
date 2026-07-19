import { DIRV, moduleRect, portByKey, portDef } from './geometry';
import type { Pt } from './geometry';
import type { LayoutState, ModuleInst, Transport } from './types';

/**
 * 벨트/파이프 셀 점유 라우팅.
 * - 연결선은 그리드 칸을 실제로 점유하며 설비·같은 종류의 기존 라인을 피해 경로를 찾는다.
 * - 사용자가 클릭한 경유 칸(waypoints)을 순서대로 지나도록 구간별로 경로를 이어 붙인다.
 *   경유지가 없으면 자동 최단 경로.
 * - 같은 종류(벨트끼리/파이프끼리)는 직선×직선 수직 교차만 허용 — 교차 칸에 브리지가 자동 표시된다.
 *   (꺾이는 모서리 칸에서는 교차 불가 — 실게임 물류 브리지 규칙)
 * - 벨트와 파이프는 서로 겹칠 수 있다 (파이프는 높이가 낮은 설비와 겹침 가능 규칙의 단순화).
 * - 설비는 벨트/파이프가 점유한 칸 위에 배치할 수 없다.
 */

export type Axis = 'h' | 'v';
const bit = (a: Axis): number => (a === 'h' ? 1 : 2);
const cellKey = (x: number, y: number): string => `${x},${y}`;

export interface CellUse {
  bits: number; // 1=수평, 2=수직, 3=둘 다(모서리 또는 교차)
  conns: Set<number>;
}

export interface RouteInfo {
  /** connId → 포트 스텁을 포함한 전체 폴리라인(월드 좌표). 경로 실패 시 null */
  polys: Map<number, Pt[] | null>;
  /** connId → 점유한 셀 목록. 경로 실패 시 null */
  cells: Map<number, { x: number; y: number }[] | null>;
  beltUse: Map<string, CellUse>;
  pipeUse: Map<string, CellUse>;
  bridges: { x: number; y: number; transport: Transport }[];
  unrouted: Set<number>;
  /** 설비가 점유한 칸 (프리뷰 재사용) */
  blocked: Set<string>;
}

export function emptyRouteInfo(): RouteInfo {
  return {
    polys: new Map(), cells: new Map(), beltUse: new Map(), pipeUse: new Map(),
    bridges: [], unrouted: new Set(), blocked: new Set(),
  };
}

export interface Anchor {
  cell: { x: number; y: number };
  axis: Axis;
  point: Pt; // 포트 위치(footprint 경계 위)
}

/** 포트 바로 바깥 칸과 진출 축 */
export function portAnchor(m: ModuleInst, portKey: string): Anchor | null {
  const p = portByKey(m, portKey);
  if (!p) return null;
  const d = DIRV[p.side];
  return {
    cell: { x: Math.floor(p.x + d[0] * 0.5), y: Math.floor(p.y + d[1] * 0.5) },
    axis: d[0] !== 0 ? 'h' : 'v',
    point: { x: p.x, y: p.y },
  };
}

/* 최소 힙 */
class Heap {
  private a: { f: number; i: number }[] = [];
  push(f: number, i: number): void {
    const arr = this.a;
    arr.push({ f, i });
    let c = arr.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (arr[p].f <= arr[c].f) break;
      [arr[p], arr[c]] = [arr[c], arr[p]];
      c = p;
    }
  }
  pop(): { f: number; i: number } | undefined {
    const arr = this.a;
    if (!arr.length) return undefined;
    const top = arr[0];
    const last = arr.pop()!;
    if (arr.length) {
      arr[0] = last;
      let p = 0;
      for (;;) {
        const l = p * 2 + 1;
        const r = l + 1;
        let s = p;
        if (l < arr.length && arr[l].f < arr[s].f) s = l;
        if (r < arr.length && arr[r].f < arr[s].f) s = r;
        if (s === p) break;
        [arr[p], arr[s]] = [arr[s], arr[p]];
        p = s;
      }
    }
    return top;
  }
  get size(): number { return this.a.length; }
}

const MARGIN = 24;       // 시작/끝 바운딩 박스 밖 허용 여유(칸)
const NODE_CAP = 40000;  // A* 확장 상한
const TURN_COST = 0.4;   // 직선 선호

type BitsFn = (x: number, y: number) => number;

interface LegResult {
  cells: { x: number; y: number }[];
  endAxis: Axis;
}

/**
 * 한 구간 A* 탐색. 셀 상태 = (x, y, 진입 축).
 * - otherBits: 다른 연결의 점유(교차 규칙 적용 대상), ownBits: 이 연결의 앞 구간 점유
 * - endAxis가 null이면 도착 칸 진입만으로 종료(경유지), 지정 시 포트 스텁까지 검사(최종 구간)
 */
function astarLeg(
  start: { x: number; y: number }, startAxis: Axis,
  end: { x: number; y: number }, endAxis: Axis | null,
  blocked: Set<string>, otherBits: BitsFn, ownBits: BitsFn,
  checkStart: boolean,
): LegResult | null {
  const passable = (x: number, y: number, a: Axis): boolean => {
    if (blocked.has(cellKey(x, y))) return false;
    const ob = otherBits(x, y);
    if ((ob & bit(a)) !== 0 || ob === 3) return false;
    if ((ownBits(x, y) & bit(a)) !== 0) return false;
    return true;
  };

  if (checkStart && !passable(start.x, start.y, startAxis)) return null;

  if (start.x === end.x && start.y === end.y) {
    if (endAxis !== null && endAxis !== startAxis) {
      const need = bit(startAxis) | bit(endAxis);
      const ob = otherBits(start.x, start.y);
      if ((ob & need) !== 0 || ob !== 0) return null; // 모서리 칸은 빈 칸이어야
      if ((ownBits(start.x, start.y) & bit(endAxis)) !== 0) return null;
    } else if (endAxis !== null) {
      if ((otherBits(start.x, start.y) & bit(endAxis)) !== 0) return null;
    }
    return { cells: [{ ...start }], endAxis: endAxis ?? startAxis };
  }

  const minX = Math.min(start.x, end.x) - MARGIN;
  const maxX = Math.max(start.x, end.x) + MARGIN;
  const minY = Math.min(start.y, end.y) - MARGIN;
  const maxY = Math.max(start.y, end.y) + MARGIN;
  const W = maxX - minX + 1;
  const H = maxY - minY + 1;
  const idx = (x: number, y: number, a: Axis): number => ((y - minY) * W + (x - minX)) * 2 + (a === 'h' ? 0 : 1);

  const g = new Float64Array(W * H * 2).fill(Infinity);
  const parent = new Int32Array(W * H * 2).fill(-1);
  const heap = new Heap();
  const h = (x: number, y: number): number => Math.abs(x - end.x) + Math.abs(y - end.y);

  const startIdx = idx(start.x, start.y, startAxis);
  g[startIdx] = 0;
  heap.push(h(start.x, start.y), startIdx);

  const DIRS: { dx: number; dy: number; a: Axis }[] = [
    { dx: 1, dy: 0, a: 'h' }, { dx: -1, dy: 0, a: 'h' },
    { dx: 0, dy: 1, a: 'v' }, { dx: 0, dy: -1, a: 'v' },
  ];
  const fromIdx = (i: number): { x: number; y: number; a: Axis } => ({
    x: (Math.floor(i / 2) % W) + minX,
    y: Math.floor(Math.floor(i / 2) / W) + minY,
    a: i % 2 === 0 ? 'h' : 'v',
  });

  let expanded = 0;
  let goalIdx = -1;
  while (heap.size && expanded < NODE_CAP) {
    const cur = heap.pop()!;
    const { x, y, a } = fromIdx(cur.i);
    if (cur.f > g[cur.i] + h(x, y) + 1e-9) continue;
    expanded++;

    if (x === end.x && y === end.y) {
      if (endAxis === null) { goalIdx = cur.i; break; }
      // 도착 칸에 포트 스텁(endAxis)까지 얹을 수 있는지 확인
      const need = bit(a) | bit(endAxis);
      const ob = otherBits(x, y);
      const okOther = (ob & bit(endAxis)) === 0 && !(ob !== 0 && need === 3);
      const okOwn = (ownBits(x, y) & bit(endAxis)) === 0;
      if (okOther && okOwn) { goalIdx = cur.i; break; }
      continue; // 다른 진입 축으로 재시도 여지
    }

    for (const d of DIRS) {
      const nx = x + d.dx;
      const ny = y + d.dy;
      if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;
      if (d.a !== a) {
        // 방향 전환 → 현재 칸이 모서리가 됨: 다른 연결이 점유한 칸에서는 불가
        if (otherBits(x, y) !== 0) continue;
      }
      if (!passable(nx, ny, d.a)) continue;
      const ni = idx(nx, ny, d.a);
      const ng = g[cur.i] + 1 + (d.a !== a ? TURN_COST : 0);
      if (ng < g[ni] - 1e-9) {
        g[ni] = ng;
        parent[ni] = cur.i;
        heap.push(ng + h(nx, ny), ni);
      }
    }
  }
  if (goalIdx < 0) return null;

  const finalAxis = fromIdx(goalIdx).a;
  const cellsRev: { x: number; y: number }[] = [];
  for (let i = goalIdx; i >= 0; i = parent[i]) {
    const { x, y } = fromIdx(i);
    if (!cellsRev.length || cellsRev[cellsRev.length - 1].x !== x || cellsRev[cellsRev.length - 1].y !== y) {
      cellsRev.push({ x, y });
    }
  }
  return { cells: cellsRev.reverse(), endAxis: finalAxis };
}

/**
 * 시작 포트 → 경유지들 → 도착 지점을 구간별로 이어 전체 경로를 만든다.
 * endSpec.axis가 null이면 도착 지점은 자유 칸(프리뷰), 지정 시 반대 포트(최종 연결).
 */
export function routeThrough(
  A: Anchor,
  endSpec: { cell: { x: number; y: number }; axis: Axis | null },
  waypoints: { x: number; y: number }[],
  blocked: Set<string>,
  otherOcc: Map<string, CellUse>,
): { x: number; y: number }[] | null {
  const otherBits: BitsFn = (x, y) => otherOcc.get(cellKey(x, y))?.bits ?? 0;
  const own = new Map<string, number>();
  const ownBits: BitsFn = (x, y) => own.get(cellKey(x, y)) ?? 0;
  const addOwnSegs = (cells: { x: number; y: number }[]): void => {
    for (let i = 0; i < cells.length - 1; i++) {
      const a: Axis = cells[i + 1].x !== cells[i].x ? 'h' : 'v';
      for (const c of [cells[i], cells[i + 1]]) {
        const k = cellKey(c.x, c.y);
        own.set(k, (own.get(k) ?? 0) | bit(a));
      }
    }
  };

  const targets = [...waypoints.map((w) => ({ cell: w, axis: null as Axis | null })), endSpec];
  let cells: { x: number; y: number }[] = [];
  let cursor = A.cell;
  let axis = A.axis;

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const leg = astarLeg(cursor, axis, t.cell, t.axis, blocked, otherBits, ownBits, i === 0);
    if (!leg) return null;
    addOwnSegs(leg.cells);
    cells = cells.length ? cells.concat(leg.cells.slice(1)) : leg.cells;
    cursor = t.cell;
    axis = leg.endAxis;
  }
  return cells;
}

function markUsage(
  occ: Map<string, CellUse>, id: number,
  cells: { x: number; y: number }[], startAxis: Axis, endAxis: Axis,
): void {
  const add = (x: number, y: number, b: number): void => {
    const k = cellKey(x, y);
    const u = occ.get(k) ?? { bits: 0, conns: new Set<number>() };
    u.bits |= b;
    u.conns.add(id);
    occ.set(k, u);
  };
  add(cells[0].x, cells[0].y, bit(startAxis));
  add(cells[cells.length - 1].x, cells[cells.length - 1].y, bit(endAxis));
  for (let i = 0; i < cells.length - 1; i++) {
    const a: Axis = cells[i + 1].x !== cells[i].x ? 'h' : 'v';
    add(cells[i].x, cells[i].y, bit(a));
    add(cells[i + 1].x, cells[i + 1].y, bit(a));
  }
}

export function facilityCells(state: LayoutState): Set<string> {
  const s = new Set<string>();
  for (const m of state.modules) {
    const r = moduleRect(m);
    for (let x = r.x; x < r.x + r.w; x++) {
      for (let y = r.y; y < r.y + r.h; y++) s.add(cellKey(x, y));
    }
  }
  return s;
}

/** 모든 연결을 id 순서로 라우팅 (결정적). 설비/기존 라인 변경 시마다 다시 호출 */
export function computeRoutes(state: LayoutState): RouteInfo {
  const info = emptyRouteInfo();
  info.blocked = facilityCells(state);
  const modById = (id: number): ModuleInst | undefined => state.modules.find((m) => m.id === id);

  for (const c of [...state.connections].sort((a, b) => a.id - b.id)) {
    const fm = modById(c.fromModuleId);
    const tm = modById(c.toModuleId);
    const A = fm ? portAnchor(fm, c.fromPort) : null;
    const B = tm ? portAnchor(tm, c.toPort) : null;
    if (!fm || !tm || !A || !B) {
      info.polys.set(c.id, null);
      info.cells.set(c.id, null);
      info.unrouted.add(c.id);
      continue;
    }
    const transport: Transport = portDef(fm, c.fromPort)?.transport ?? 'belt';
    const occ = transport === 'pipe' ? info.pipeUse : info.beltUse;
    const cells = routeThrough(A, { cell: B.cell, axis: B.axis }, c.waypoints ?? [], info.blocked, occ);
    if (!cells) {
      info.polys.set(c.id, null);
      info.cells.set(c.id, null);
      info.unrouted.add(c.id);
      continue;
    }
    markUsage(occ, c.id, cells, A.axis, B.axis);
    info.cells.set(c.id, cells);
    info.polys.set(c.id, [A.point, ...cells.map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 })), B.point]);
  }

  // 서로 다른 연결이 한 칸에서 수평+수직을 함께 쓰면 = 교차 → 브리지 자동 표시
  const collectBridges = (use: Map<string, CellUse>, transport: Transport): void => {
    for (const [k, u] of use) {
      if (u.bits === 3 && u.conns.size >= 2) {
        const [x, y] = k.split(',').map(Number);
        info.bridges.push({ x, y, transport });
      }
    }
  };
  collectBridges(info.beltUse, 'belt');
  collectBridges(info.pipeUse, 'pipe');
  return info;
}

/**
 * 설비 배치 가능 여부(라인 점유 칸과의 충돌).
 * excludeModuleId에 연결된 라인은 무시 — 해당 설비를 옮기면 그 라인들은 어차피 다시 라우팅되므로.
 */
export function rectBlockedByRoutes(
  info: RouteInfo, state: LayoutState,
  rect: { x: number; y: number; w: number; h: number },
  excludeModuleId: number | null,
): boolean {
  const connTouches = new Map<number, boolean>();
  const touches = (id: number): boolean => {
    let v = connTouches.get(id);
    if (v === undefined) {
      const c = state.connections.find((x) => x.id === id);
      v = !!c && (c.fromModuleId === excludeModuleId || c.toModuleId === excludeModuleId);
      connTouches.set(id, v);
    }
    return v;
  };
  for (const use of [info.beltUse, info.pipeUse]) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      for (let y = rect.y; y < rect.y + rect.h; y++) {
        const u = use.get(cellKey(x, y));
        if (!u) continue;
        for (const id of u.conns) {
          if (!touches(id)) return true;
        }
      }
    }
  }
  return false;
}
