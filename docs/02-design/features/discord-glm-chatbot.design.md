# Design: Discord GLM Chatbot 리팩토링

> Created: 2026-03-30
> Feature: discord-glm-chatbot
> Architecture: Option B — Clean Architecture
> Status: Draft

## Context Anchor

| 항목 | 내용 |
|------|------|
| **WHY** | 기존 단일턴 봇을 맥락 있는 대화가 가능한 AI 챗봇으로 업그레이드 |
| **WHO** | 디스코드 서버 멤버 (한국어 사용자) |
| **RISK** | ZhipuAI API 호환성, API 키/토큰 관리, 대화 기록 메모리 사용량 |
| **SUCCESS** | 멀티턴 대화 동작, 슬래시 커맨드 정상 등록, 웹 대시보드 완전 제어 |
| **SCOPE** | 기존 discordbot 프로젝트 리팩토링 (새 프로젝트 아님) |

---

## 1. Overview

기존 단일 파일 Discord 챗봇을 클린 아키텍처로 리팩토링.
중앙 이벤트 버스로 모듈 간 느슨한 결합을 달성하고,
웹 대시보드를 컨트롤센터로 활용하여 봇의 모든 설정/모니터링을 웹에서 처리.

### 아키텍처 다이어그램

```
┌─────────────────────────────────────────────────────┐
│                    index.ts                          │
│              (엔트리포인트 + 부트스트랩)                │
└──────────┬──────────┬──────────┬────────────────────┘
           │          │          │
    ┌──────▼──┐ ┌─────▼────┐ ┌──▼──────────┐
    │  bot/   │ │   ai/    │ │    web/      │
    │ Discord │ │  GLM 5.1 │ │  Dashboard   │
    │ Client  │ │  Client  │ │  Express+WS  │
    └────┬────┘ └────┬─────┘ └──────┬───────┘
         │           │              │
         └─────┬─────┘──────┬──────┘
               │            │
        ┌──────▼──────┐ ┌───▼──────┐
        │   events/   │ │  store/  │
        │ EventBus    │ │ Settings │
        │ (중앙 허브)  │ │ + Stats  │
        └─────────────┘ └──────────┘
```

### 데이터 흐름

```
[Discord 메시지] → bot/handlers → EventBus.emit('chat:message')
                                       ↓
                               ai/glm.askWithHistory()
                                       ↓
                               EventBus.emit('chat:response')
                                    ↓           ↓
                            bot/handlers    web/websocket
                            (디코 응답)     (대시보드 로그)
```

## 2. 파일 구조

```
src/
├── index.ts                 # 엔트리포인트 (부트스트랩)
├── config.ts                # 환경변수 + 상수 + 타입
├── events/
│   ├── emitter.ts           # 중앙 이벤트 버스 (싱글턴)
│   └── types.ts             # 이벤트 타입 정의
├── bot/
│   ├── client.ts            # Discord 클라이언트 생성 + 인텐트
│   ├── commands/
│   │   ├── index.ts         # 커맨드 등록 + deploy
│   │   ├── ask.ts           # /ask 커맨드
│   │   ├── reset.ts         # /reset 커맨드
│   │   ├── system.ts        # /system 커맨드
│   │   └── status.ts        # /status 커맨드
│   └── handlers.ts          # messageCreate + interactionCreate 핸들러
├── ai/
│   ├── glm.ts               # GLM API 클라이언트 (OpenAI SDK)
│   └── conversation.ts      # 대화 기록 관리 (Map + TTL)
├── web/
│   ├── server.ts            # Express 앱 + 미들웨어
│   ├── routes/
│   │   ├── settings.ts      # GET/PUT /api/settings
│   │   ├── chat.ts          # POST /api/chat (웹 테스트)
│   │   └── stats.ts         # GET /api/stats
│   └── websocket.ts         # WebSocket 서버 (실시간 로그)
└── store/
    ├── settings.ts           # 런타임 설정 (채널별 + 글로벌)
    └── stats.ts              # 사용량 통계 수집
public/
├── index.html               # 대시보드 SPA (탭 기반)
├── css/
│   └── dashboard.css        # 대시보드 스타일
└── js/
    └── dashboard.js          # 대시보드 로직
```

## 3. 모듈 상세 설계

### 3.1 config.ts

```typescript
interface Config {
  discord: {
    token: string;
    clientId: string;
  };
  zhipu: {
    apiKey: string;
    baseUrl: string;
    defaultModel: string;   // 'glm-4-plus' 기본, 웹에서 변경 가능
  };
  conversation: {
    maxHistory: number;      // 기본 20
    ttlMinutes: number;      // 기본 30
  };
  web: {
    port: number;            // 기본 3000
  };
}
```

### 3.2 events/ — 이벤트 버스

**emitter.ts**: Node.js EventEmitter 기반 싱글턴. 모든 모듈이 이 버스를 통해 통신.

**types.ts**: 이벤트 타입 정의
```typescript
interface ChatMessageEvent {
  channelId: string;
  userId: string;
  username: string;
  content: string;
  source: 'discord' | 'web';
  timestamp: Date;
}

interface ChatResponseEvent {
  channelId: string;
  content: string;
  model: string;
  tokensUsed: number;
  latencyMs: number;
  timestamp: Date;
}

interface SettingsChangedEvent {
  scope: 'global' | 'channel';
  channelId?: string;
  changes: Partial<BotSettings>;
}

// 이벤트 맵
interface EventMap {
  'chat:message': ChatMessageEvent;
  'chat:response': ChatResponseEvent;
  'chat:error': { error: Error; channelId: string };
  'settings:changed': SettingsChangedEvent;
  'bot:ready': { tag: string; guilds: number };
  'bot:error': { error: Error };
}
```

### 3.3 ai/glm.ts — GLM 클라이언트

```typescript
class GLMClient {
  private openai: OpenAI;

  constructor(config: Config['zhipu']) {}

  async ask(
    messages: ChatMessage[],
    model?: string
  ): Promise<{ content: string; tokensUsed: number }> {}
}
```

- OpenAI SDK 사용 (ZhipuAI 호환)
- 모델: 기본 `glm-4-plus`, 웹에서 변경 가능 (glm-4-flash, glm-4-plus 등)
- GLM 5.1 모델명은 ZhipuAI 문서 확인 후 적용

### 3.4 ai/conversation.ts — 대화 기록

```typescript
class ConversationManager {
  private histories: Map<string, ChatMessage[]>;
  private lastActive: Map<string, number>;

  addMessage(channelId: string, role: 'user'|'assistant', content: string): void {}
  getHistory(channelId: string): ChatMessage[] {}
  clear(channelId: string): void {}
  clearExpired(): void {}  // TTL 기반 정리 (setInterval)
}
```

- 채널 ID 기준 저장
- 최대 기록 수: settings에서 동적 변경 가능
- 30분 TTL 자동 정리

### 3.5 bot/commands/ — 슬래시 커맨드

| 파일 | 커맨드 | 동작 |
|------|--------|------|
| `ask.ts` | `/ask message:` | GLM에 질문, 대화 기록에 추가 |
| `reset.ts` | `/reset` | 현재 채널 대화 기록 초기화 |
| `system.ts` | `/system prompt:` | 채널 시스템 프롬프트 변경 |
| `status.ts` | `/status` | 봇 상태 + 현재 설정 표시 |
| `index.ts` | — | 커맨드 등록 + Discord REST API deploy |

### 3.6 store/settings.ts — 설정 저장소

```typescript
interface BotSettings {
  systemPrompt: string;
  model: string;
  maxHistory: number;
  temperature: number;
}

class SettingsStore {
  private global: BotSettings;
  private channels: Map<string, Partial<BotSettings>>;

  getForChannel(channelId: string): BotSettings {}  // 채널설정 + 글로벌 fallback
  setGlobal(settings: Partial<BotSettings>): void {}
  setChannel(channelId: string, settings: Partial<BotSettings>): void {}
  removeChannel(channelId: string): void {}
  toJSON(): object {}  // 직렬화 (웹 API용)
}
```

### 3.7 store/stats.ts — 통계

```typescript
class StatsCollector {
  private data: {
    totalMessages: number;
    totalTokens: number;
    messagesByChannel: Map<string, number>;
    messagesByUser: Map<string, number>;
    startedAt: Date;
  };

  recordMessage(event: ChatResponseEvent): void {}
  getSummary(): StatsSummary {}
}
```

### 3.8 web/routes/ — API 엔드포인트

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/status` | 봇 상태 (온라인, 서버 수, 업타임) |
| GET | `/api/settings` | 글로벌 + 채널별 설정 조회 |
| PUT | `/api/settings` | 글로벌 설정 변경 |
| PUT | `/api/settings/channel/:id` | 채널별 설정 변경 |
| DELETE | `/api/settings/channel/:id` | 채널 설정 삭제 (글로벌 폴백) |
| POST | `/api/chat` | 웹 채팅 테스트 |
| GET | `/api/stats` | 사용량 통계 |
| GET | `/api/channels` | 봇이 접속한 채널 목록 |

### 3.9 web/websocket.ts — 실시간 통신

```typescript
// WebSocket 메시지 타입
type WSMessage =
  | { type: 'log'; data: ChatMessageEvent | ChatResponseEvent }
  | { type: 'status'; data: BotStatus }
  | { type: 'stats'; data: StatsSummary };
```

- EventBus의 `chat:message`, `chat:response` 이벤트를 WebSocket으로 브로드캐스트
- 10초마다 stats 업데이트 푸시

## 4. 웹 대시보드 UI 설계

### 4.1 탭 구조

| 탭 | 내용 |
|----|------|
| Dashboard | 봇 상태, 핵심 통계, 최근 활동 요약 |
| Live Logs | 실시간 대화 로그 스트림 (WebSocket) |
| Settings | 글로벌 설정 + 채널별 설정 관리 |
| Chat Test | 웹에서 직접 GLM API 테스트 |

### 4.2 디자인 토큰

```
배경:      #0f0f23 (메인), #1a1a3e (카드), #252550 (입력)
강조:      #e94560 (프라이머리), #53a8b6 (세컨더리)
텍스트:    #e0e0e0 (기본), #888 (서브), #4ade80 (성공), #f87171 (에러)
폰트:      'Segoe UI', -apple-system, sans-serif
라운딩:    8px (카드), 6px (입력/버튼)
```

## 5. 의존성

### 기존 유지
- `discord.js` ^14 — Discord 봇
- `openai` ^6 — ZhipuAI 호환 API
- `express` ^5 — 웹 서버
- `dotenv` — 환경변수
- `cors` — CORS

### 신규 추가
- `ws` — WebSocket 서버
- `@types/ws` — WS 타입

### 삭제 가능
- (없음 — 기존 의존성 모두 유지)

## 6. .env 구조

```env
DISCORD_TOKEN=your_discord_bot_token
DISCORD_CLIENT_ID=your_client_id
ZHIPU_API_KEY=your_zhipu_api_key
PORT=3000
```

## 7. 에러 처리

| 상황 | 처리 |
|------|------|
| GLM API 타임아웃 | 30초 타임아웃 → "응답 시간이 초과되었습니다" |
| GLM API 에러 | 에러 로그 + "AI 응답 중 오류가 발생했습니다" |
| Discord 토큰 미설정 | 웹 UI 전용 모드로 실행 (기존 동작 유지) |
| WebSocket 연결 끊김 | 자동 재연결 (클라이언트 측 3초 간격) |

## 8. 테스트 계획

| ID | 테스트 | 방법 |
|----|--------|------|
| T1 | GLM API 응답 | 웹 Chat Test에서 메시지 전송 확인 |
| T2 | 멀티턴 대화 | 연속 질문 후 맥락 유지 확인 |
| T3 | 슬래시 커맨드 | Discord에서 /ask, /reset, /system, /status 테스트 |
| T4 | 설정 변경 반영 | 웹에서 설정 변경 → 봇 응답에 즉시 반영 확인 |
| T5 | 실시간 로그 | Discord 대화 → 웹 Live Logs에 실시간 표시 확인 |
| T6 | 채널별 설정 | 채널 A, B에 다른 설정 → 각각 다른 응답 확인 |
| T7 | 통계 수집 | 대화 후 Stats 페이지에 수치 증가 확인 |

## 9. 보안

- `.env` 파일은 `.gitignore`에 포함 (이미 적용됨)
- 웹 대시보드는 localhost 전용 (외부 노출 시 인증 필요 — 향후)
- API 키는 서버 사이드에서만 사용, 프론트에 노출 안 함

## 10. 향후 확장

- 대시보드 인증 (비밀번호/토큰)
- 설정 영속화 (JSON 파일 저장)
- 여러 서버(Guild) 지원
- 이미지 생성 (CogView) 연동

## 11. Implementation Guide

### 11.1 구현 순서

| 순서 | 모듈 | 파일 | 의존성 |
|------|------|------|--------|
| 1 | config | `config.ts` | 없음 |
| 2 | events | `events/emitter.ts`, `events/types.ts` | config |
| 3 | store | `store/settings.ts`, `store/stats.ts` | events |
| 4 | ai | `ai/glm.ts`, `ai/conversation.ts` | config, events, store |
| 5 | bot | `bot/client.ts`, `bot/commands/*`, `bot/handlers.ts` | ai, events, store |
| 6 | web | `web/server.ts`, `web/routes/*`, `web/websocket.ts` | events, store, ai |
| 7 | dashboard | `public/index.html`, `css/`, `js/` | web API |
| 8 | entry | `index.ts` | 전체 |

### 11.2 예상 규모

- 새로 생성: 18 파일
- 수정: 0 파일 (기존 index.ts는 완전 교체)
- 삭제: 1 파일 (기존 src/index.ts → 새 구조로 대체)
- 총 예상 코드량: ~1200 lines

### 11.3 Session Guide

| 세션 | 모듈 | scope 키 | 예상 라인 |
|------|------|----------|-----------|
| Session 1 | config + events + store | `module-1` | ~200 |
| Session 2 | ai (GLM + conversation) | `module-2` | ~200 |
| Session 3 | bot (client + commands + handlers) | `module-3` | ~300 |
| Session 4 | web (server + routes + websocket) | `module-4` | ~250 |
| Session 5 | dashboard (HTML + CSS + JS) | `module-5` | ~400 |
| Session 6 | index.ts 통합 + 테스트 | `module-6` | ~50 |
