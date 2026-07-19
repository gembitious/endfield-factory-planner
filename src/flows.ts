import { F } from './catalog';
import { portDef } from './geometry';
import type { Connection, FlowInfo, LayoutState } from './types';

/**
 * 생산 체인 흐름/병목 계산.
 * - 실측 데이터에서는 같은 리소스가 여러 포트에 있음(병렬 레인). 명명된 리소스의 생산/수요는
 *   설비 단위로 1회만 계산하고, 흐름은 그 리소스를 나르는 모든 연결에 균등 분배한다.
 * - 'any' 출력 포트(코어의 창고 인출구 등)는 포트 단위로 독립 분배하며, 'any' 흐름은
 *   어떤 리소스 수요든 충족하는 와일드카드로 취급한다.
 * - passthrough(물류) 설비는 들어온 리소스 합을 나가는 연결 수로 나눠 그대로 전달.
 * - 병목: 연결된 리소스에서 공급 < 수요. 미연결 리소스는 경고하지 않음.
 */
export function computeFlows(state: LayoutState): FlowInfo {
  const conns = state.connections;
  const modById = (id: number) => state.modules.find((m) => m.id === id);
  const inByModule: Record<number, Connection[]> = {};
  const outByModule: Record<number, Connection[]> = {};
  const outByPort: Record<string, Connection[]> = {};
  const inByPort: Record<string, Connection[]> = {};
  const outByRes: Record<string, Connection[]> = {}; // `${moduleId}|${resource}` (명명 리소스, 비물류)
  for (const c of conns) {
    (inByModule[c.toModuleId] ??= []).push(c);
    (outByModule[c.fromModuleId] ??= []).push(c);
    (outByPort[`${c.fromModuleId}|${c.fromPort}`] ??= []).push(c);
    (inByPort[`${c.toModuleId}|${c.toPort}`] ??= []).push(c);
    const m = modById(c.fromModuleId);
    if (m && !F(m.typeId).passthrough) {
      const p = portDef(m.typeId, c.fromPort);
      if (p && p.resource !== 'any') (outByRes[`${m.id}|${p.resource}`] ??= []).push(c);
    }
  }

  let flows: Record<number, Record<string, number>> = {};
  for (const c of conns) flows[c.id] = {};
  // 물류(passthrough) 체인 전파를 위한 반복 완화
  for (let it = 0; it < 24; it++) {
    const next: Record<number, Record<string, number>> = {};
    for (const c of conns) {
      const m = modById(c.fromModuleId);
      if (!m) { next[c.id] = {}; continue; }
      const t = F(m.typeId);
      if (t.passthrough) {
        const agg: Record<string, number> = {};
        for (const ic of inByModule[m.id] ?? []) {
          for (const [r, v] of Object.entries(flows[ic.id] ?? {})) agg[r] = (agg[r] ?? 0) + v;
        }
        const k = (outByModule[m.id] ?? []).length;
        const out: Record<string, number> = {};
        for (const [r, v] of Object.entries(agg)) out[r] = v / k;
        next[c.id] = out;
      } else {
        const p = portDef(m.typeId, c.fromPort);
        if (!p) { next[c.id] = {}; continue; }
        if (p.resource === 'any') {
          const k = outByPort[`${m.id}|${c.fromPort}`].length;
          next[c.id] = p.rate > 0 ? { any: p.rate / k } : {};
        } else {
          const k = outByRes[`${m.id}|${p.resource}`].length;
          next[c.id] = { [p.resource]: p.rate / k };
        }
      }
    }
    flows = next;
  }

  // 병목 판정: 리소스 단위로 그룹 (같은 리소스의 여러 포트 = 병렬 레인)
  const bottlenecks = new Set<number>();
  const modWarn: Record<number, string[]> = {};
  const round1 = (v: number) => Math.round(v * 10) / 10;
  for (const m of state.modules) {
    const t = F(m.typeId);
    if (t.passthrough) continue;
    const seen = new Set<string>();
    (t.inputs ?? []).forEach((inp, i) => {
      if (inp.resource === 'any' || seen.has(inp.resource)) return;
      seen.add(inp.resource);
      // 이 리소스가 배정된 모든 입력 포트의 유입 합산
      const ics: Connection[] = [];
      (t.inputs ?? []).forEach((p2, j) => {
        if (p2.resource === inp.resource) ics.push(...(inByPort[`${m.id}|in:${j}`] ?? []));
      });
      if (!ics.length) return;
      let s = 0;
      for (const ic of ics) {
        const f = flows[ic.id];
        s += (f[inp.resource] ?? 0) + (f.any ?? 0);
      }
      if (s < inp.rate - 1e-6) {
        (modWarn[m.id] ??= []).push(`${inp.resource} 부족 — 공급 ${round1(s)} / 필요 ${inp.rate}`);
        ics.forEach((ic) => bottlenecks.add(ic.id));
      }
    });
  }
  return { flows, bottlenecks, modWarn, inByPort };
}
