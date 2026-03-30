import 'dotenv/config';
import { Client, GatewayIntentBits, Message } from 'discord.js';
import OpenAI from 'openai';
import express from 'express';
import cors from 'cors';
import path from 'path';

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
    const reply = await askGLM(userMessage);

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

// ─── 공통 GLM 호출 함수 ───
async function askGLM(userMessage: string): Promise<string> {
  const response = await glm.chat.completions.create({
    model: 'glm-z1-airx',  // GLM 5.1
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    max_tokens: 1024,
  });
  return response.choices[0]?.message?.content || '응답을 생성하지 못했습니다.';
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
    const reply = await askGLM(message);
    res.json({ reply });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'GLM API 오류' });
  }
});

// ─── 서버 시작 ───
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Web UI: http://localhost:${PORT}`);
});

// 디스코드 토큰이 있으면 봇도 시작
if (process.env.DISCORD_TOKEN && process.env.DISCORD_TOKEN !== 'your_discord_bot_token_here') {
  client.login(process.env.DISCORD_TOKEN);
} else {
  console.log('Discord token not set — bot offline, web UI only mode');
}
