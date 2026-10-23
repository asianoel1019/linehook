/**
 * 規則模擬器：以「只讀」方式跑一遍收訊管線的比對邏輯，回答
 * 「這則訊息進來會發生什麼事」——不發送、不執行技能、不累計限流。
 * 比對邏輯全部來自 src/messaging/dispatch.ts 的純函式，確保模擬與實際行為一致。
 */

import { config } from "../config.js";
import { getSkill } from "../skills/index.js";
import { effectiveMode } from "../skills/help.js";
import {
  analyzeAssistantPrefix,
  commandAllowed,
  isSkillThrottledNow,
  matchForwardRule,
  matchSkillEntry,
  parseCommandInput,
  selectTriggerHit,
  type TriggerHit,
} from "./dispatch.js";
import { SKILL_RATE_LIMIT_DEFAULT, SKILL_RATE_LIMIT_STRICT } from "./dispatch.js";
import { resolveAutoReply } from "../skills/auto-reply/index.js";
import { nowInTz } from "../time.js";

export interface SimulateInput {
  text: string;
  /** 對話／聊天識別（可留空 = 不限定）。 */
  chat: string;
  fromId: string;
  fromName: string;
  chatName: string;
}

export type SimulateOutcome = "hit" | "miss" | "blocked" | "skipped";

export interface SimulateStage {
  /** 管線階段（前端分組與排序用）。 */
  stage: "dedup" | "command" | "skill" | "forward";
  outcome: SimulateOutcome;
  /** 階段內的對象：技能名／指令／轉發目標。 */
  label: string;
  /** 說明（命中參數、未命中原因、轉發內容等）。 */
  detail: string;
  /** 轉發規則命中的推導內容（預覽）。 */
  preview?: string;
}

export interface SimulateResult {
  text: string;
  /** 只喊助理名稱 → 回技能清單（後續技能比對不進行）。 */
  layer1: boolean;
  stages: SimulateStage[];
}

const ICON: Record<SimulateOutcome, string> = {
  hit: "✅",
  miss: "➖",
  blocked: "⛔",
  skipped: "⏭️",
};

/** 執行模擬（零副作用）。 */
export function simulateDispatch(input: SimulateInput): SimulateResult {
  const text = input.text ?? "";
  const stages: SimulateStage[] = [];

  if (!text.trim()) {
    return {
      text,
      layer1: false,
      stages: [
        {
          stage: "dedup",
          outcome: "skipped",
          label: "空訊息",
          detail: "沒有文字內容的技能/指令/轉發都不會進入流程（媒體訊息另計）。",
        },
      ],
    };
  }

  // ① 去重（模擬以新訊息 ID 進入，恆為未重複）
  stages.push({
    stage: "dedup",
    outcome: "skipped",
    label: "去重",
    detail: "模擬以全新訊息 ID 進入，視為未重複；實際重複的訊息會被丟棄。",
  });

  // ② 指令
  if (!config.commands.enabled) {
    stages.push({ stage: "command", outcome: "skipped", label: "指令", detail: "指令功能未啟用（/settings 可開）" });
  } else {
    const parsed = parseCommandInput(text);
    if (!parsed) {
      stages.push({
        stage: "command",
        outcome: "miss",
        label: "指令",
        detail: `不是指令（前綴「${config.commands.prefix || "!"}」）`,
      });
    } else if (!commandAllowed(input.fromId, input.chat)) {
      stages.push({
        stage: "command",
        outcome: "blocked",
        label: `指令 !${parsed.command}`,
        detail: "來源不在指令白名單（commands.allowFrom）",
      });
    } else {
      stages.push({
        stage: "command",
        outcome: "hit",
        label: `指令 !${parsed.command}`,
        detail: parsed.args ? `參數：「${parsed.args}」` : "無參數",
      });
    }
  }

  // ③ 技能（Layer 1 會短路）
  const prefix = analyzeAssistantPrefix(text, config.assistant.name, config.language);
  let layer1 = false;
  if (config.assistant.enabled && prefix.hasPrefix && prefix.rest === "") {
    layer1 = true;
    stages.push({
      stage: "skill",
      outcome: "hit",
      label: "Layer 1",
      detail: `只喊了「${prefix.assistant}」→ 回覆可用技能清單（不再比對個別技能）`,
    });
  }

  if (!layer1) {
    const prefixHits: TriggerHit[] = [];
    for (const skill of config.skills) {
      const def = getSkill(skill.id);
      const decision = matchSkillEntry(
        skill,
        def,
        { text, chat: input.chat, fromMid: input.fromId },
        prefix,
        config.assistant.enabled,
      );
      const name = def?.name ?? skill.id;

      if (decision.outcome === "skip-disabled") {
        stages.push({ stage: "skill", outcome: "skipped", label: name, detail: "技能已停用" });
        continue;
      }
      if (decision.outcome === "skip-no-def") {
        stages.push({
          stage: "skill",
          outcome: "skipped",
          label: skill.id,
          detail: "找不到技能定義（外部技能可能已移除）",
        });
        continue;
      }
      if (decision.outcome === "blocked-users") {
        stages.push({ stage: "skill", outcome: "blocked", label: name, detail: decision.reason ?? "白名單擋下" });
        continue;
      }
      if (decision.outcome === "layer2-usage") {
        stages.push({
          stage: "skill",
          outcome: "hit",
          label: name,
          detail: `Layer 2：${decision.trigger}＋問號 → 回覆用法說明`,
        });
        if (def) {
          prefixHits.push({ skill, def, trigger: decision.trigger ?? "", args: decision.args ?? "", usage: true });
        }
        continue;
      }
      if (decision.outcome === "miss") {
        stages.push({ stage: "skill", outcome: "miss", label: name, detail: decision.reason ?? "未命中" });
        continue;
      }

      // hit：附上模式、觸發詞、參數；另報限流與自動回覆判定（皆為當下唯讀近似）
      const mode = def ? effectiveMode(skill, def) : "assistant";
      const parts: string[] = [mode === "any" ? "每則訊息模式" : `助理模式・觸發詞「${decision.trigger}」`];
      if (def && mode !== "any") {
        prefixHits.push({
          skill,
          def,
          trigger: decision.trigger ?? "",
          args: decision.args ?? "",
          usage: false,
        });
      }
      if (decision.args) parts.push(`參數：「${decision.args}」`);
      let outcome: SimulateOutcome = "hit";
      if (skill.id === "auto-reply") {
        // 與真實 run 同一支決策函式：關鍵字 → 時段/星期 → 每來源冷卻
        const verdict = resolveAutoReply(skill.config, text, input.chat, input.fromId, nowInTz());
        parts.length = 0;
        if (verdict.outcome === "miss") {
          stages.push({ stage: "skill", outcome: "miss", label: name, detail: verdict.reason });
          continue;
        }
        parts.push(`命中規則「${verdict.rule.keyword}」（${verdict.rule.match ?? "exact"}）`);
        if (verdict.rule.text)
          parts.push(`回覆：「${verdict.rule.text.slice(0, 60)}${verdict.rule.text.length > 60 ? "…" : ""}」`);
        if (verdict.outcome === "blocked") {
          parts.push(`${verdict.reason} → 實際不會送出`);
          outcome = "blocked";
        }
      } else if (isSkillThrottledNow(skill.id, input.chat)) {
        const limit = SKILL_RATE_LIMIT_STRICT[skill.id] ?? SKILL_RATE_LIMIT_DEFAULT;
        parts.push(`但已達限流（每分 ${limit} 次）→ 實際不會執行`);
        outcome = "blocked";
      }
      stages.push({ stage: "skill", outcome, label: name, detail: parts.join("・") });
    }

    // 仲裁（與真實管線同一規則）：前綴命中多個時只執行最長觸發詞
    if (prefixHits.length >= 2) {
      const winner = selectTriggerHit(prefixHits);
      const losers = prefixHits.filter((h) => h !== winner).map((h) => h.skill.id);
      stages.push({
        stage: "skill",
        outcome: "hit",
        label: "仲裁",
        detail: winner
          ? `「${winner.trigger}」（${winner.skill.id}）最長勝出；${losers.join("、")} 略過不執行`
          : "無勝出者",
      });
    }
  }

  // ④ 轉發規則
  if (config.forward.length === 0) {
    stages.push({ stage: "forward", outcome: "skipped", label: "轉發規則", detail: "沒有設定轉發規則" });
  }
  for (const rule of config.forward) {
    const { matched, forwarded, reason } = matchForwardRule(rule, text, input.chat, input.chatName, input.fromName);
    const label = rule.target ? `→ ${rule.target}` : "→（未設定目標）";
    if (matched) {
      stages.push({
        stage: "forward",
        outcome: "hit",
        label,
        detail: `命中（${reason}）${rule.source ? `・來源限「${rule.source}」` : ""}`,
        preview: forwarded,
      });
    } else {
      stages.push({ stage: "forward", outcome: "miss", label, detail: `未命中：${reason}` });
    }
  }

  return { text, layer1, stages };
}

/** 純文字版（CLI 除錯／測試／log 用）。 */
export function renderSimulation(result: SimulateResult): string {
  const head = `[模擬] ${result.text || "（空）"}`;
  const lines = result.stages.map(
    (s) =>
      `${ICON[s.outcome]} ${stageName(s.stage)}｜${s.label}｜${s.detail}${s.preview ? `\n    預覽：${s.preview}` : ""}`,
  );
  return [head, ...lines].join("\n");
}

function stageName(stage: SimulateStage["stage"]): string {
  switch (stage) {
    case "dedup":
      return "去重";
    case "command":
      return "指令";
    case "skill":
      return "技能";
    case "forward":
      return "轉發";
  }
}
