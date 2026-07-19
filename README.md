# 엔드필드 공장 플래너 (Endfield Factory Planner)

명일방주: 엔드필드(Arknights: Endfield)의 통합 공업 시스템(AIC) 설비 배치를 스케치해보는 드래그 앤 드롭 기반 공장 레이아웃 플래너입니다. 게임의 정확한 수치 재현이 아니라, 생산 라인이 병목 없이 맞물리는지 미리 검증하는 **기획 도구**입니다.

Vite + TypeScript(Vanilla, 프레임워크 없음) + HTML5 Canvas로 만들어졌으며, GitHub Pages로 바로 배포됩니다.

## 개발/실행

```bash
npm install
npm run dev      # 개발 서버 (기본 5173 포트)
npm run build    # 타입체크 + dist/ 빌드
npm run preview  # 빌드 결과 미리보기
```

## GitHub Pages 배포

`main` 브랜치에 push하면 [.github/workflows/deploy.yml](.github/workflows/deploy.yml)이 자동으로 빌드해서 GitHub Pages에 배포합니다.

최초 1회 설정: GitHub 저장소 → **Settings → Pages → Build and deployment → Source**를 **GitHub Actions**로 변경.

`vite.config.ts`의 `base: './'` 덕분에 `https://<user>.github.io/<repo>/` 하위 경로에서도 그대로 동작합니다.

## 기능

| 기능 | 설명 |
| --- | --- |
| 배치 | 팔레트에서 드래그 앤 드롭, 또는 클릭 후 캔버스 클릭 (Shift+클릭 = 연속 배치) |
| 회전 | `R` 키 또는 회전 버튼 (90° 단위, 겹치면 회전 불가) |
| 충돌 방지 | 겹치는 칸에는 배치/이동/회전 불가 |
| 연결 | 출력 포트(● 주황) 클릭 → 입력 포트(○ 초록) 클릭. 리소스가 다르면 연결 거부 |
| 저장 | localStorage 자동 저장 + JSON export/import |
| 공유 | "공유 URL 복사" — 레이아웃이 URL 해시(`#L=...`)에 인코딩됨 |
| 전력 커버리지 | 프로토콜 코어/중계기/전력 공급기 배치 시 범위 원 표시. 코어에 연쇄되지 않은 중계기는 점선(비활성). 범위 밖 설비는 빨간 테두리 + ⚡ 경고 |
| 병목 검증 | 연결된 라인의 공급 속도 < 수요 속도이면 해당 연결이 주황색 ⚠️ 하이라이트 |
| 다크모드 | 우상단 🌙/☀️ 토글 |

### 조작법

- 휠: 줌 / 우클릭·휠클릭 드래그: 화면 이동
- 설비 클릭: 선택(정보 패널 표시) / 드래그: 이동
- `R`: 회전, `Del`: 삭제, `Esc`: 취소/선택 해제

## 프로젝트 구조

```
index.html                  Vite 진입점 (레이아웃 마크업)
public/data/facilities.json 설비 카탈로그 (런타임 fetch — 코드 수정 없이 값만 갱신 가능)
src/
  main.ts        부트스트랩 (데이터 로드 → 앱 시작)
  app.ts         UI·캔버스 렌더링·인터랙션 전체
  types.ts       도메인 타입 정의
  catalog.ts     설비 데이터 로드
  geometry.ts    footprint/포트 회전, 연결 경로, 히트 테스트
  power.ts       전력망 연쇄 활성화·커버리지 계산
  flows.ts       생산 체인 흐름 전파·병목 판정
  persist.ts     직렬화, localStorage, 공유 URL 인코딩
  style.css      테마(다크/라이트) 및 레이아웃
```

## 설비/자원 명칭 — 한국어 정식 명칭 기준

설비·자원 이름은 한국어 정식 서비스 명칭(나무위키 [명일방주: 엔드필드/설비](https://namu.wiki/w/%EB%AA%85%EC%9D%BC%EB%B0%A9%EC%A3%BC:%20%EC%97%94%EB%93%9C%ED%95%84%EB%93%9C/%EC%84%A4%EB%B9%84) 문서 대조, 2026-07-19 기준)을 따릅니다. 초기 기획 문서(CLAUDE.md)의 커뮤니티 임시 용어와의 대응표:

| 임시 용어 (구) | 정식 명칭 (현재) |
| --- | --- |
| 원소금 | 오리지늄 (광물) |
| 철스러움 | 페리움 (광석) |
| 구리움 | 적동 (광석) |
| 이동식 채광기 | 휴대용 오리지늄 채굴기 |
| 전기 채광기 (Mk II) | 전동 채굴기 (II) |
| 정제실 | 정련로 |
| 분쇄실 | 분쇄기 |
| 부품조립실 | 부품 가공기 |
| 포장 | 포장기 |
| 천공로 | 천화로 |
| 분배기 | 분류기 |
| 브릿지(교량) | 물류 브리지 |
| 프로토콜 보관소 | 프로토콜 저장함 |
| 창고 적재기/버스 | 창고 입력/출력 포트 |
| 메인/서브 PAC | 프로토콜 코어 / 서브 코어 |
| 중계탑 | 중계기 |
| 전기 철탑 | 전력 공급기 |
| 열 배터리 뱅크 | 열에너지 뱅크 |
| 포탑 / 의료탑 | 총기 타워 / 의료 타워 |
| 짚라인 | 집라인 후크 |

## 데이터 수정 (`public/data/facilities.json`)

명칭은 정식 번역을 따르지만, **생산 속도(개/분)·footprint·전력 수치는 공식 미공개라 대략치**입니다. 패치나 실측에 맞게 직접 수정하세요. 표준 라인 = 컨베이어 벨트 최대 운송량인 2초당 1개 = **30/분** 기준입니다 (파이프는 1초당 2개 = 120/분).

```jsonc
{
  "metersPerCell": 4,          // 1 그리드 셀 = 4m (전력 범위 원 크기에 사용)
  "categories": { "자원 채집": { "color": "#d97706" }, ... },
  "facilities": [
    {
      "id": "crusher",          // 고유 id (저장된 레이아웃이 참조하므로 변경 주의)
      "name": "분쇄기",
      "category": "기초 생산",   // categories 키 중 하나
      "icon": "🔨",
      "footprint": { "w": 3, "h": 3 },
      "powerDraw": 5,           // 전력 소비량 (0 = 무전력)
      "inputs":  [{ "resource": "정련 오리지늄", "rate": 30 }],
      "outputs": [{ "resource": "오리지늄 가루", "rate": 30 }],
      "note": "정보 패널에 표시되는 설명"
    }
  ]
}
```

특수 필드:

- `"powerSource": true` — 프로토콜 코어처럼 전력의 원천이 되는 설비 (전력 체인의 시작점)
- `"powerRange": 80` — 전력 공급 범위(미터). 중계기는 활성 전력원 범위 안에 있어야 연쇄 활성화됨
- `"passthrough": true` — 분류기/합류기처럼 들어온 리소스를 그대로 흘려보내는 물류 설비 (`"resource": "any"` 포트와 함께 사용)
- `"maxPerBase": 12` — 정보 표시용 (천화로 등)

컨베이어 벨트·파이프 자체는 팔레트에 없습니다 — 두 설비의 포트를 잇는 **연결선**이 벨트/파이프입니다. 교차가 필요하면 물류 브리지 설비를 사용하세요.

## 레이아웃 JSON 형식

```json
{
  "v": 1,
  "modules": [{ "id": 1, "typeId": "crusher", "x": 0, "y": 0, "rot": 90 }],
  "connections": [{ "id": 5, "fromModuleId": 1, "fromPort": "out:0", "toModuleId": 2, "toPort": "in:0" }]
}
```

포트 키는 `in:<index>` / `out:<index>`로, `facilities.json`의 inputs/outputs 배열 순서를 가리킵니다.
