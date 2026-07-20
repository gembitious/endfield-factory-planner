import { F } from './catalog';
import type { LayoutState, SerializedLayout } from './types';

export const LS_KEY = 'endfield-planner-v1';
export const LS_THEME = 'endfield-planner-theme';

export function serialize(state: LayoutState, site?: string | null): SerializedLayout {
  return {
    v: 1,
    ...(site ? { site } : {}),
    nextId: state.nextId,
    modules: state.modules.map((m) => ({
      id: m.id, typeId: m.typeId, x: m.x, y: m.y, rot: m.rot,
      ...(m.recipeId ? { recipeId: m.recipeId } : {}),
      ...(m.limit !== undefined ? { limit: m.limit } : {}),
    })),
    connections: state.connections.map((c) => ({
      id: c.id, fromModuleId: c.fromModuleId, fromPort: c.fromPort,
      toModuleId: c.toModuleId, toPort: c.toPort,
      ...(c.waypoints?.length ? { waypoints: c.waypoints.map((w) => ({ x: w.x, y: w.y })) } : {}),
    })),
  };
}

/** 검증하며 state에 반영. 알 수 없는 설비/끊어진 연결은 건너뛰고 개수를 반환 */
export function deserializeInto(state: LayoutState, data: SerializedLayout): number {
  if (!data || !Array.isArray(data.modules)) throw new Error('형식이 올바르지 않습니다');
  const mods: LayoutState['modules'] = [];
  const conns: LayoutState['connections'] = [];
  let skipped = 0;
  for (const m of data.modules) {
    const t = F(m.typeId);
    if (!t) { skipped++; continue; }
    mods.push({
      id: m.id, typeId: m.typeId, x: m.x | 0, y: m.y | 0,
      rot: [0, 90, 180, 270].includes(m.rot) ? m.rot : 0,
      recipeId: m.recipeId && t.recipes?.some((r) => r.id === m.recipeId) ? m.recipeId : undefined,
      limit: typeof m.limit === 'number' && m.limit >= 0 ? m.limit : undefined,
    });
  }
  const ids = new Set(mods.map((m) => m.id));
  for (const c of data.connections ?? []) {
    if (!ids.has(c.fromModuleId) || !ids.has(c.toModuleId)) { skipped++; continue; }
    conns.push({
      ...c,
      waypoints: Array.isArray(c.waypoints)
        ? c.waypoints.map((w) => ({ x: w.x | 0, y: w.y | 0 }))
        : undefined,
    });
  }
  state.modules = mods;
  state.connections = conns;
  state.nextId = data.nextId
    || Math.max(0, ...mods.map((m) => m.id), ...conns.map((c) => c.id)) + 1;
  return skipped;
}

/* base64 (유니코드 안전) */
export function b64encode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64decode(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodeShareHash(state: LayoutState, site?: string | null): string {
  return '#L=' + encodeURIComponent(b64encode(JSON.stringify(serialize(state, site))));
}

export function decodeShareHash(hash: string): SerializedLayout | null {
  const mt = hash.match(/#L=([^&]+)/);
  if (!mt) return null;
  return JSON.parse(b64decode(decodeURIComponent(mt[1]))) as SerializedLayout;
}

export function saveLocal(state: LayoutState, site?: string | null): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(serialize(state, site))); } catch { /* 무시 */ }
}

export function loadLocal(): SerializedLayout | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as SerializedLayout) : null;
  } catch {
    return null;
  }
}
