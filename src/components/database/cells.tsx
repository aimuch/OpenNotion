import { useEffect, useRef, useState } from "react";
import {
  ALargeSmall,
  ArrowUpRight,
  Calendar,
  Check,
  CircleChevronDown,
  ExternalLink,
  FileText,
  Hash,
  Link2,
  LoaderCircle,
  MousePointerClick,
  Search,
  Sigma,
  Sparkles,
  SquareCheck,
  SquareFunction,
  Tags,
  Type,
  X,
} from "lucide-react";
import type { PageMeta, PropertyDef, PropType, PropValue, RollupFn, SelectOption } from "../../../shared/types";
import {
  COMPUTE_ERROR,
  ROLLUP_FNS,
  cellValue,
  ensureOption,
  executeRowActions,
  getDatabase,
  isComputed,
  relatedRows,
  setProp,
  updateProperty,
  valueText,
} from "../../db";
import { checkFormula } from "../../formula";
import { fillRowWithAi } from "../../ai";
import { navigate, reportError, setAiSettingsOpen, useStore, useTree } from "../../store";
import { Popover, cx } from "../Popover";
import { ActionStepsEditor } from "./AutomationsMenu";

const TYPE_ICONS: Record<PropType | "title", typeof Type> = {
  title: ALargeSmall,
  text: Type,
  number: Hash,
  select: CircleChevronDown,
  multiSelect: Tags,
  date: Calendar,
  checkbox: SquareCheck,
  url: Link2,
  button: MousePointerClick,
  relation: ArrowUpRight,
  rollup: Sigma,
  formula: SquareFunction,
};

export function PropIcon({ type, size = 14 }: { type: PropType | "title"; size?: number }) {
  const Icon = TYPE_ICONS[type];
  return <Icon size={size} />;
}

export function Tag({ option, onRemove }: { option: SelectOption; onRemove?: () => void }) {
  return (
    <span className={cx("tag", `tag-${option.color}`)}>
      <span className="tag-name">{option.name}</span>
      {onRemove && (
        <button
          type="button"
          className="tag-remove"
          aria-label={`移除 ${option.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <X size={11} />
        </button>
      )}
    </span>
  );
}

function selectedOptions(value: PropValue | undefined, def: PropertyDef): SelectOption[] {
  const ids = Array.isArray(value) ? value : typeof value === "string" && value ? [value] : [];
  return ids.map((id) => def.options?.find((o) => o.id === id)).filter((o): o is SelectOption => !!o);
}

/** 只读展示一个属性值（看板卡片上用）。空值返回 null。 */
export function ValueDisplay({ value, def }: { value: PropValue | undefined; def: PropertyDef }) {
  if (def.type === "button") return null;
  if (def.type === "relation") {
    const rows = relatedRows(value);
    if (rows.length === 0) return null;
    return (
      <span className="tag-list">
        {rows.map((row) => (
          <RowChip key={row.id} row={row} />
        ))}
      </span>
    );
  }
  if (isComputed(def.type)) {
    const text = valueText(value, def);
    if (!text) return null;
    return (
      <span className={cx("value-inline value-text", value === COMPUTE_ERROR && "value-error")}>
        <span className="value-label">{def.name}</span>
        {text}
      </span>
    );
  }
  if (def.type === "select" || def.type === "multiSelect") {
    const options = selectedOptions(value, def);
    if (options.length === 0) return null;
    return (
      <span className="tag-list">
        {options.map((o) => (
          <Tag key={o.id} option={o} />
        ))}
      </span>
    );
  }
  if (def.type === "checkbox") {
    if (value !== true) return null;
    return (
      <span className="value-inline">
        <SquareCheck size={14} /> {def.name}
      </span>
    );
  }
  if (value === null || value === undefined || value === "") return null;
  if (def.type === "date") {
    return (
      <span className="value-inline">
        <Calendar size={13} /> {formatDate(String(value))}
      </span>
    );
  }
  // 光秃秃的数字和文字在卡片上看不出是什么，带上属性名
  return (
    <span className="value-inline value-text">
      <span className="value-label">{def.name}</span>
      {String(value)}
    </span>
  );
}

export function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const sameYear = Number(m[1]) === new Date().getFullYear();
  return `${sameYear ? "" : `${m[1]}年`}${Number(m[2])}月${Number(m[3])}日`;
}

/** 关联到的一行：图标 + 标题 */
export function RowChip({ row, onRemove }: { row: PageMeta; onRemove?: () => void }) {
  return (
    <span className="row-chip">
      <span className="row-chip-icon">{row.icon ?? <FileText size={13} />}</span>
      <span className="tag-name">{row.title || "无标题"}</span>
      {onRemove && (
        <button
          type="button"
          className="tag-remove"
          aria-label={`取消关联 ${row.title || "无标题"}`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <X size={11} />
        </button>
      )}
    </span>
  );
}

interface CellProps {
  row: PageMeta;
  def: PropertyDef;
  /** 属性所属的数据库页面 */
  dbPage: PageMeta;
}

/** 可编辑的属性单元格，表格和页面属性面板共用。 */
export function PropertyCell({ row, def, dbPage }: CellProps) {
  const value = row.props[def.id];
  switch (def.type) {
    case "checkbox":
      return (
        <label className="cell cell-checkbox">
          <input
            type="checkbox"
            checked={value === true}
            aria-label={def.name}
            onChange={(e) => setProp(row, def.id, e.target.checked)}
          />
        </label>
      );
    case "button":
      return (
        <div className="cell cell-button-wrap">
          <button
            type="button"
            className="db-action-btn"
            onClick={(e) => {
              e.stopPropagation();
              void executeRowActions(row, dbPage, def.buttonActions);
            }}
          >
            <MousePointerClick size={12} />
            <span>{def.buttonLabel || def.name || "执行"}</span>
          </button>
        </div>
      );
    case "date":
      return (
        <input
          className={cx("cell cell-input cell-date", !value && "empty")}
          type="date"
          value={typeof value === "string" ? value : ""}
          aria-label={def.name}
          onChange={(e) => setProp(row, def.id, e.target.value || null)}
        />
      );
    case "select":
    case "multiSelect":
      return <SelectCell row={row} def={def} dbPage={dbPage} />;
    case "relation":
      return <RelationCell row={row} def={def} dbPage={dbPage} />;
    case "rollup":
    case "formula":
      return <ComputedCell row={row} def={def} />;
    default:
      return <TextCell row={row} def={def} dbPage={dbPage} />;
  }
}

function TextCell({ row, def, dbPage }: CellProps) {
  const value = row.props[def.id];
  const text = value === null || value === undefined ? "" : String(value);
  const [draft, setDraft] = useState(text);
  const [aiBusy, setAiBusy] = useState(false);
  const focused = useRef(false);

  // 外部修改（例如撤销、另一处编辑）时同步进来，但不打断正在输入的内容
  useEffect(() => {
    if (!focused.current) setDraft(text);
  }, [text]);

  const commit = () => {
    const trimmed = draft.trim();
    let next: PropValue = trimmed || null;
    if (def.type === "number") {
      const n = parseFloat(trimmed);
      next = Number.isFinite(n) ? n : null;
      setDraft(next === null ? "" : String(next));
    }
    if (next !== (value ?? null)) setProp(row, def.id, next);
  };

  return (
    <span className="cell cell-text-wrap">
      <input
        className={cx("cell-input", def.type === "number" && "cell-number")}
        value={draft}
        inputMode={def.type === "number" ? "decimal" : def.type === "url" ? "url" : undefined}
        aria-label={def.name}
        onFocus={() => (focused.current = true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(text);
            e.currentTarget.blur();
          }
        }}
      />
      {def.type === "text" && def.aiPrompt && (
        <button
          type="button"
          className="cell-ai-btn"
          title={`AI 自动生成（${def.aiPrompt}）`}
          aria-label="AI 自动生成"
          disabled={aiBusy}
          onClick={async () => {
            setAiBusy(true);
            try {
              await fillRowWithAi(row, dbPage, def);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (msg.includes("API Key")) setAiSettingsOpen(true);
              else reportError(msg);
            } finally {
              setAiBusy(false);
            }
          }}
        >
          {aiBusy ? <LoaderCircle size={13} className="spin" /> : <Sparkles size={13} />}
        </button>
      )}
      {def.type === "url" && text && (
        <a
          className="cell-link"
          href={/^[a-z][a-z0-9+.-]*:/i.test(text) ? safeUrl(text) : `https://${text}`}
          target="_blank"
          rel="noreferrer noopener"
          aria-label="打开链接"
          title="打开链接"
        >
          <ExternalLink size={13} />
        </a>
      )}
    </span>
  );
}

/** 只放行 http(s) 和 mailto，避免 javascript: 之类的链接被点开 */
function safeUrl(url: string): string {
  return /^(https?:|mailto:)/i.test(url) ? url : "about:blank";
}

function SelectCell({ row, def, dbPage }: CellProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const value = row.props[def.id];
  const selected = selectedOptions(value, def);
  const multi = def.type === "multiSelect";

  const toggle = (option: SelectOption) => {
    if (multi) {
      const ids = selected.map((o) => o.id);
      setProp(row, def.id, ids.includes(option.id) ? ids.filter((id) => id !== option.id) : [...ids, option.id]);
    } else {
      setProp(row, def.id, selected[0]?.id === option.id ? null : option.id);
      setAnchor(null);
    }
  };

  return (
    <>
      <button
        type="button"
        className={cx("cell cell-select", anchor && "open")}
        aria-label={def.name}
        aria-haspopup="listbox"
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      >
        {selected.length > 0 ? (
          <span className="tag-list">
            {selected.map((o) => (
              <Tag key={o.id} option={o} />
            ))}
          </span>
        ) : (
          <span className="cell-placeholder">空</span>
        )}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} className="select-editor">
          <SelectEditor
            def={def}
            dbPage={dbPage}
            selected={selected}
            onToggle={toggle}
            onCreate={(name) => toggle(ensureOption(dbPage, def, name))}
          />
        </Popover>
      )}
    </>
  );
}

interface SelectEditorProps {
  def: PropertyDef;
  dbPage: PageMeta;
  selected: SelectOption[];
  onToggle: (option: SelectOption) => void;
  onCreate: (name: string) => void;
}

function SelectEditor({ def, dbPage, selected, onToggle, onCreate }: SelectEditorProps) {
  const [query, setQuery] = useState("");
  const q = query.trim();
  const options = def.options ?? [];
  const shown = q ? options.filter((o) => o.name.toLowerCase().includes(q.toLowerCase())) : options;
  const exact = options.some((o) => o.name === q);
  const selectedIds = new Set(selected.map((o) => o.id));

  return (
    <>
      <div className="select-search">
        {selected.map((o) => (
          <Tag key={o.id} option={o} onRemove={() => onToggle(o)} />
        ))}
        <input
          autoFocus
          value={query}
          placeholder={selected.length ? "" : "搜索或创建选项…"}
          aria-label="搜索或创建选项"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.key !== "Enter" || !q) return;
            e.preventDefault();
            const match = options.find((o) => o.name === q) ?? (shown.length === 1 ? shown[0] : null);
            if (match) onToggle(match);
            else onCreate(q);
            setQuery("");
          }}
        />
      </div>
      <div className="select-hint">选择一个选项，或输入名称后回车创建</div>
      <div className="select-options" role="listbox">
        {shown.map((o) => (
          <div
            key={o.id}
            className="select-option"
            role="option"
            aria-selected={selectedIds.has(o.id)}
            tabIndex={0}
            onClick={() => onToggle(o)}
            onKeyDown={(e) => e.key === "Enter" && onToggle(o)}
          >
            <Tag option={o} />
            {selectedIds.has(o.id) && <Check size={14} className="select-check" />}
            <button
              type="button"
              className="icon-btn small select-delete"
              title="删除这个选项"
              aria-label={`删除选项 ${o.name}`}
              onClick={(e) => {
                e.stopPropagation();
                updateProperty(dbPage, def.id, { options: options.filter((x) => x.id !== o.id) });
              }}
            >
              <X size={13} />
            </button>
          </div>
        ))}
        {q && !exact && (
          <button
            type="button"
            className="select-option select-create"
            onClick={() => {
              onCreate(q);
              setQuery("");
            }}
          >
            创建 <Tag option={{ id: "new", name: q, color: "gray" }} />
          </button>
        )}
        {shown.length === 0 && !q && <div className="select-empty">还没有选项</div>}
      </div>
    </>
  );
}

/** 汇总和公式：现算、只读。订阅整个页面表，被引用的行一变就跟着更新。 */
function ComputedCell({ row, def }: { row: PageMeta; def: PropertyDef }) {
  useStore((s) => s.pages);
  const value = cellValue(row, def);
  const text = valueText(value, def);
  const failed = value === COMPUTE_ERROR;
  // 公式出错时，把具体原因放进提示里
  let reason: string | undefined;
  if (failed && def.type === "formula") {
    reason = checkFormula(def.formula ?? "") ?? "引用的属性不存在，或者参与运算的值类型不对";
  }
  return (
    <span
      className={cx("cell cell-computed", failed && "value-error", typeof value === "number" && "cell-number")}
      title={reason ?? (def.type === "formula" ? def.formula : undefined)}
    >
      {text}
    </span>
  );
}

function RelationCell({ row, def, dbPage }: CellProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  // 关联的行改名、删除后这里要跟着变
  useStore((s) => s.pages);
  const selected = relatedRows(row.props[def.id]);

  const toggle = (target: PageMeta) => {
    const ids = selected.map((r) => r.id);
    setProp(row, def.id, ids.includes(target.id) ? ids.filter((id) => id !== target.id) : [...ids, target.id]);
  };

  return (
    <>
      <button
        type="button"
        className={cx("cell cell-select", anchor && "open")}
        aria-label={def.name}
        aria-haspopup="listbox"
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      >
        {selected.length > 0 ? (
          <span className="tag-list">
            {selected.map((r) => (
              <RowChip key={r.id} row={r} />
            ))}
          </span>
        ) : (
          <span className="cell-placeholder">空</span>
        )}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} className="select-editor">
          <RelationEditor row={row} def={def} dbPage={dbPage} selected={selected} onToggle={toggle} />
        </Popover>
      )}
    </>
  );
}

interface RelationEditorProps extends CellProps {
  selected: PageMeta[];
  onToggle: (target: PageMeta) => void;
}

function RelationEditor({ row, def, dbPage, selected, onToggle }: RelationEditorProps) {
  const tree = useTree();
  const pages = useStore((s) => s.pages);
  const [query, setQuery] = useState("");
  const target = def.relationDb ? pages[def.relationDb] : undefined;

  if (!target || target.kind !== "database" || target.trashed) {
    return (
      <div className="select-empty">
        关联的数据库不存在了。点列头，在属性设置里重新选择要关联的数据库。
        <DatabaseSelect dbPage={dbPage} def={def} />
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const selectedIds = new Set(selected.map((r) => r.id));
  // 不能关联自己
  const candidates = (tree.children.get(target.id) ?? []).filter(
    (r) => r.id !== row.id && (!q || (r.title || "无标题").toLowerCase().includes(q)),
  );

  return (
    <>
      <div className="select-search">
        {selected.map((r) => (
          <RowChip key={r.id} row={r} onRemove={() => onToggle(r)} />
        ))}
        <input
          autoFocus
          value={query}
          placeholder={selected.length ? "" : `在“${target.title || "无标题"}”中搜索…`}
          aria-label="搜索要关联的行"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="select-hint">
        <Search size={12} /> 来自“{target.title || "无标题"}”
      </div>
      <div className="select-options" role="listbox">
        {candidates.slice(0, 80).map((r) => (
          <div
            key={r.id}
            className="select-option"
            role="option"
            aria-selected={selectedIds.has(r.id)}
            tabIndex={0}
            onClick={() => onToggle(r)}
            onKeyDown={(e) => e.key === "Enter" && onToggle(r)}
          >
            <RowChip row={r} />
            {selectedIds.has(r.id) && <Check size={14} className="select-check" />}
            <button
              type="button"
              className="icon-btn small select-delete"
              title="打开这一行"
              aria-label={`打开 ${r.title || "无标题"}`}
              onClick={(e) => {
                e.stopPropagation();
                navigate(r.id);
              }}
            >
              <ArrowUpRight size={13} />
            </button>
          </div>
        ))}
        {candidates.length === 0 && <div className="select-empty">{q ? "没有匹配的行" : "这个数据库里还没有可关联的行"}</div>}
      </div>
    </>
  );
}

function DatabaseSelect({ dbPage, def }: { dbPage: PageMeta; def: PropertyDef }) {
  const pages = useStore((s) => s.pages);
  const databases = Object.values(pages).filter((p) => p.kind === "database" && !p.trashed && !p.hidden);
  return (
    <select
      className="config-select"
      aria-label="关联到的数据库"
      value={def.relationDb ?? ""}
      onChange={(e) => updateProperty(dbPage, def.id, { relationDb: e.target.value })}
    >
      <option value="" disabled>
        选择数据库…
      </option>
      {databases.map((p) => (
        <option key={p.id} value={p.id}>
          {p.title || "无标题"}
          {p.id === dbPage.id ? "（当前数据库）" : ""}
        </option>
      ))}
    </select>
  );
}

/** 属性菜单里，文本 AI 自动填充 / 关联 / 汇总 / 公式各自的设置项。 */
export function PropertyConfig({ dbPage, def, allRows }: { dbPage: PageMeta; def: PropertyDef; allRows?: PageMeta[] }) {
  const pages = useStore((s) => s.pages);
  const db = getDatabase(dbPage);
  const [batchBusy, setBatchBusy] = useState(false);

  if (def.type === "text") {
    return (
      <div className="prop-config">
        <label>
          <span>
            <Sparkles size={12} /> AI 自动填充指令（可选）
          </span>
          <textarea
            className="config-formula"
            rows={2}
            value={def.aiPrompt ?? ""}
            placeholder="例如：用一句话概括本行要点 / 判断所属模块（前端、后端、设计）"
            onChange={(e) => updateProperty(dbPage, def.id, { aiPrompt: e.target.value || undefined })}
          />
        </label>
        {def.aiPrompt && allRows && allRows.length > 0 && (
          <button
            type="button"
            className="text-btn small"
            disabled={batchBusy}
            onClick={async () => {
              setBatchBusy(true);
              try {
                for (const row of allRows) await fillRowWithAi(row, dbPage, def);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (msg.includes("API Key")) setAiSettingsOpen(true);
                else reportError(msg);
              } finally {
                setBatchBusy(false);
              }
            }}
          >
            {batchBusy ? <LoaderCircle size={13} className="spin" /> : <Sparkles size={13} />} 为全部 {allRows.length} 行自动生成
          </button>
        )}
      </div>
    );
  }

  if (def.type === "relation") {
    return (
      <div className="prop-config">
        <label>
          关联到
          <DatabaseSelect dbPage={dbPage} def={def} />
        </label>
      </div>
    );
  }

  if (def.type === "rollup") {
    const relations = db.properties.filter((p) => p.type === "relation");
    const config = def.rollup ?? { relationProp: "", targetProp: "title", fn: "show" as RollupFn };
    const relation = relations.find((p) => p.id === config.relationProp);
    const targetDb = relation?.relationDb ? pages[relation.relationDb]?.database : null;
    const set = (patch: Partial<typeof config>) => updateProperty(dbPage, def.id, { rollup: { ...config, ...patch } });
    if (relations.length === 0) {
      return <div className="prop-config prop-config-note">汇总要顺着一个“关联”属性去取数据。先给这个数据库添加一个关联属性。</div>;
    }
    return (
      <div className="prop-config">
        <label>
          顺着关联
          <select
            className="config-select"
            value={config.relationProp}
            onChange={(e) => set({ relationProp: e.target.value, targetProp: "title" })}
          >
            <option value="" disabled>
              选择关联属性…
            </option>
            {relations.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          取对方的
          <select className="config-select" value={config.targetProp} onChange={(e) => set({ targetProp: e.target.value })}>
            <option value="title">名称</option>
            {targetDb?.properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          计算方式
          <select className="config-select" value={config.fn} onChange={(e) => set({ fn: e.target.value as RollupFn })}>
            {ROLLUP_FNS.map((f) => (
              <option key={f.fn} value={f.fn}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    );
  }

  if (def.type === "formula") {
    const problem = checkFormula(def.formula ?? "");
    return (
      <div className="prop-config">
        <label>
          公式
          <textarea
            className="config-formula"
            rows={3}
            spellCheck={false}
            value={def.formula ?? ""}
            placeholder={'例如：prop("数量") * prop("单价")'}
            onChange={(e) => updateProperty(dbPage, def.id, { formula: e.target.value })}
          />
        </label>
        {problem ? (
          <div className="prop-config-note value-error">{problem}</div>
        ) : (
          <div className="prop-config-note">
            用 prop("属性名") 引用本行的属性；可用 if、round、min、max、concat、dateBetween、today 等函数。
          </div>
        )}
      </div>
    );
  }

  if (def.type === "button") {
    return (
      <div className="prop-config">
        <label>
          按钮文字
          <input
            className="config-select"
            value={def.buttonLabel ?? "执行"}
            placeholder="例如：标记完成 / 延期一天"
            onChange={(e) => updateProperty(dbPage, def.id, { buttonLabel: e.target.value })}
          />
        </label>
        <div className="prop-config-note">点击该单元格按钮时依次执行：</div>
        <ActionStepsEditor
          db={db}
          steps={def.buttonActions ?? []}
          onChange={(buttonActions) => updateProperty(dbPage, def.id, { buttonActions })}
        />
      </div>
    );
  }

  return null;
}
