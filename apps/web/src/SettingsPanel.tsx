import { useEffect, useState } from 'react';
import { API_URL, fetchHealth, type HealthDTO } from './api';

/**
 * Settings — backend connection status, nothing more.
 *
 * The frontend is thin: problems, judging and the LLM evaluation call all
 * live on the backend. Which model evaluates (and its key) is decided by the
 * backend's environment (LLM_BASE_URL / LLM_API_KEY / LLM_MODEL), never by
 * the browser, so there is nothing to configure here — this panel only shows
 * whether the backend is reachable and how IT is configured.
 */
export function SettingsPanel() {
  const [health, setHealth] = useState<HealthDTO | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let on = true;
    fetchHealth()
      .then((h) => {
        if (on) setHealth(h);
      })
      .catch(() => {
        if (on) setFailed(true);
      });
    return () => {
      on = false;
    };
  }, []);

  return (
    <div>
      <p style={{ color: '#94a3b8', fontSize: 13, marginTop: 0 }}>
        前端只负责仿真和渲染：题目、判卷、结构检查和 AI 评审都在后端完成。
        AI 评审的原理很简单：前端把你的设计和判卷结果组装成上下文，后端做<b>一次</b> LLM 调用，
        返回结构化结果，前端渲染出来。用哪个模型由<b>后端的环境变量</b>决定
        （LLM_BASE_URL / LLM_API_KEY / LLM_MODEL），浏览器里不存任何 key。
        后端没配 key 时，评审由确定性的本地脚本在后端回落生成，功能不受影响。
      </p>

      <div style={{ fontSize: 13.5, lineHeight: 2 }}>
        <div>
          后端地址：<code>{API_URL}</code>
        </div>
        <div>
          连接状态：
          {failed ? (
            <b style={{ color: '#f87171' }}>无法连接后端</b>
          ) : health ? (
            <b style={{ color: '#4ade80' }}>已连接</b>
          ) : (
            <span style={{ color: '#94a3b8' }}>检查中…</span>
          )}
        </div>
        {health && (
          <>
            <div>
              题目存储：{health.storage}（{health.problems} 道题）
            </div>
            <div>
              AI 评审模型：
              {health.llmConfigured ? (
                <>
                  云端 LLM · <code>{health.llmModel}</code> @ <code>{health.llmBaseUrl}</code>
                </>
              ) : (
                '本地脚本回落（后端未配置 LLM_API_KEY）'
              )}
            </div>
          </>
        )}
      </div>

      {failed && (
        <p style={{ color: '#fca5a5', fontSize: 13 }}>
          请先启动后端：<code>npm run dev:server</code>，然后刷新页面。
        </p>
      )}
    </div>
  );
}
