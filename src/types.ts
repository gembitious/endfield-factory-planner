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
  maxPerBase?: number;
  note?: string;
  inputs?: IoPort[];
  outputs?: IoPort[];
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
