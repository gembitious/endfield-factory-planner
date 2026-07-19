import { CATALOG, F } from './catalog';
import { center } from './geometry';
import type { LayoutState, PowerInfo, PowerNode } from './types';

/**
 * 전력망 계산.
 * - powerSource(코어)가 체인의 시작점.
 * - 중계기류는 활성 노드의 범위 안에 있어야 연쇄 활성화 (80m 체인).
 * - powerDraw > 0 설비가 활성 노드 범위 밖이면 unpowered.
 * - 전력원이 하나도 없으면 검사를 생략(스케치 중 소음 방지).
 */
export function computePower(state: LayoutState): PowerInfo {
  const nodes: PowerNode[] = [];
  const mpc = CATALOG.metersPerCell || 4;
  for (const m of state.modules) {
    const t = F(m.typeId);
    if (t.powerRange && t.powerRange > 0) {
      const c = center(m);
      nodes.push({
        moduleId: m.id, cx: c.x, cy: c.y,
        r: t.powerRange / mpc, meters: t.powerRange,
        active: !!t.powerSource, source: !!t.powerSource,
      });
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of nodes) {
      if (n.active) continue;
      for (const p of nodes) {
        if (p.active && Math.hypot(p.cx - n.cx, p.cy - n.cy) <= p.r) {
          n.active = true;
          changed = true;
          break;
        }
      }
    }
  }
  const hasSource = nodes.some((n) => n.source);
  const unpowered = new Set<number>();
  if (hasSource) {
    for (const m of state.modules) {
      const t = F(m.typeId);
      if (!t.powerDraw || t.powerDraw <= 0) continue;
      const c = center(m);
      const ok = nodes.some((n) => n.active && Math.hypot(n.cx - c.x, n.cy - c.y) <= n.r);
      if (!ok) unpowered.add(m.id);
    }
  }
  return { nodes, unpowered, hasSource };
}
