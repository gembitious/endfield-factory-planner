import { F } from './catalog';
import type { Connection, FacilityType, IoPort, ModuleInst, PortInfo, Side } from './types';

export const ROT_SIDE: Record<Side, Side> = { N: 'E', E: 'S', S: 'W', W: 'N' };
export const DIRV: Record<Side, [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };

export interface Pt { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

/** 회전 반영된 footprint 크기 */
export function dims(m: ModuleInst): { w: number; h: number } {
  const fp = F(m.typeId).footprint;
  return m.rot % 180 === 0 ? { w: fp.w, h: fp.h } : { w: fp.h, h: fp.w };
}

export function center(m: ModuleInst): Pt {
  const d = dims(m);
  return { x: m.x + d.w / 2, y: m.y + d.h / 2 };
}

export function moduleRect(m: ModuleInst): Rect {
  const d = dims(m);
  return { x: m.x, y: m.y, w: d.w, h: d.h };
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function canPlace(
  modules: ModuleInst[], typeId: string, x: number, y: number, rot: number, ignoreId: number | null,
): boolean {
  const fp = F(typeId).footprint;
  const d = rot % 180 === 0 ? { w: fp.w, h: fp.h } : { w: fp.h, h: fp.w };
  const r: Rect = { x, y, w: d.w, h: d.h };
  return !modules.some((m) => m.id !== ignoreId && rectsOverlap(r, moduleRect(m)));
}

/**
 * 모듈의 포트 목록 (월드 셀 좌표, 회전 반영).
 * 포트에 side/pos가 지정되면 해당 변의 해당 칸에 고정, 없으면 입력=W, 출력=E에 자동 분배.
 */
export function getPorts(m: ModuleInst): PortInfo[] {
  const t = F(m.typeId);
  const { w: fw, h: fh } = t.footprint;
  const list: Omit<PortInfo, 'x' | 'y'>[] = [];
  const push = (arr: FacilityType['inputs'], kind: 'input' | 'output', prefix: string, defSide: Side) => {
    const autos = (arr ?? []).filter((p) => !p.side).length;
    let autoIdx = 0;
    (arr ?? []).forEach((p, i) => {
      let side: Side;
      let frac: number;
      if (p.side) {
        side = p.side;
        const len = side === 'W' || side === 'E' ? fh : fw;
        const pos = Math.max(0, Math.min(len - 1, p.pos ?? 0));
        frac = (pos + 0.5) / len;
      } else {
        side = defSide;
        frac = (++autoIdx) / (autos + 1);
      }
      list.push({
        key: prefix + i, kind, side, frac,
        resource: p.resource, rate: p.rate, transport: p.transport ?? 'belt',
      });
    });
  };
  push(t.inputs, 'input', 'in:', 'W');
  push(t.outputs, 'output', 'out:', 'E');

  const steps = ((m.rot || 0) / 90) | 0;
  return list.map((p) => {
    let w = t.footprint.w;
    let h = t.footprint.h;
    let x: number;
    let y: number;
    let side = p.side;
    if (p.side === 'W') { x = 0; y = p.frac * h; }
    else if (p.side === 'E') { x = w; y = p.frac * h; }
    else if (p.side === 'N') { x = p.frac * w; y = 0; }
    else { x = p.frac * w; y = h; }
    for (let i = 0; i < steps; i++) {
      // 시계방향 90° 회전: (x, y) → (h - y, x), 박스 (w, h) → (h, w)
      const nx = h - y;
      const ny = x;
      x = nx; y = ny;
      const tmp = w; w = h; h = tmp;
      side = ROT_SIDE[side];
    }
    return { ...p, side, x: m.x + x, y: m.y + y };
  });
}

export function portByKey(m: ModuleInst, key: string): PortInfo | null {
  return getPorts(m).find((p) => p.key === key) ?? null;
}

/** 포트 키('in:2' 등)로 설비 정의의 IoPort 조회 */
export function portDef(typeId: string, key: string): IoPort | undefined {
  const t = F(typeId);
  const [kind, idx] = key.split(':');
  return (kind === 'in' ? t.inputs : t.outputs)?.[+idx];
}

/** 연결의 직각 폴리라인 경로 (월드 셀 좌표) */
export function connPath(c: Connection, modById: (id: number) => ModuleInst | undefined): Pt[] | null {
  const fm = modById(c.fromModuleId);
  const tm = modById(c.toModuleId);
  if (!fm || !tm) return null;
  const a = portByKey(fm, c.fromPort);
  const b = portByKey(tm, c.toPort);
  if (!a || !b) return null;
  const ad = DIRV[a.side];
  const bd = DIRV[b.side];
  const p1: Pt = { x: a.x + ad[0] * 0.6, y: a.y + ad[1] * 0.6 };
  const p2: Pt = { x: b.x + bd[0] * 0.6, y: b.y + bd[1] * 0.6 };
  const pts: Pt[] = [{ x: a.x, y: a.y }, p1];
  if (ad[0] !== 0) {
    const mx = (p1.x + p2.x) / 2;
    pts.push({ x: mx, y: p1.y }, { x: mx, y: p2.y });
  } else {
    const my = (p1.y + p2.y) / 2;
    pts.push({ x: p1.x, y: my }, { x: p2.x, y: my });
  }
  pts.push(p2, { x: b.x, y: b.y });
  return pts;
}

export function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
