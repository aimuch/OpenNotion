import { useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, KeyRound, LoaderCircle, Lock, Send } from "lucide-react";
import type { PageMeta, PageRecord, PropValue } from "../../shared/types";
import { valueText } from "../db";
import { transitionFormSubmission, transitionPublicShare, useMachine } from "../machines";
import { fetchPublicShare, submitPublicShareForm } from "../store";
import { Editor } from "./Editor";
import { Logo } from "./Logo";
import { coverStyle } from "./pickers";

/** 公开分享页面阅读器与公开表单提交页（路由 /s/<token>） */
export function PublicShareView({ token }: { token: string }) {
  const [state, send] = useMachine(transitionPublicShare, { phase: "loading" });
  const [pwdInput, setPwdInput] = useState("");

  useEffect(() => {
    let alive = true;
    fetchPublicShare(token).then(
      (res) => {
        if (!alive) return;
        if (res.locked) {
          send({ type: "REQUIRE_PASSWORD", title: res.title, icon: res.icon });
        } else {
          send({ type: "LOADED", page: res.page, rows: res.rows, verifiedPassword: "" });
        }
      },
      (err: Error) => alive && send({ type: "NOT_FOUND", message: err.message }),
    );
    return () => {
      alive = false;
    };
  }, [token, send]);

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (state.phase !== "locked" || !pwdInput.trim()) return;
    send({ type: "UNLOCK_START" });
    try {
      const res = await fetchPublicShare(token, pwdInput.trim());
      if (res.locked) {
        send({ type: "REQUIRE_PASSWORD", title: res.title, icon: res.icon, error: "访问口令不正确，请重试" });
      } else {
        send({ type: "LOADED", page: res.page, rows: res.rows, verifiedPassword: pwdInput.trim() });
      }
    } catch (err) {
      send({
        type: "REQUIRE_PASSWORD",
        title: state.title,
        icon: state.icon,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  if (state.phase === "loading") {
    return (
      <div className="public-share-shell" data-public-share-state="loading">
        <div className="public-share-card">
          <LoaderCircle size={24} className="spin" />
          <p>正在加载公开分享页面…</p>
        </div>
      </div>
    );
  }

  if (state.phase === "not_found") {
    return (
      <div className="public-share-shell" data-public-share-state="not_found">
        <div className="public-share-card">
          <CircleAlert size={28} />
          <h2>无法访问此分享页</h2>
          <p>{state.message}</p>
        </div>
      </div>
    );
  }

  if (state.phase === "locked") {
    return (
      <div className="public-share-shell" data-public-share-state="locked">
        <form className="public-share-card" onSubmit={(e) => void handleUnlock(e)}>
          <div className="public-lock-icon">
            <Lock size={24} />
          </div>
          <h2>
            {state.icon ? `${state.icon} ` : ""}
            {state.title || "受保护的分享页面"}
          </h2>
          <p>此页面已开启访问口令保护，请输入密码后查看。</p>
          <div className="public-lock-input">
            <KeyRound size={15} />
            <input
              type="password"
              autoFocus
              disabled={state.unlocking}
              value={pwdInput}
              placeholder="请输入访问口令…"
              onChange={(e) => setPwdInput(e.target.value)}
            />
          </div>
          {state.error && <div className="value-error">{state.error}</div>}
          <button type="submit" className="primary-btn" disabled={state.unlocking || !pwdInput.trim()}>
            {state.unlocking ? "验证中…" : "解锁查看"}
          </button>
        </form>
      </div>
    );
  }

  const { page, rows, verifiedPassword } = state;
  const showMeta = page.share?.showMeta !== false;
  const showBrand = page.share?.showBrand !== false;

  return (
    <div className="public-share-page" data-public-share-state="ready">
      {page.cover && <div className="cover public-share-cover" style={coverStyle(page.cover, page.coverY)} />}
      <main className="public-share-main">
        <header className="public-share-header">
          {page.icon && <div className="public-share-icon">{page.icon}</div>}
          <h1>{page.title || "无标题"}</h1>
          {showMeta && (
            <div className="public-share-meta">
              更新于{" "}
              {new Date(page.updatedAt).toLocaleString("zh-CN", {
                year: "numeric",
                month: "long",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </div>
          )}
          {page.tags && page.tags.length > 0 && (
            <div className="page-tags-bar" style={{ marginTop: 10 }}>
              {page.tags.map((t) => (
                <span key={t} className="page-tag-pill">
                  #{t}
                </span>
              ))}
            </div>
          )}
        </header>

        {page.kind === "database" ? (
          <PublicDatabaseSection
            token={token}
            page={page}
            initialRows={rows}
            verifiedPassword={verifiedPassword}
          />
        ) : (
          <div className="public-share-editor">
            <Editor page={page} editable={false} onReady={() => {}} />
          </div>
        )}

        {showBrand && (
          <footer className="public-share-footer">
            <Logo size={16} />
            <span>由 OpenNotion 本地知识库发布</span>
          </footer>
        )}
      </main>
    </div>
  );
}

function PublicDatabaseSection({
  token,
  page,
  initialRows,
  verifiedPassword,
}: {
  token: string;
  page: PageRecord;
  initialRows: PageMeta[];
  verifiedPassword: string;
}) {
  const [rows, setRows] = useState<PageMeta[]>(initialRows);
  const [title, setTitle] = useState("");
  const [values, setValues] = useState<Record<string, PropValue>>({});
  const [formState, sendForm] = useMachine(transitionFormSubmission, { phase: "editing" });

  const propsDefs = page.database?.properties ?? [];
  const editableDefs = propsDefs.filter(
    (p) => p.type !== "formula" && p.type !== "rollup" && p.type !== "button" && p.type !== "relation",
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || formState.phase === "submitting") return;
    sendForm({ type: "SUBMIT_START" });
    try {
      const created = await submitPublicShareForm(token, {
        password: verifiedPassword || undefined,
        title: title.trim(),
        props: values,
      });
      setRows((prev) => [...prev, created]);
      setTitle("");
      setValues({});
      sendForm({ type: "SUBMIT_SUCCESS", rowId: created.id });
    } catch (err) {
      sendForm({ type: "SUBMIT_ERROR", message: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="public-db-wrap">
      {page.share?.allowFormSubmit && (
        <section className="public-form-box" data-form-state={formState.phase}>
          <h3>在线填报表单</h3>
          {formState.phase === "submitted" ? (
            <div className="form-submitted-box">
              <CheckCircle2 size={24} />
              <p>提交成功！记录已写入数据库。</p>
              <button type="button" className="ghost-btn small" onClick={() => sendForm({ type: "RESET" })}>
                继续提交一条
              </button>
            </div>
          ) : (
            <form className="public-form-fields" onSubmit={(e) => void handleSubmit(e)}>
              <label className="form-field">
                <span>名称 *</span>
                <input
                  required
                  value={title}
                  placeholder="请输入标题或名称…"
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              {editableDefs.map((def) => (
                <label key={def.id} className="form-field">
                  <span>{def.name}</span>
                  {def.type === "select" ? (
                    <select
                      value={typeof values[def.id] === "string" ? String(values[def.id]) : ""}
                      onChange={(e) => setValues((v) => ({ ...v, [def.id]: e.target.value || null }))}
                    >
                      <option value="">请选择…</option>
                      {(def.options ?? []).map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  ) : def.type === "checkbox" ? (
                    <input
                      type="checkbox"
                      checked={Boolean(values[def.id])}
                      onChange={(e) => setValues((v) => ({ ...v, [def.id]: e.target.checked }))}
                    />
                  ) : def.type === "date" ? (
                    <input
                      type="date"
                      value={typeof values[def.id] === "string" ? String(values[def.id]) : ""}
                      onChange={(e) => setValues((v) => ({ ...v, [def.id]: e.target.value || null }))}
                    />
                  ) : def.type === "number" ? (
                    <input
                      type="number"
                      value={typeof values[def.id] === "number" ? String(values[def.id]) : ""}
                      onChange={(e) =>
                        setValues((v) => ({ ...v, [def.id]: e.target.value === "" ? null : Number(e.target.value) }))
                      }
                    />
                  ) : (
                    <input
                      value={typeof values[def.id] === "string" ? String(values[def.id]) : ""}
                      onChange={(e) => setValues((v) => ({ ...v, [def.id]: e.target.value }))}
                    />
                  )}
                </label>
              ))}
              {formState.phase === "error" && <div className="value-error">{formState.message}</div>}
              <button type="submit" className="primary-btn" disabled={formState.phase === "submitting" || !title.trim()}>
                <Send size={14} /> {formState.phase === "submitting" ? "正在提交…" : "提交表单"}
              </button>
            </form>
          )}
        </section>
      )}

      <div className="public-db-table-wrap">
        <table className="public-db-table">
          <thead>
            <tr>
              <th>名称</th>
              {propsDefs.slice(0, 6).map((d) => (
                <th key={d.id}>{d.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.icon ? `${r.icon} ` : ""}
                  {r.title || "无标题"}
                </td>
                {propsDefs.slice(0, 6).map((d) => (
                  <td key={d.id}>{valueText(r.props?.[d.id] ?? null, d)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
