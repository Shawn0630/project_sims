import type { DriverKind, DriverReview, DriverSettings } from '@sds/driver';

interface DriverPanelProps {
  settings: DriverSettings;
  onSettings: (s: DriverSettings) => void;
  busy: boolean;
  review: DriverReview | null;
  error: string | null;
  canRun: boolean;
  onRun: () => void;
}

export function DriverPanel({ settings, onSettings, busy, review, error, canRun, onRun }: DriverPanelProps) {
  const setKind = (kind: DriverKind) => onSettings({ ...settings, kind });
  return (
    <div>
      <p style={{ color: '#94a3b8', fontSize: 13, marginTop: 0 }}>
        AI 评审的原理很简单：前端把你的设计和判卷结果组装成上下文，一次调用所选模型，
        返回结构化结果并渲染出来。下面选择评审用的模型，也可以让 AI 直接操作模拟器
        跑一轮场景再评审。<b>云端 API 优先</b>（你的决定），Ollama 本地模型为 fallback，
        本地脚本离线可用。API key 只存在你浏览器的 localStorage 里，不会进代码仓库。
      </p>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'end' }}>
        <label>
          AI 评审模型
          <select value={settings.kind} onChange={(e) => setKind(e.target.value as DriverKind)}>
            <option value="scripted">本地脚本评审（离线，默认）</option>
            <option value="openai">云端 API（OpenAI 兼容）</option>
            <option value="ollama">Ollama 本地模型</option>
          </select>
        </label>
        {settings.kind === 'openai' && (
          <>
            <label>
              API Key
              <input
                type="password"
                placeholder="sk-…"
                value={settings.openai.apiKey}
                onChange={(e) => onSettings({ ...settings, openai: { ...settings.openai, apiKey: e.target.value } })}
              />
            </label>
            <label>
              API Endpoint
              <input
                value={settings.openai.baseUrl ?? ''}
                onChange={(e) => onSettings({ ...settings, openai: { ...settings.openai, baseUrl: e.target.value } })}
              />
            </label>
            <label>
              模型
              <input
                value={settings.openai.model ?? ''}
                onChange={(e) => onSettings({ ...settings, openai: { ...settings.openai, model: e.target.value } })}
              />
            </label>
          </>
        )}
        {settings.kind === 'ollama' && (
          <>
            <label>
              Ollama 地址
              <input
                value={settings.ollama.baseUrl ?? ''}
                onChange={(e) => onSettings({ ...settings, ollama: { ...settings.ollama, baseUrl: e.target.value } })}
              />
            </label>
            <label>
              模型（需支持工具调用）
              <input
                value={settings.ollama.model ?? ''}
                onChange={(e) => onSettings({ ...settings, ollama: { ...settings.ollama, model: e.target.value } })}
              />
            </label>
          </>
        )}
        <button className="primary" onClick={onRun} disabled={!canRun || busy}>
          {busy ? 'AI 操作中…' : '🤖 让 AI 操作模拟器 + 评审'}
        </button>
        {!canRun && <span style={{ color: '#94a3b8', fontSize: 12 }}>先提交设计，AI 才能操作模拟器。</span>}
      </div>

      {error && (
        <div style={{ color: '#fca5a5', marginTop: 10, fontSize: 13 }}>AI 出错：{error}</div>
      )}
      {review && (
        <div className="review-box">
          <div style={{ fontSize: 14, lineHeight: 1.7 }}>{review.summary}</div>
          {review.findings.length > 0 && (
            <ul style={{ paddingLeft: 18 }}>
              {review.findings.map((f, i) => (
                <li key={i} style={{ marginBottom: 6 }}>
                  <span className={`chip chip-${f.severity}`}>{f.severity}</span> <b>{f.title}</b>
                  <div style={{ color: '#cbd5e1', fontSize: 13 }}>{f.detail}</div>
                </li>
              ))}
            </ul>
          )}
          {review.transcript.length > 0 && (
            <details>
              <summary style={{ cursor: 'pointer', color: '#94a3b8' }}>操作记录（{review.transcript.length} 步）</summary>
              <pre className="transcript">{review.transcript.join('\n')}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
