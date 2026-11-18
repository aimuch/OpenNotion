import { useState } from "react";
import { Minus, Plus, Trash2 } from "lucide-react";

export interface MindNode {
  id: string;
  text: string;
  children: MindNode[];
}

export type MindLayout = "mind" | "right";
export type MindTheme = "rainbow" | "ocean" | "forest";

export const DEFAULT_MIND_OUTLINE = `- 产品核心规划
  - 知识组织
    - 无限层级页面树
    - 多维分类标签
    - 双向页面链接
  - 多形态富笔记
    - 8 种数据库视图
    - 交互式思维导图
    - Mermaid 流程图与公式
  - AI 与开放生态
    - 国产与海外多模型接入
    - 原生 MCP 协议服务
    - 网页结构化剪藏`;

const THEME_PALETTES: Record<MindTheme, { rootBg: string; rootText: string; branches: string[] }> = {
  rainbow: {
    rootBg: "#1f2937",
    rootText: "#ffffff",
    branches: ["#2563eb", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4"],
  },
  ocean: {
    rootBg: "#0f172a",
    rootText: "#f8fafc",
    branches: ["#0284c7", "#2563eb", "#4f46e5", "#0d9488", "#0891b2", "#6366f1"],
  },
  forest: {
    rootBg: "#14532d",
    rootText: "#f0fdf4",
    branches: ["#16a34a", "#65a30d", "#d97706", "#0d9488", "#ca8a04", "#059669"],
  },
};

/**
 * 将缩进列表大纲解析为 MindNode 树结构（首行为根节点，按 2 空格或 Tab 缩进区分层级）
 */
export function parseMindOutline(outline: string): MindNode {
  const rawLines = outline
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => l.trim().length > 0);

  if (rawLines.length === 0) {
    return { id: "n_0", text: "中心主题", children: [] };
  }

  const parsed = rawLines.map((line, idx) => {
    const indentMatch = /^(\s*)/.exec(line);
    const spaces = (indentMatch?.[1] ?? "").replace(/\t/g, "  ").length;
    const text = line.trim().replace(/^[-*+]\s+/, "").trim() || "未命名节点";
    return { id: `n_${idx}`, indent: spaces, text };
  });

  const root: MindNode = { id: parsed[0].id, text: parsed[0].text, children: [] };
  const stack: { indent: number; node: MindNode }[] = [{ indent: parsed[0].indent, node: root }];

  for (let i = 1; i < parsed.length; i++) {
    const item = parsed[i];
    const node: MindNode = { id: item.id, text: item.text, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].indent >= item.indent) {
      stack.pop();
    }
    stack[stack.length - 1].node.children.push(node);
    stack.push({ indent: item.indent, node });
  }

  return root;
}

/**
 * 将 MindNode 树序列化回标准缩进 Markdown 列表
 */
export function serializeMindTree(node: MindNode, depth = 0): string {
  const pad = "  ".repeat(depth);
  const head = `${pad}- ${node.text}`;
  if (node.children.length === 0) return head;
  return [head, ...node.children.map((c) => serializeMindTree(c, depth + 1))].join("\n");
}

function measureTextWidth(text: string, isRoot: boolean): number {
  let units = 0;
  for (const ch of text) {
    units += ch.charCodeAt(0) > 255 ? 1.85 : 1;
  }
  const fontPx = isRoot ? 14.5 : 12.8;
  return Math.max(isRoot ? 96 : 74, Math.min(260, Math.round(units * (fontPx * 0.56) + (isRoot ? 34 : 26))));
}

interface PlacedNode {
  node: MindNode;
  x: number;
  y: number;
  w: number;
  h: number;
  side: "left" | "right" | "root";
  color: string;
  depth: number;
  hasHiddenChildren: boolean;
}

interface PlacedEdge {
  key: string;
  d: string;
  color: string;
  width: number;
}

const V_GAP = 14;
const H_GAP = 54;
const NODE_H = 32;
const ROOT_H = 40;

function subtreeSpan(node: MindNode, collapsed: ReadonlySet<string>): number {
  if (node.children.length === 0 || collapsed.has(node.id)) return NODE_H + V_GAP;
  return node.children.reduce((sum, c) => sum + subtreeSpan(c, collapsed), 0);
}

function layoutMindTree(
  root: MindNode,
  layout: MindLayout,
  theme: MindTheme,
  collapsed: ReadonlySet<string>,
): { nodes: PlacedNode[]; edges: PlacedEdge[]; minX: number; minY: number; width: number; height: number } {
  const palette = THEME_PALETTES[theme] ?? THEME_PALETTES.rainbow;
  const nodes: PlacedNode[] = [];
  const edges: PlacedEdge[] = [];

  const rootW = measureTextWidth(root.text, true);
  nodes.push({
    node: root,
    x: -rootW / 2,
    y: -ROOT_H / 2,
    w: rootW,
    h: ROOT_H,
    side: "root",
    color: palette.rootBg,
    depth: 0,
    hasHiddenChildren: root.children.length > 0 && collapsed.has(root.id),
  });

  if (root.children.length === 0 || collapsed.has(root.id)) {
    return { nodes, edges, minX: -rootW / 2 - 28, minY: -ROOT_H / 2 - 24, width: rootW + 56, height: ROOT_H + 48 };
  }

  const rightBranches: { branch: MindNode; color: string }[] = [];
  const leftBranches: { branch: MindNode; color: string }[] = [];

  root.children.forEach((child, idx) => {
    const color = palette.branches[idx % palette.branches.length];
    if (layout === "mind" && idx % 2 === 1) {
      leftBranches.push({ branch: child, color });
    } else {
      rightBranches.push({ branch: child, color });
    }
  });

  const placeSubtree = (
    cur: MindNode,
    side: "left" | "right",
    anchorX: number,
    topY: number,
    spanH: number,
    color: string,
    depth: number,
    parentAnchor: { x: number; y: number },
  ) => {
    const w = measureTextWidth(cur.text, false);
    const centerY = topY + spanH / 2;
    const x = side === "right" ? anchorX : anchorX - w;
    const y = centerY - NODE_H / 2;
    const isCollapsed = collapsed.has(cur.id);

    nodes.push({
      node: cur,
      x,
      y,
      w,
      h: NODE_H,
      side,
      color,
      depth,
      hasHiddenChildren: cur.children.length > 0 && isCollapsed,
    });

    const childAttachX = side === "right" ? x : x + w;
    const ctrlOffset = (childAttachX - parentAnchor.x) * 0.52;
    edges.push({
      key: `${cur.id}-edge`,
      d: `M ${parentAnchor.x} ${parentAnchor.y} C ${parentAnchor.x + ctrlOffset} ${parentAnchor.y}, ${childAttachX - ctrlOffset} ${centerY}, ${childAttachX} ${centerY}`,
      color,
      width: depth === 1 ? 2.4 : 1.7,
    });

    if (cur.children.length > 0 && !isCollapsed) {
      let curTop = topY;
      const nextAnchorX = side === "right" ? x + w + H_GAP : x - H_GAP;
      const nextParentAttach = { x: side === "right" ? x + w : x, y: centerY };
      for (const sub of cur.children) {
        const subSpan = subtreeSpan(sub, collapsed);
        placeSubtree(sub, side, nextAnchorX, curTop, subSpan, color, depth + 1, nextParentAttach);
        curTop += subSpan;
      }
    }
  };

  if (rightBranches.length > 0) {
    const totalRight = rightBranches.reduce((s, b) => s + subtreeSpan(b.branch, collapsed), 0);
    let yCursor = -totalRight / 2;
    for (const { branch, color } of rightBranches) {
      const sp = subtreeSpan(branch, collapsed);
      placeSubtree(branch, "right", rootW / 2 + H_GAP, yCursor, sp, color, 1, { x: rootW / 2, y: 0 });
      yCursor += sp;
    }
  }

  if (leftBranches.length > 0) {
    const totalLeft = leftBranches.reduce((s, b) => s + subtreeSpan(b.branch, collapsed), 0);
    let yCursor = -totalLeft / 2;
    for (const { branch, color } of leftBranches) {
      const sp = subtreeSpan(branch, collapsed);
      placeSubtree(branch, "left", -rootW / 2 - H_GAP, yCursor, sp, color, 1, { x: -rootW / 2, y: 0 });
      yCursor += sp;
    }
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of nodes) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x + p.w);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y + p.h);
  }
  const padX = 34;
  const padY = 26;
  return {
    nodes,
    edges,
    minX: minX - padX,
    minY: minY - padY,
    width: Math.max(320, maxX - minX + padX * 2),
    height: Math.max(160, maxY - minY + padY * 2),
  };
}

function mutateTree(
  root: MindNode,
  targetId: string,
  action: "rename" | "addChild" | "addSibling" | "delete",
  newText?: string,
): MindNode {
  if (action === "rename" && root.id === targetId) {
    return { ...root, text: newText || root.text };
  }
  if (action === "addChild" && root.id === targetId) {
    return {
      ...root,
      children: [...root.children, { id: `n_${Date.now()}`, text: newText || "新分支", children: [] }],
    };
  }

  const nextChildren: MindNode[] = [];
  for (const child of root.children) {
    if (child.id === targetId) {
      if (action === "delete") continue;
      if (action === "rename") {
        nextChildren.push({ ...child, text: newText || child.text });
        continue;
      }
      if (action === "addChild") {
        nextChildren.push({
          ...child,
          children: [...child.children, { id: `n_${Date.now()}`, text: newText || "新节点", children: [] }],
        });
        continue;
      }
      if (action === "addSibling") {
        nextChildren.push(child, { id: `n_${Date.now()}`, text: newText || "同级节点", children: [] });
        continue;
      }
    }
    nextChildren.push(mutateTree(child, targetId, action, newText));
  }
  return { ...root, children: nextChildren };
}

/**
 * 交互式 SVG 思维导图组件：支持节点点击选中、直接增删子节点/同级节点、双击就地改名与子树折叠
 */
export function MindMapDiagram({
  outline,
  layout = "mind",
  theme = "rainbow",
  editable = false,
  onChangeOutline,
}: {
  outline: string;
  layout?: MindLayout;
  theme?: MindTheme;
  editable?: boolean;
  onChangeOutline?: (next: string) => void;
}) {
  const tree = parseMindOutline(outline);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const { nodes, edges, minX, minY, width, height } = layoutMindTree(tree, layout, theme, collapsed);
  const palette = THEME_PALETTES[theme] ?? THEME_PALETTES.rainbow;
  const selectedPlaced = nodes.find((n) => n.node.id === selectedId) ?? null;

  const applyMutation = (
    targetId: string,
    action: "rename" | "addChild" | "addSibling" | "delete",
    text?: string,
  ) => {
    if (!onChangeOutline) return;
    const updated = mutateTree(tree, targetId, action, text);
    onChangeOutline(serializeMindTree(updated));
    if (action === "delete") setSelectedId(null);
  };

  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="mindmap-stage">
      {editable && selectedPlaced && (
        <div className="mindmap-node-bar">
          {editingId === selectedPlaced.node.id ? (
            <input
              autoFocus
              className="mindmap-rename-input"
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              onBlur={() => {
                applyMutation(selectedPlaced.node.id, "rename", draftText.trim());
                setEditingId(null);
              }}
              onKeyDown={(e) => {
                if (!e.nativeEvent.isComposing && e.key === "Enter") {
                  e.preventDefault();
                  applyMutation(selectedPlaced.node.id, "rename", draftText.trim());
                  setEditingId(null);
                } else if (e.key === "Escape") {
                  setEditingId(null);
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="text-btn small"
              onClick={() => {
                setDraftText(selectedPlaced.node.text);
                setEditingId(selectedPlaced.node.id);
              }}
            >
              编辑“{selectedPlaced.node.text.slice(0, 12)}”
            </button>
          )}
          <button
            type="button"
            className="text-btn small"
            onClick={() => {
              setCollapsed((prev) => {
                const n = new Set(prev);
                n.delete(selectedPlaced.node.id);
                return n;
              });
              applyMutation(selectedPlaced.node.id, "addChild");
            }}
          >
            <Plus size={12} /> 子节点
          </button>
          {selectedPlaced.depth > 0 && (
            <>
              <button
                type="button"
                className="text-btn small"
                onClick={() => applyMutation(selectedPlaced.node.id, "addSibling")}
              >
                <Plus size={12} /> 同级节点
              </button>
              <button
                type="button"
                className="text-btn small danger"
                onClick={() => applyMutation(selectedPlaced.node.id, "delete")}
              >
                <Trash2 size={12} /> 删除
              </button>
            </>
          )}
          {selectedPlaced.node.children.length > 0 && (
            <button
              type="button"
              className="text-btn small"
              onClick={() => toggleCollapse(selectedPlaced.node.id)}
            >
              <Minus size={12} /> {collapsed.has(selectedPlaced.node.id) ? `展开 (${selectedPlaced.node.children.length})` : "折叠"}
            </button>
          )}
        </div>
      )}

      <svg
        className="mindmap-svg"
        viewBox={`${minX} ${minY} ${width} ${height}`}
        role="img"
        aria-label={`思维导图：${tree.text}`}
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            setSelectedId(null);
            setEditingId(null);
          }
        }}
      >
        {edges.map((edge) => (
          <path
            key={edge.key}
            d={edge.d}
            fill="none"
            stroke={edge.color}
            strokeWidth={edge.width}
            strokeLinecap="round"
            opacity={0.85}
          />
        ))}

        {nodes.map((p) => {
          const isRoot = p.side === "root";
          const isSelected = p.node.id === selectedId;
          const fill = isRoot ? palette.rootBg : p.depth === 1 ? `${p.color}18` : "var(--bg)";
          const stroke = isRoot ? palette.rootBg : p.color;
          return (
            <g
              key={p.node.id}
              transform={`translate(${p.x}, ${p.y})`}
              className="mindmap-g-node"
              style={{ cursor: editable ? "pointer" : "default" }}
              onClick={(e) => {
                e.stopPropagation();
                if (!editable) return;
                setSelectedId(p.node.id);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                if (!editable) return;
                setSelectedId(p.node.id);
                setDraftText(p.node.text);
                setEditingId(p.node.id);
              }}
            >
              <rect
                width={p.w}
                height={p.h}
                rx={isRoot ? 10 : 7}
                fill={fill}
                stroke={isSelected ? "var(--accent)" : stroke}
                strokeWidth={isSelected ? 2.4 : isRoot ? 0 : 1.5}
              />
              <text
                x={p.w / 2}
                y={p.h / 2 + (isRoot ? 5 : 4.5)}
                textAnchor="middle"
                className={isRoot ? "mindmap-root-label" : "mindmap-node-label"}
                style={isRoot ? { fill: palette.rootText } : undefined}
              >
                {p.node.text}
              </text>
              {p.hasHiddenChildren && (
                <g
                  transform={`translate(${p.side === "left" ? -10 : p.w + 10}, ${p.h / 2})`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleCollapse(p.node.id);
                  }}
                >
                  <circle r="9" fill={p.color} />
                  <text y="3.5" textAnchor="middle" fill="#fff" fontSize="10" fontWeight="700">
                    {p.node.children.length}
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
