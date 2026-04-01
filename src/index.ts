import 'dotenv/config';
import { Client, GatewayIntentBits, Message } from 'discord.js';
import OpenAI from 'openai';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { Pool } from 'pg';

// ─── Express 웹 서버 ───
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── GLM API 클라이언트 ───
const glm = new OpenAI({
  apiKey: process.env.ZHIPU_API_KEY,
  baseURL: 'https://open.bigmodel.cn/api/paas/v4',
});

const SYSTEM_PROMPT = '당신은 친절한 디스코드 챗봇입니다. 한국어로 대화합니다.';
const MAX_HISTORY = 20;

// ─── 모델 등급 ───
const MODEL_TIERS: Record<string, { model: string; label: string }> = {
  '박사': { model: 'glm-5-turbo', label: '박사 (GLM-5-Turbo)' },
  '석사': { model: 'glm-5', label: '석사 (GLM-5)' },
  '고졸': { model: 'glm-4.7-flash', label: '고졸 (GLM-4.7-Flash)' },
};
const DEFAULT_TIER = '고졸';
const userTiers = new Map<string, string>(); // userId → tier name

// ─── PostgreSQL ───
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_conversations_session
    ON conversations (session_id, created_at)
  `);
  console.log('DB initialized');
}

async function addToSession(sessionId: string, role: 'user' | 'assistant', content: string) {
  await pool.query(
    'INSERT INTO conversations (session_id, role, content) VALUES ($1, $2, $3)',
    [sessionId, role, content]
  );

  // MAX_HISTORY * 2 초과 시 오래된 것 삭제
  await pool.query(`
    DELETE FROM conversations WHERE id IN (
      SELECT id FROM conversations
      WHERE session_id = $1
      ORDER BY created_at DESC
      OFFSET $2
    )
  `, [sessionId, MAX_HISTORY * 2]);
}

async function getHistory(sessionId: string): Promise<{ role: string; content: string }[]> {
  const result = await pool.query(
    'SELECT role, content FROM conversations WHERE session_id = $1 ORDER BY created_at ASC',
    [sessionId]
  );
  return result.rows;
}

// ─── 디스코드 봇 ───
let discordReady = false;
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.on('ready', () => {
  discordReady = true;
  console.log(`Discord bot logged in as ${client.user?.tag}`);
});

client.on('messageCreate', async (message: Message) => {
  if (message.author.bot) return;

  // !학력 커맨드 — 모델 등급 선택
  if (message.content.startsWith('!학력')) {
    const arg = message.content.replace(/^!학력\s*/, '').trim();
    if (!arg) {
      const current = userTiers.get(message.author.id) || DEFAULT_TIER;
      const list = Object.entries(MODEL_TIERS)
        .map(([name, t]) => `${name === current ? '▸' : '  '} **${name}** — ${t.model}`)
        .join('\n');
      await message.reply(
        `🎓 현재 학력: **${current}**\n\n${list}\n\n변경: \`!학력 박사\` / \`!학력 석사\` / \`!학력 고졸\``
      );
      return;
    }
    if (MODEL_TIERS[arg]) {
      userTiers.set(message.author.id, arg);
      await message.reply(`🎓 학력이 **${MODEL_TIERS[arg]!.label}**로 변경되었습니다!`);
    } else {
      await message.reply(`❌ 없는 학력입니다. 선택지: ${Object.keys(MODEL_TIERS).join(' / ')}`);
    }
    return;
  }

  if (!message.content.startsWith('!zai') && !message.mentions.has(client.user!)) return;

  const userMessage = message.content
    .replace(/^!zai\s*/, '')
    .replace(/<@!?\d+>\s*/g, '')
    .trim();

  if (!userMessage) {
    await message.reply('메시지를 입력해주세요! 예: `!zai 안녕하세요`');
    return;
  }

  try {
    if ('sendTyping' in message.channel) {
      await message.channel.sendTyping();
    }
    const sessionId = `discord:${message.author.id}`;
    const tier = userTiers.get(message.author.id) || DEFAULT_TIER;
    const model = MODEL_TIERS[tier]!.model;
    const reply = await askGLM(userMessage, sessionId, model);

    if (reply.length > 2000) {
      const chunks = reply.match(/.{1,2000}/gs) || [];
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    } else {
      await message.reply(reply);
    }
  } catch (error) {
    console.error('GLM API Error:', error);
    await message.reply('AI 응답 중 오류가 발생했습니다.');
  }
});

// ─── 공통 GLM 호출 함수 (세션 기반) ───
async function askGLM(userMessage: string, sessionId: string, model: string = 'glm-5'): Promise<string> {
  await addToSession(sessionId, 'user', userMessage);
  const history = await getHistory(sessionId);

  const response = await glm.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ],
    max_tokens: 1024,
  });
  const reply = response.choices[0]?.message?.content || '응답을 생성하지 못했습니다.';
  await addToSession(sessionId, 'assistant', reply);
  return reply;
}

// ─── Web API 라우트 ───

// 상태 확인
app.get('/api/status', (_req, res) => {
  res.json({
    discord: discordReady,
    botTag: client.user?.tag || null,
    guilds: client.guilds?.cache.size || 0,
  });
});

// 웹 UI에서 직접 채팅 테스트
app.post('/api/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) {
    res.status(400).json({ error: '메시지를 입력해주세요.' });
    return;
  }

  try {
    const sessionId = req.body.sessionId || 'web:anonymous';
    const reply = await askGLM(message, sessionId);
    res.json({ reply, sessionId });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'GLM API 오류' });
  }
});

// ─── 서버 시작 ───
const PORT = process.env.PORT || 3000;

async function start() {
  await initDB();

  app.listen(PORT, () => {
    console.log(`Web UI: http://localhost:${PORT}`);
  });

  if (process.env.DISCORD_TOKEN && process.env.DISCORD_TOKEN !== 'your_discord_bot_token_here') {
    client.login(process.env.DISCORD_TOKEN);
  } else {
    console.log('Discord token not set — bot offline, web UI only mode');
  }
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
