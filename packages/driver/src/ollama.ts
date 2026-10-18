import {
  DRIVER_SYSTEM_PROMPT,
  TOOL_SCHEMAS,
  buildFollowUpPrompt,
  buildProbePrompt,
  buildSchemaPrompt,
  buildSubmissionPrompt,
  executeToolCall,
  parseFollowUps,
  parseProbeCases,
  parseSchemaAssessment,
  parseSubmissionAssessment,
  type Driver,
  type DriverContext,
  type DriverReview,
  type FollowUpContext,
  type FollowUpQuestion,
  type ProbeCase,
  type ProbeContext,
  type SchemaAssessment,
  type SchemaAssessmentContext,
  type SimulatorTools,
  type SubmissionAssessment,
  type SubmissionAssessmentContext,
} from './contract';

export interface OllamaConfig {
  /** Default http://localhost:11434 */
  baseUrl?: string;
  /** A tool-calling capable model, e.g. qwen3:30b */
  model?: string;
  maxTurns?: number;
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
}

/**
 * OllamaDriver — local fallback implementing the same Driver contract via
 * Ollama's /api/chat tool-calling. Requires Ollama running locally with a
 * tool-capable model pulled (e.g. `ollama pull qwen3:30b`).
 */
export class OllamaDriver implements Driver {
  readonly kind = 'ollama' as const;
  readonly label = 'Ollama 本地模型';
  private cfg: Required<OllamaConfig>;

  constructor(cfg: OllamaConfig = {}) {
    this.cfg = {
      baseUrl: cfg.baseUrl ?? 'http://localhost:11434',
      model: cfg.model ?? 'qwen3:30b',
      maxTurns: cfg.maxTurns ?? 14,
    };
  }

  async review(tools: SimulatorTools, ctx: DriverContext): Promise<DriverReview> {
    const transcript: string[] = [];
    const messages: OllamaMessage[] = [
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
      let res: Response;
      try {
        res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.cfg.model,
            messages,
            tools: TOOL_SCHEMAS,
            stream: false,
          }),
        });
      } catch {
        throw new Error(
          `OllamaDriver: 连不上 Ollama（${this.cfg.baseUrl}）。请先本地启动 Ollama 并拉取工具调用模型，例如：ollama pull ${this.cfg.model}`,
        );
      }
      if (!res.ok) {
        throw new Error(`Ollama 请求失败：${res.status} ${await res.text()}`);
      }
      const data = (await res.json()) as { message: OllamaMessage };
      const msg = data.message;
      if (!msg) break;
      messages.push(msg);
      const calls = msg.tool_calls ?? [];
      if (calls.length === 0) {
        finalText = msg.content ?? '';
        break;
      }
      for (const call of calls) {
        const args = call.function.arguments ?? {};
        transcript.push(`🔧 ${call.function.name}(${JSON.stringify(args)})`);
        let result: unknown;
        try {
          result = await executeToolCall(tools, call.function.name, args);
        } catch (err) {
          result = `tool error: ${err instanceof Error ? err.message : String(err)}`;
        }
        transcript.push(`   → ${JSON.stringify(result).slice(0, 400)}`);
        messages.push({ role: 'tool', content: JSON.stringify(result) });
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

  // ------------------------------------------- qualitative assessment ---

  private async chatJson(system: string, user: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.cfg.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          format: 'json',
          stream: false,
        }),
      });
    } catch {
      throw new Error(`OllamaDriver: 连不上 Ollama（${this.cfg.baseUrl}）。`);
    }
    if (!res.ok) {
      throw new Error(`Ollama 请求失败：${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { message: OllamaMessage };
    return JSON.parse(data.message?.content ?? '') as unknown;
  }

  async assessSubmission(ctx: SubmissionAssessmentContext): Promise<SubmissionAssessment> {
    const p = buildSubmissionPrompt(ctx);
    return parseSubmissionAssessment(await this.chatJson(p.system, p.user));
  }

  async generateFollowUps(ctx: FollowUpContext): Promise<FollowUpQuestion[]> {
    const p = buildFollowUpPrompt(ctx);
    return parseFollowUps(await this.chatJson(p.system, p.user));
  }

  async assessSchema(ctx: SchemaAssessmentContext): Promise<SchemaAssessment> {
    const p = buildSchemaPrompt(ctx);
    return parseSchemaAssessment(await this.chatJson(p.system, p.user));
  }

  async generateProbes(ctx: ProbeContext): Promise<ProbeCase[]> {
    const p = buildProbePrompt(ctx);
    return parseProbeCases(await this.chatJson(p.system, p.user));
  }
}
