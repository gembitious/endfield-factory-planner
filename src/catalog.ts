import type { CatalogData, FacilityType } from './types';

export let CATALOG: CatalogData;
export let FAC: Record<string, FacilityType> = {};
export let CAT_COLOR: Record<string, string> = {};

export async function loadCatalog(): Promise<CatalogData> {
  const r = await fetch(`${import.meta.env.BASE_URL}data/facilities.json`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`설비 데이터 로드 실패: HTTP ${r.status}`);
  const data = (await r.json()) as CatalogData;
  CATALOG = data;
  FAC = {};
  for (const f of data.facilities) FAC[f.id] = f;
  CAT_COLOR = {};
  for (const [k, v] of Object.entries(data.categories ?? {})) CAT_COLOR[k] = v.color;
  return data;
}

export const F = (id: string): FacilityType => FAC[id];
