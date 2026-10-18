import { useEffect, useState } from 'react';
import {
  API_URL,
  EVAL_PROFILE_KEY,
  chosenEvalProfileId,
  fetchHealth,
  fetchUserModels,
  type HealthDTO,
  type UserModelDTO,
} from './api';

/**
 * Settings — backend connection status + the user's evaluation-model pick.
 *
 * The frontend is thin: problems, judging and the LLM evaluation call all
 * live on the backend, and the browser NEVER holds an LLM key. Which models
 * exist is the backend admin's business (model profiles); the admin may
 * open some of them to end users, and only those are listed here
 * (GET /api/models — name + model, nothing sensitive). The pick itself is
 * just a profile id in localStorage: evaluateOnServer sends it with each
 * call, the server re-validates it (non-selectable ids are ignored) and
 * uses that profile for that call only — the server default never changes.
 */
export function SettingsPanel() {
  const [health, setHealth] = useState<HealthDTO | null>(null);
  const [failed, setFailed] = useState(false);
  const [models, setModels] = useState<UserModelDTO[] | null>(null);
  const [chosen, setChosen] = useState<string>(() => chosenEvalProfileId());

  useEffect(() => {
    let on = true;
    fetchHealth()
      .then((h) => {
        if (on) setHealth(h);
      })
      .catch(() => {
        if (on) setFailed(true);
      });
    fetchUserModels()
      .then((ms) => {
        if (on) setModels(ms);
      })
      .catch(() => {
        if (on) setModels([]);
      });
    return () => {
      on = false;
    };
  }, []);

  const choose = (profileId: string) => {
    setChosen(profileId);
    try {
      if (profileId) localStorage.setItem(EVAL_PROFILE_KEY, profileId);
      else localStorage.removeItem(EVAL_PROFILE_KEY);
    } catch {
      /* storage unavailable — the pick simply won't persist */
    }
  };

  // A stored pick the admin has since closed (or deleted) — show it as
  // "follow the default" rather than pretending it still applies; the
  // server ignores it either way.
  const chosenStillOpen = chosen !== '' && (models ?? []).some((m) => m.profileId === chosen);

  return (
    <div>
      <p style={{ color: '#94a3b8', fontSize: 13, marginTop: 0 }}>
        前端只负责仿真和渲染：题目、判卷、结构检查和 AI 评审都在后端完成。
        AI 评审的原理很简单：前端把你的设计和判卷结果组装成上下文，后端做<b>一次</b> LLM 调用，
        返回结构化结果，前端渲染出来。用哪个模型由<b>后端的模型档案</b>决定，浏览器里不存任何 key；
        管理员在后端 admin 里开放给用户选择的档案，会出现在下面的「评审模型」里。
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
              AI 评审模型（服务端默认）：
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
        <div>
          评审模型（我的选择）：
          {models === null ? (
            <span style={{ color: '#94a3b8' }}>加载中…</span>
          ) : models.length === 0 ? (
            <span style={{ color: '#94a3b8' }}>
              跟随服务端默认（管理员尚未开放任何模型供用户选择——在后端 admin 的模型档案里勾选「允许用户端选择」后会出现在这里）
            </span>
          ) : (
            <select
              value={chosenStillOpen ? chosen : ''}
              onChange={(e) => choose(e.target.value)}
              style={{ marginLeft: 6 }}
            >
              <option value="">跟随服务端默认</option>
              {models.map((m) => (
                <option key={m.profileId} value={m.profileId}>
                  {m.name}（{m.model}）{m.isDefault ? ' · 服务端默认' : ''}
                </option>
              ))}
            </select>
          )}
        </div>
        {models !== null && models.length > 0 && (
          <div style={{ color: '#94a3b8', fontSize: 12.5, lineHeight: 1.6 }}>
            选择只影响你自己的评审调用（每次调用时随请求发给后端，后端校验后按该档案评审），
            不改变服务端默认；结果区会标注实际使用的模型。
          </div>
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
