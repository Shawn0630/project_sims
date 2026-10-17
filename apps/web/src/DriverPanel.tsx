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
        驾驶员通过同一组工具接口操作模拟器（set_traffic / inject_event / kill_node / read_metrics /
        highlight / run_test_case / review_schema）。<b>云端 API 优先</b>（你的决定），Ollama 为本地
        fallback，脚本驾驶员离线可用。API key 只存在你浏览器的 localStorage 里，不会进代码仓库。
      </p>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'end' }}>
        <label>
          驾驶员
          <select value={settings.kind} onChange={(e) => setKind(e.target.value as DriverKind)}>
            <option value="scripted">脚本驾驶员（离线，默认）</option>
            <option value="openai">云端 LLM（OpenAI 兼容）</option>
            <option value="ollama">Ollama 本地</option>
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
              Base URL
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
          {busy ? '驾驶员操作中…' : '🤖 让驾驶员开车模拟 + 评审'}
        </button>
        {!canRun && <span style={{ color: '#94a3b8', fontSize: 12 }}>先提交设计，驾驶员才能上车。</span>}
      </div>

      {error && (
        <div style={{ color: '#fca5a5', marginTop: 10, fontSize: 13 }}>驾驶员出错：{error}</div>
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
