import { F } from './catalog';
import type { FacilityType, IoPort, ModuleInst, Recipe } from './types';

/**
 * 레시피 해석: 설비의 포트 슬롯(위치·운송 종류 고정)에 활성 레시피의 자원을 배정한다.
 * - 벨트 포트에는 고체 자원, 파이프 포트에는 액체/기체 자원을 순환 배정 (병렬 레인)
 * - 해당 종류의 자원이 없는 포트는 'any'(자유 포트, rate 0)
 * - recipes가 없는 설비는 포트 슬롯에 적힌 resource/rate 그대로
 */

export function activeRecipe(m: ModuleInst): Recipe | null {
  const t = F(m.typeId);
  if (!t.recipes?.length) return null;
  return t.recipes.find((r) => r.id === m.recipeId) ?? t.recipes[0];
}

function assign(slots: IoPort[], resources: IoPort[]): IoPort[] {
  const solids = resources.filter((r) => (r.transport ?? 'belt') === 'belt');
  const liquids = resources.filter((r) => r.transport === 'pipe');
  let si = 0;
  let li = 0;
  return slots.map((s) => {
    const isPipe = s.transport === 'pipe';
    const pool = isPipe ? liquids : solids;
    const i = isPipe ? li++ : si++;
    const base = pool.length ? pool[i % pool.length] : { resource: 'any', rate: 0 };
    return { ...s, resource: base.resource, rate: base.rate };
  });
}

const cache = new Map<string, { inputs: IoPort[]; outputs: IoPort[] }>();

/** 모듈의 유효 입출력 포트 (활성 레시피 반영). 카탈로그 변경 시 clearIoCache() 필요 */
export function resolveIo(m: ModuleInst): { inputs: IoPort[]; outputs: IoPort[] } {
  const t: FacilityType = F(m.typeId);
  const rec = activeRecipe(m);
  if (!rec) return { inputs: t.inputs ?? [], outputs: t.outputs ?? [] };
  const key = `${m.typeId}|${rec.id}`;
  let v = cache.get(key);
  if (!v) {
    v = {
      inputs: assign(t.inputs ?? [], rec.inputs ?? []),
      outputs: assign(t.outputs ?? [], rec.outputs ?? []),
    };
    cache.set(key, v);
  }
  return v;
}

export function clearIoCache(): void {
  cache.clear();
}
