import { chat, clearHistory, getHistory, llmConfigFrom, logLlmError, pushHistory, type ChatMessage } from "../llm.js";
import type { SkillContext, SkillDefinition } from "../types.js";

const aiSkill: SkillDefinition = {
  id: "ai",
  name: "AI 助理",
  description: {
    zh: "接 LLM 回覆問題。可設定為前綴呼叫（阿寶 問 …）或被動回覆（每則訊息）。",
    en: "Answer questions with an LLM. Can be prefix-triggered (Abao ask …) or passive (every message).",
    ja: "LLM で質問に回答します。プレフィックス呼び出し（阿寶 問 …）またはパッシブ（毎メッセージ）に対応。",
  },
  usage: { zh: "問 台灣最高的山", en: "ask the tallest mountain in Taiwan", ja: "問 台湾で一番高い山" },
  category: { zh: "智慧助理", en: "Assistant", ja: "アシスタント" },
  defaultTrigger: "問",
  triggerAliases: ["ai", "gpt", "問ai", "助理"],
  triggerMode: "assistant",
  fields: [
    {
      key: "mode",
      label: { zh: "觸發方式", en: "Trigger mode", ja: "トリガー方式" },
      type: "select",
      options: [
        { value: "assistant", label: "前綴呼叫（<助理> 問 …）" },
        { value: "any", label: "被動（每則訊息）" },
      ],
    },
    {
      key: "provider",
      label: { zh: "供應商", en: "Provider", ja: "プロバイダー" },
      type: "select",
      options: [
        { value: "openai", label: "OpenAI" },
        { value: "gemini", label: "Gemini" },
        { value: "opencode", label: "OpenCode" },
        { value: "local", label: "本地自建（OpenAI 相容 / Ollama）" },
        { value: "custom", label: "自訂端點" },
      ],
    },
    { key: "baseUrl", label: "Base URL", hint: "留空用各供應商預設" },
    { key: "apiKey", label: { zh: "API Key", en: "API Key", ja: "API キー" }, secret: true, hint: "本地自建可留空" },
    { key: "model", label: { zh: "模型", en: "Model", ja: "モデル" }, hint: "留空用預設（例：gpt-4o-mini / gemini-2.0-flash）" },
    { key: "systemPrompt", label: "系統提示", type: "textarea", hint: "選填，例如「你是阿寶，用繁體中文簡短回答」" },
    { key: "temperature", label: "Temperature", hint: "預設 0.7" },
    { key: "maxTokens", label: "最大回覆 tokens", hint: "預設 2048；回覆被截斷時可調高" },
    { key: "timeoutMs", label: "逾時（ms）", hint: "預設 30000" },
    {
      key: "memory",
      label: "對話記憶",
      type: "select",
      options: [
        { value: "off", label: "關閉" },
        { value: "on", label: "開啟" },
      ],
    },
    { key: "memoryTurns", label: "記憶輪數", hint: "預設 6 輪" },
  ],
  async run(ctx: SkillContext): Promise<void> {
    const cfg = llmConfigFrom(ctx.config);
    const memoryOn = (ctx.config.memory || "off") === "on";
    const turns = Number(ctx.config.memoryTurns ?? "6") || 6;

    if (/^(清除記憶|忘記|reset|reset記憶)/i.test(ctx.args.trim())) {
      clearHistory(ctx.chat);
      await ctx.reply("已清除本對話的記憶。");
      return;
    }

    const question = (ctx.args || ctx.text || "").trim();
    if (!question) {
      await ctx.reply("請輸入問題，例如：阿寶 問 台灣最高的山");
      return;
    }

    const messages: ChatMessage[] = [];
    if (cfg.systemPrompt) messages.push({ role: "system", content: cfg.systemPrompt });
    if (memoryOn) messages.push(...getHistory(ctx.chat));
    // G4：IM 原文標記為不可信內容，避免被當成系統指令。
    messages.push({ role: "user", content: `<untrusted-user-content>\n${question}\n</untrusted-user-content>` });

    try {
      const answer = await chat(cfg, messages, { skill: "ai" });
      await ctx.reply(answer);
      if (memoryOn) {
        pushHistory(
          ctx.chat,
          [
            { role: "user", content: question },
            { role: "assistant", content: answer },
          ],
          turns,
        );
      }
    } catch (error) {
      logLlmError("ai", error);
      await ctx.reply(`AI 回覆失敗：${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

export default aiSkill;
