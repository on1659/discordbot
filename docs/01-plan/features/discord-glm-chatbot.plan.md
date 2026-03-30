# Plan: Discord GLM Chatbot 리팩토링

> Created: 2026-03-30
> Feature: discord-glm-chatbot
> Level: Dynamic (Starter+)
> Status: Draft

## Executive Summary

| 항목 | 내용 |
|------|------|
| Feature | Discord GLM 5.1 Chatbot 전체 리팩토링 |
| 시작일 | 2026-03-30 |
| 예상 기간 | 1 세션 |

### Value Delivered

| 관점 | 내용 |
|------|------|
| **Problem** | 기존 봇이 단일 턴 대화만 지원하고, 구조가 단일 파일에 집중되어 유지보수 어려움 |
| **Solution** | GLM 5.1 업그레이드 + 멀티턴 대화 + 슬래시 커맨드 + 웹 대시보드 컨트롤센터 |
| **Function UX Effect** | 웹에서 봇 설정/모니터링, 실시간 대화 로그, 채널별 설정, 사용량 통계 |
| **Core Value** | 웹 대시보드로 봇을 완전 제어하며 고품질 AI 대화 경험 제공 |

## Context Anchor

| 항목 | 내용 |
|------|------|
| **WHY** | 기존 단일턴 봇을 맥락 있는 대화가 가능한 AI 챗봇으로 업그레이드 |
| **WHO** | 디스코드 서버 멤버 (한국어 사용자) |
| **RISK** | ZhipuAI API 호환성, API 키/토큰 관리, 대화 기록 메모리 사용량 |
| **SUCCESS** | 멀티턴 대화 동작, 슬래시 커맨드 정상 등록, 웹 UI 정상 작동 |
| **SCOPE** | 기존 discordbot 프로젝트 리팩토링 (새 프로젝트 아님) |

---

## 1. 배경 및 현황

### 현재 상태
- **기술 스택**: TypeScript + discord.js + OpenAI SDK (ZhipuAI 호환)
- **모델**: `glm-4-plus` (업그레이드 필요)
- **구조**: 단일 파일 (`src/index.ts`) — 봇, API, 웹서버 모두 포함
- **기능**: `!zai` 프리픽스 또는 @멘션으로 단일 턴 대화
- **웹 UI**: Express 기반 대시보드 + 채팅 테스트

### 문제점
1. 대화 맥락 유지 안 됨 (매 메시지가 독립적)
2. 단일 파일에 모든 로직 집중 — 유지보수 어려움
3. `glm-4-plus` 모델 — 최신 GLM 5.1로 업그레이드 필요
4. 슬래시 커맨드 미지원 (텍스트 프리픽스만 사용)
5. 시스템 프롬프트 하드코딩

## 2. 요구사항

### 핵심 요구사항 (Must-Have)
| ID | 요구사항 | 설명 |
|----|----------|------|
| R1 | GLM 5.1 모델 업그레이드 | `glm-4-plus` → GLM 5.1 모델로 변경 |
| R2 | 멀티턴 대화 기억 | 채널/사용자별 최근 N개 대화 기록 유지 |
| R3 | 코드 모듈화 | 봇/API/GLM 호출을 별도 모듈로 분리 |
| R4 | 슬래시 커맨드 | `/ask`, `/reset`, `/system` 등 Discord 슬래시 커맨드 |
| R5 | 시스템 프롬프트 커스터마이징 | 서버별 봇 성격 설정 가능 |

### 핵심 요구사항 — 웹 대시보드 (Must-Have)
| ID | 요구사항 | 설명 |
|----|----------|------|
| R6 | 봇 설정 패널 | 시스템 프롬프트, 모델 선택, 대화 기록 수 등 웹에서 설정 |
| R7 | 실시간 대화 로그 | 디스코드 채널의 봇 대화를 웹에서 실시간 확인 (WebSocket) |
| R8 | 채널별 설정 | 채널별로 다른 시스템 프롬프트/모델 설정 가능 |
| R9 | 사용량 통계 | 총 메시지 수, 토큰 사용량, 활성 채널 등 통계 |
| R10 | 채팅 테스트 | 웹에서 직접 GLM API 테스트 (기존 기능 유지/개선) |

### 부가 요구사항 (Nice-to-Have)
| ID | 요구사항 | 설명 |
|----|----------|------|
| R11 | 에러 핸들링 강화 | API 타임아웃, Rate limit 처리 |

## 3. 기술 결정

| 항목 | 결정 | 이유 |
|------|------|------|
| 언어 | TypeScript (유지) | 기존 프로젝트 기반, discord.js 생태계 |
| AI SDK | OpenAI SDK (유지) | ZhipuAI가 OpenAI 호환 API 제공 |
| 대화 저장 | In-memory Map | 단일 서버용, DB 불필요 |
| 슬래시 커맨드 | discord.js REST API | 네이티브 지원 |
| 실시간 통신 | WebSocket (ws) | 대시보드↔봇 실시간 로그/상태 |
| 대시보드 프론트 | Vanilla HTML/CSS/JS | 별도 빌드 도구 없이 즉시 사용 |

## 4. 파일 구조 (리팩토링 후)

```
src/
├── index.ts              # 엔트리포인트 (서버 + 봇 시작)
├── config.ts             # 환경변수, 상수, 기본 설정
├── bot/
│   ├── client.ts         # Discord 클라이언트 설정
│   ├── commands.ts       # 슬래시 커맨드 정의 및 등록
│   └── handlers.ts       # 메시지/커맨드 이벤트 핸들러
├── ai/
│   └── glm.ts            # GLM API 클라이언트 + 대화 기록 관리
├── web/
│   ├── server.ts         # Express 웹 서버 + API 라우트
│   └── websocket.ts      # WebSocket 서버 (실시간 로그/상태)
└── store/
    └── settings.ts       # 런타임 설정 저장소 (채널별 설정, 통계)
public/
├── index.html            # 대시보드 메인 (탭 기반 SPA)
├── css/
│   └── dashboard.css     # 대시보드 스타일
└── js/
    └── dashboard.js      # 대시보드 로직 (WebSocket, API 호출)
```

## 5. 슬래시 커맨드 설계

| 커맨드 | 설명 | 옵션 |
|--------|------|------|
| `/ask` | AI에게 질문 | `message`: string (필수) |
| `/reset` | 대화 기록 초기화 | 없음 |
| `/system` | 시스템 프롬프트 변경 | `prompt`: string (필수) |
| `/status` | 봇 상태 확인 | 없음 |

## 6. 대화 기록 관리

- **저장 단위**: 채널 ID 기준
- **최대 기록**: 최근 20개 메시지 (user + assistant)
- **만료**: 30분 비활동 시 자동 삭제
- **초기화**: `/reset` 커맨드로 수동 초기화

## 7. 디스코드 봇 토큰 발급 가이드

사용자에게 Discord Bot 토큰이 아직 없으므로 설정 가이드 필요:
1. Discord Developer Portal 접속
2. New Application 생성
3. Bot 탭에서 토큰 생성
4. Privileged Gateway Intents 활성화 (Message Content Intent)
5. OAuth2 URL Generator로 초대 링크 생성
6. 서버에 봇 초대

## 8. 성공 기준

| ID | 기준 | 측정 방법 |
|----|------|-----------|
| SC1 | GLM 5.1 모델로 정상 응답 | API 호출 후 응답 확인 |
| SC2 | 멀티턴 대화 유지 | 이전 대화 내용 참조하는 응답 확인 |
| SC3 | 슬래시 커맨드 4개 정상 동작 | 각 커맨드 실행 테스트 |
| SC4 | 코드 모듈 5개 이상 분리 | 파일 구조 확인 |
| SC5 | 웹 대시보드 설정 패널 | 시스템 프롬프트/모델 변경이 봇에 즉시 반영 |
| SC6 | 실시간 대화 로그 | WebSocket으로 디스코드 대화가 웹에 실시간 표시 |
| SC7 | 채널별 설정 | 채널마다 다른 설정 적용 확인 |
| SC8 | 사용량 통계 | 메시지 수, 활성 채널 등 통계 표시 |

## 9. 리스크

| 리스크 | 영향 | 대응 |
|--------|------|------|
| GLM 5.1 모델명 불확실 | API 호출 실패 | ZhipuAI 문서 확인, 폴백 모델 설정 |
| Discord Bot 토큰 미보유 | 봇 실행 불가 | 발급 가이드 제공, 웹 UI만 먼저 테스트 |
| API Rate Limit | 응답 지연/실패 | 큐잉 + 재시도 로직 |

## 10. 구현 우선순위

1. **Phase 1**: config + store 모듈 (설정/통계 저장소)
2. **Phase 2**: GLM 모듈 (모델 업그레이드 + 대화 기록 관리)
3. **Phase 3**: Discord 봇 모듈 (클라이언트 + 핸들러 + 슬래시 커맨드)
4. **Phase 4**: 웹 서버 + WebSocket (API 라우트 + 실시간 통신)
5. **Phase 5**: 웹 대시보드 UI (설정 패널 + 로그 뷰어 + 통계 + 채팅 테스트)
6. **Phase 6**: 엔트리포인트 통합 + 테스트
