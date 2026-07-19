import type { CatalogData, FacilityType } from './types';

export const LS_FACILITIES = 'endfield-planner-facilities-v1';

export let CATALOG: CatalogData;
export let FAC: Record<string, FacilityType> = {};
export let CAT_COLOR: Record<string, string> = {};

let DEFAULT_CATALOG: CatalogData | null = null;

/** 카탈로그를 교체하고 조회용 맵을 다시 만든다 */
export function applyCatalog(data: CatalogData): void {
  CATALOG = data;
  FAC = {};
  for (const f of data.facilities) FAC[f.id] = f;
  CAT_COLOR = {};
  for (const [k, v] of Object.entries(data.categories ?? {})) CAT_COLOR[k] = v.color;
}

export async function loadCatalog(): Promise<CatalogData> {
  const r = await fetch(`${import.meta.env.BASE_URL}data/facilities.json`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`설비 데이터 로드 실패: HTTP ${r.status}`);
  const data = (await r.json()) as CatalogData;
  DEFAULT_CATALOG = data;
  // 에디터로 수정한 오버라이드가 있으면 그것을 사용
  let active = data;
  try {
    const raw = localStorage.getItem(LS_FACILITIES);
    if (raw) {
      const ov = JSON.parse(raw) as CatalogData;
      if (Array.isArray(ov.facilities) && ov.facilities.length) active = ov;
    }
  } catch { /* 손상된 오버라이드는 무시 */ }
  applyCatalog(structuredClone(active));
  return CATALOG;
}

/** 원본(파일) 카탈로그 복사본 — 에디터의 "기본값 복원"용 */
export function getDefaultCatalog(): CatalogData {
  return structuredClone(DEFAULT_CATALOG!);
}

export function saveCatalogOverride(): void {
  try { localStorage.setItem(LS_FACILITIES, JSON.stringify(CATALOG)); } catch { /* 무시 */ }
}

export function clearCatalogOverride(): void {
  try { localStorage.removeItem(LS_FACILITIES); } catch { /* 무시 */ }
}

export const F = (id: string): FacilityType => FAC[id];
