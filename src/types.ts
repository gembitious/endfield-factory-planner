export type Side = 'N' | 'E' | 'S' | 'W';
export type Transport = 'belt' | 'pipe';

/** 설비 입출력 포트 정의 (분당 개수) */
export interface IoPort {
  resource: string; // 'any' = 모든 리소스 통과(물류/저장)
  rate: number;
  /** 운송 종류. 생략 시 belt. 벨트↔파이프 포트는 서로 연결 불가 */
  transport?: Transport;
  /** 포트가 붙는 변. 생략 시 입력=W, 출력=E에 자동 분배 */
  side?: Side;
  /** 해당 변 위의 칸 번호(0부터). side 지정 시에만 사용 */
  pos?: number;
}

/** 레시피 — 설비의 입출력 자원 세트. 포트 배치는 설비 고정, 자원은 선택된 레시피에 따라 배정 */
export interface Recipe {
  id: string;
  name: string;
  inputs?: IoPort[];  // side/pos는 무시 — transport(belt/pipe)와 resource/rate만 사용
  outputs?: IoPort[];
  note?: string;
}

/** 설비 정의 — public/data/facilities.json에서 로드 */
export interface FacilityType {
  id: string;
  name: string;
  category: string;
  icon?: string;
  /** 썸네일 이미지 경로 (BASE_URL 기준 상대 경로, 예: "icons/crusher.png"). 없으면 icon 이모지 사용 */
  image?: string;
  footprint: { w: number; h: number };
  powerDraw?: number;
  /** 전력 공급 범위(미터). 중계기/코어 등 */
  powerRange?: number;
  /** true면 전력의 원천(프로토콜 코어 등) — 전력 체인의 시작점 */
  powerSource?: boolean;
  /** true면 들어온 리소스를 그대로 흘려보내는 물류 설비 */
  passthrough?: boolean;
  /** true면 통과량 제한을 설정할 수 있는 물류 설비 (컨트롤 포트) */
  limiter?: boolean;
  maxPerBase?: number;
  note?: string;
  /** 포트 슬롯 (위치·운송 종류는 실측 고정). recipes가 없으면 여기 적힌 resource/rate가 그대로 사용됨 */
  inputs?: IoPort[];
  outputs?: IoPort[];
  /** 복수 레시피. 있으면 선택된 레시피(기본 = 첫 번째)의 자원이 포트 슬롯에 배정됨 */
  recipes?: Recipe[];
}

/** 부지(공업 구역) 프리셋 — public/data/sites.json */
export interface SiteDef {
  id: string;
  name: string;
  w: number;
  h: number;
  source?: string;
  note?: string;
}

export interface CatalogData {
  version: number;
  metersPerCell: number;
  note?: string;
  categories: Record<string, { color: string }>;
  facilities: FacilityType[];
}

/** 배치된 설비 인스턴스 */
export interface ModuleInst {
  id: number;
  typeId: string;
  x: number;
  y: number;
  rot: number; // 0 | 90 | 180 | 270
  /** 선택된 레시피 id (설비에 recipes가 있을 때만 의미) */
  recipeId?: string;
  /** 통과량 제한 (개/분). limiter 설비에서만 의미, 없으면 무제한 */
  limit?: number;
}

/** 벨트/파이프 연결. 포트 키는 'in:<idx>' / 'out:<idx>' */
export interface Connection {
  id: number;
  fromModuleId: number;
  fromPort: string;
  toModuleId: number;
  toPort: string;
  /** 사용자가 클릭으로 지정한 경유 칸들. 경로는 이 칸들을 순서대로 지난다. 없으면 자동 최단 경로 */
  waypoints?: { x: number; y: number }[];
}

export interface LayoutState {
  modules: ModuleInst[];
  connections: Connection[];
  nextId: number;
}

export interface SerializedLayout {
  v: number;
  /** 선택된 부지 프리셋 id */
  site?: string;
  nextId: number;
  modules: ModuleInst[];
  connections: Connection[];
}

/** 회전이 적용된 포트의 월드(셀) 좌표 정보 */
export interface PortInfo extends IoPort {
  key: string;
  kind: 'input' | 'output';
  side: Side;
  frac: number;
  x: number;
  y: number;
}

export interface PowerNode {
  moduleId: number;
  cx: number;
  cy: number;
  r: number; // 셀 단위 반경
  meters: number;
  active: boolean;
  source: boolean;
}

export interface PowerInfo {
  nodes: PowerNode[];
  unpowered: Set<number>;
  hasSource: boolean;
}

/** 연결별 리소스 흐름 (resource → 분당 개수) */
export type FlowMap = Record<number, Record<string, number>>;

export interface FlowInfo {
  flows: FlowMap;
  bottlenecks: Set<number>;
  modWarn: Record<number, string[]>;
  inByPort: Record<string, Connection[]>;
}
