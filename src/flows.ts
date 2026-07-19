import { F } from './catalog';
import { portDef } from './geometry';
import type { Connection, FlowInfo, LayoutState } from './types';

/**
 * 생산 체인 흐름/병목 계산.
 * - 일반 설비: 출력 포트 rate를 해당 포트의 연결 수로 나눠 분배.
 * - passthrough(물류) 설비: 들어온 리소스 합을 나가는 연결 수로 나눠 그대로 전달.
 *   체인 전파를 위해 고정 횟수 반복 완화(사이클은 자연 감쇠).
 * - 병목: 연결된 입력 포트에서 공급 < 수요인 경우. 미연결 포트는 경고하지 않음.
 */
export function computeFlows(state: LayoutState): FlowInfo {
  const conns = state.connections;
  const modById = (id: number) => state.modules.find((m) => m.id === id);
  const inByModule: Record<number, Connection[]> = {};
  const outByModule: Record<number, Connection[]> = {};
  const outByPort: Record<string, Connection[]> = {};
  const inByPort: Record<string, Connection[]> = {};
  for (const c of conns) {
    (inByModule[c.toModuleId] ??= []).push(c);
    (outByModule[c.fromModuleId] ??= []).push(c);
    (outByPort[`${c.fromModuleId}|${c.fromPort}`] ??= []).push(c);
    (inByPort[`${c.toModuleId}|${c.toPort}`] ??= []).push(c);
  }

  let flows: Record<number, Record<string, number>> = {};
  for (const c of conns) flows[c.id] = {};
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
        const k = outByPort[`${m.id}|${c.fromPort}`].length;
        next[c.id] = p ? { [p.resource]: p.rate / k } : {};
      }
    }
    flows = next;
  }

  const bottlenecks = new Set<number>();
  const modWarn: Record<number, string[]> = {};
  const round1 = (v: number) => Math.round(v * 10) / 10;
  for (const m of state.modules) {
    const t = F(m.typeId);
    if (t.passthrough) continue;
    (t.inputs ?? []).forEach((inp, i) => {
      if (inp.resource === 'any') return;
      const ics = inByPort[`${m.id}|in:${i}`] ?? [];
      if (!ics.length) return;
      let s = 0;
      for (const ic of ics) s += flows[ic.id][inp.resource] ?? 0;
      if (s < inp.rate - 1e-6) {
        (modWarn[m.id] ??= []).push(`${inp.resource} 부족 — 공급 ${round1(s)} / 필요 ${inp.rate}`);
        ics.forEach((ic) => bottlenecks.add(ic.id));
      }
    });
  }
  return { flows, bottlenecks, modWarn, inByPort };
}
