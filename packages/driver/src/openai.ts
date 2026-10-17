import {
  DRIVER_SYSTEM_PROMPT,
  TOOL_SCHEMAS,
  executeToolCall,
  type Driver,
  type DriverContext,
  type DriverReview,
  type SimulatorTools,
} from './contract';

export interface OpenAICompatibleConfig {
  apiKey: string;
  /** e.g. https://api.openai.com/v1 — any OpenAI-compatible endpoint. */
  baseUrl?: string;
  model?: string;
  maxTurns?: number;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}

/**
 * OpenAICompatibleDriver — the user's chosen primary driver (cloud API first).
 *
 * Runs a real function-calling agent loop against any OpenAI-compatible
 * /chat/completions endpoint: the model reads metrics, drives the simulator
 * through the tool interface, and ends with a review. The API key is passed
 * in by the host app (UI settings / local env) and is never stored here.
 */
export class OpenAICompatibleDriver implements Driver {
  readonly kind = 'openai' as const;
  readonly label = '云端 LLM 驾驶员（OpenAI 兼容）';
  private cfg: Required<OpenAICompatibleConfig>;

  constructor(cfg: OpenAICompatibleConfig) {
    this.cfg = {
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl ?? 'https://api.openai.com/v1',
      model: cfg.model ?? 'gpt-4o-mini',
      maxTurns: cfg.maxTurns ?? 14,
    };
  }

  async review(tools: SimulatorTools, ctx: DriverContext): Promise<DriverReview> {
    if (!this.cfg.apiKey) {
      throw new Error(
        'OpenAICompatibleDriver: 没有配置 API key。请在驾驶员设置里填写（只存浏览器本地），或改用脚本驾驶员 / Ollama。',
      );
    }
    const transcript: string[] = [];
    const messages: ChatMessage[] = [
      { role: 'system', content: DRIVER_SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `题目：${ctx.problemName}\n${ctx.problemStatement}\n量级：${ctx.scaleNotes}\n\n` +
          `候选人提交的设计：\n${ctx.designSummary}\n\n` +
          `确定性结构检查已发现的问题（可信，可直接引用）：\n` +
          (ctx.structuralFindings.length
            ? ctx.structuralFindings.map((f) => `- [${f.severity}] ${f.title}：${f.detail}`).join('\n')
            : '（无）') +
          `\n\n可用测试用例：${ctx.availableCases.map((c) => `${c.id}「${c.name}」`).join('、')}\n\n` +
          `开始操作模拟器，最后给出评审结论。`,
      },
    ];

    let finalText = '';
    for (let turn = 0; turn < this.cfg.maxTurns; turn++) {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: this.cfg.model,
          messages,
          tools: TOOL_SCHEMAS,
          tool_choice: 'auto',
        }),
      });
      if (!res.ok) {
        throw new Error(`OpenAI-compatible API 请求失败：${res.status} ${await res.text()}`);
      }
      const data = (await res.json()) as {
        choices: { message: ChatMessage }[];
      };
      const msg = data.choices[0]?.message;
      if (!msg) break;
      messages.push(msg);
      const calls = msg.tool_calls ?? [];
      if (calls.length === 0) {
        finalText = msg.content ?? '';
        break;
      }
      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        } catch {
          args = {};
        }
        transcript.push(`🔧 ${call.function.name}(${JSON.stringify(args)})`);
        let result: unknown;
        try {
          result = await executeToolCall(tools, call.function.name, args);
        } catch (err) {
          result = `tool error: ${err instanceof Error ? err.message : String(err)}`;
        }
        transcript.push(`   → ${JSON.stringify(result).slice(0, 400)}`);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
    }

    if (!finalText) {
      finalText = '（模型在回合上限内没有给出最终评审；操作记录见 transcript。）';
    }
    return {
      summary: finalText,
      findings: ctx.structuralFindings.map((f) => ({
        severity: f.severity,
        title: `结构缺陷：${f.title}`,
        detail: f.detail,
        componentId: f.componentIds[0],
      })),
      transcript,
    };
  }
}
