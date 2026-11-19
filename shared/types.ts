export type PageKind = "page" | "database";

export type PageFont = "sans" | "serif" | "mono";

export type PropType =
  | "text"
  | "number"
  | "select"
  | "multiSelect"
  | "date"
  | "checkbox"
  | "url"
  | "relation"
  | "rollup"
  | "formula"
  | "button";

export type RollupFn = "show" | "count" | "sum" | "avg" | "min" | "max";

export type CalcFn =
  | "none"
  | "count"
  | "filled"
  | "empty"
  | "percentFilled"
  | "checked"
  | "unchecked"
  | "percentChecked"
  | "sum"
  | "avg"
  | "min"
  | "max";

/** 属性值：文本/网址/日期/单选为字符串，多选为选项 id 数组，关联为行（页面）id 数组 */
export type PropValue = string | number | boolean | string[] | null;

export interface SelectOption {
  id: string;
  name: string;
  color: string;
}

export interface ActionStep {
  id: string;
  type: "set_prop" | "create_row";
  /** set_prop 时目标属性 id */
  propId?: string;
  /** set_prop 时的目标值（日期属性支持 "$today" 代表当天） */
  value?: PropValue;
  /** create_row 时新建行的标题 */
  title?: string;
}

export interface DatabaseAutomation {
  id: string;
  name: string;
  enabled: boolean;
  trigger: {
    type: "row_created" | "prop_changed";
    propId?: string;
    value?: string;
  };
  actions: ActionStep[];
}

export interface PropertyDef {
  id: string;
  name: string;
  type: PropType;
  options?: SelectOption[];
  /** 关联属性：关联到哪个数据库（页面 id） */
  relationDb?: string;
  /** 汇总属性：顺着哪个关联属性、取对方的哪个属性、怎么汇总 */
  rollup?: { relationProp: string; targetProp: string; fn: RollupFn };
  /** 公式属性的表达式 */
  formula?: string;
  /** AI 自动填充提示词（用于文本属性一键生成摘要、分类、翻译等） */
  aiPrompt?: string;
  /** 按钮属性的按钮文字与点击动作 */
  buttonLabel?: string;
  buttonActions?: ActionStep[];
}

export type FilterOp =
  | "contains"
  | "notContains"
  | "is"
  | "isNot"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "before"
  | "after"
  | "isEmpty"
  | "isNotEmpty"
  | "checked"
  | "unchecked";

export interface FilterRule {
  id: string;
  /** "title" 表示名称 */
  propId: string;
  op: FilterOp;
  /** 文本、数字、日期或选项 id；不需要值的条件（为空、已勾选等）留空 */
  value?: string;
}

export interface FilterGroup {
  id: string;
  mode: "and" | "or";
  rules: FilterRule[];
}

export type ViewType = "table" | "board" | "calendar" | "list" | "gallery" | "timeline" | "chart" | "form";
export type ChartKind = "bar" | "line" | "donut";

export interface ViewDef {
  id: string;
  name: string;
  type: ViewType;
  /** 看板 / 表格 / 列表按哪个属性分组 */
  groupBy?: string | null;
  /** 表格 / 列表中已折叠的分组 key */
  collapsedGroups?: string[];
  /** 日历 / 时间轴按哪个日期属性排布（时间轴里是开始日期） */
  dateProp?: string | null;
  /** 时间轴的结束日期属性；不设则每行只占一天 */
  endProp?: string | null;
  /** 图表视图配置 */
  chartType?: ChartKind;
  chartGroupBy?: string | null;
  chartMetric?: { fn: "count" | "sum" | "avg" | "max"; propId?: string | null };
  /** 表单视图的顶部说明文案 */
  formDesc?: string;
  /** 画廊卡片尺寸与封面展示来源 */
  cardSize?: "small" | "medium" | "large";
  cardCover?: "cover" | "content" | "none";
  /** 表格各列的宽度（像素），key 为属性 id，名称列为 "title" */
  widths?: Record<string, number>;
  /** 当前视图中隐藏的属性 id 列表 */
  hiddenProps?: string[];
  /** 表格底部各列的汇总计算方式，key 为属性 id 或 "title" */
  calculations?: Record<string, CalcFn>;
  /** propId 为 "title" 表示按名称排序 */
  sort?: { propId: string; dir: "asc" | "desc" } | null;
  filters?: FilterRule[];
  /** 多层嵌套的条件组（与 filters 共同生效） */
  filterGroups?: FilterGroup[];
  /** 多个筛选条件/组之间的关系，默认 and */
  filterMode?: "and" | "or";
}

export interface DatabaseDef {
  properties: PropertyDef[];
  views: ViewDef[];
  /** 是否开启子任务（无限层级子行） */
  subItemsEnabled?: boolean;
  /** 时间轴前后置依赖使用的同库关联属性 id */
  dependencyProp?: string | null;
  /** 数据库自动化触发器与动作列表 */
  automations?: DatabaseAutomation[];
}

export interface PageCommentReply {
  id: string;
  author: string;
  text: string;
  createdAt: number;
}

export interface PageComment {
  id: string;
  author: string;
  text: string;
  /** 选中正文划词批注时引用的原文片段 */
  quote?: string;
  resolved?: boolean;
  /** 讨论串多轮回复列表 */
  replies?: PageCommentReply[];
  createdAt: number;
}

export interface PageShareConfig {
  enabled: boolean;
  token: string;
  /** 是否开启了访问口令保护（服务端只保存哈希，不明文回传口令） */
  hasPassword?: boolean;
  /** 数据库页面发布后，是否允许外部访客填写并提交公开表单 */
  allowFormSubmit?: boolean;
  /** 是否在公开分享页展示更新时间与字数 */
  showMeta?: boolean;
  /** 是否在公开分享页展示底部品牌署名 */
  showBrand?: boolean;
}

export interface PageMeta {
  id: string;
  title: string;
  icon: string | null;
  /** 预设封面的 key（如 "preset:sunset"）或上传图片的 URL */
  cover: string | null;
  /** 封面图纵向裁剪焦点百分比（0 ~ 100，默认 50） */
  coverY?: number;
  /** 多维页面分类标签（不含 # 前缀） */
  tags?: string[];
  /** 网页公开分享与访问密码保护状态 */
  share?: PageShareConfig;
  parentId: string | null;
  order: number;
  favorite: boolean;
  fullWidth: boolean;
  smallText: boolean;
  font: PageFont;
  locked: boolean;
  comments: PageComment[];
  trashed: boolean;
  trashedAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** 数据库页面的子页面就是它的“行” */
  kind: PageKind;
  /** 仅 kind 为 database 时有值：属性定义与视图 */
  database: DatabaseDef | null;
  /** 作为数据库的一行时，各属性的值（key 为属性 id） */
  props: Record<string, PropValue>;
  /** 标记为模板：可以在新页面上一键套用 */
  template: boolean;
  /** 不出现在页面树、搜索和回收站里的内部页面（同步块的内容就存成这样的页面） */
  hidden: boolean;
}

export interface PageRecord extends PageMeta {
  /** BlockNote 文档 JSON */
  content: unknown[];
}

export type PagePatch = Partial<
  Pick<
    PageRecord,
    | "title"
    | "icon"
    | "cover"
    | "coverY"
    | "tags"
    | "favorite"
    | "fullWidth"
    | "smallText"
    | "font"
    | "locked"
    | "comments"
    | "content"
    | "kind"
    | "database"
    | "props"
    | "template"
  >
>;

export interface NewPageInput {
  parentId?: string | null;
  title?: string;
  icon?: string | null;
  tags?: string[];
  kind?: PageKind;
  database?: DatabaseDef | null;
  props?: Record<string, PropValue>;
  content?: unknown[];
  hidden?: boolean;
}

/** 页面历史里的一个版本 */
export interface HistoryEntry {
  /** 保存这个版本的时间戳，同时是它的 id */
  ts: number;
  title: string;
  /** 正文的大致字数，帮助分辨版本 */
  chars: number;
}

export interface SearchHit {
  id: string;
  title: string;
  icon: string | null;
  snippet: string;
}

export interface UnfurlData {
  url: string;
  title: string;
  description: string;
  siteName: string;
}

/* ---------- AI 模型配置与对话 ---------- */

export type AiProtocol = "openai" | "anthropic" | "gemini";
export type AiRegion = "domestic" | "foreign" | "custom";

export interface AiProviderPublic {
  id: string;
  name: string;
  region: AiRegion;
  builtin: boolean;
  protocol: AiProtocol;
  baseUrl: string;
  defaultBaseUrl?: string;
  models: string[];
  /** 是否无需填写 API Key（例如本地 Ollama） */
  keyOptional?: boolean;
  /** 模型填写提示（如火山方舟的 Endpoint ID 说明） */
  modelHint?: string;
  /** 获取 Key 的控制台链接说明 */
  keyPlaceholder?: string;
  hasKey: boolean;
  keyHint: string;
  headers?: Record<string, string>;
}

export interface AiProviderUpdate {
  id: string;
  name: string;
  region: AiRegion;
  builtin?: boolean;
  protocol: AiProtocol;
  baseUrl: string;
  models: string[];
  keyOptional?: boolean;
  /** 留空或不传表示保持原已保存的 Key；传 "__CLEAR__" 表示清空 Key */
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface AiConfigPublic {
  providers: AiProviderPublic[];
  activeProviderId: string;
  activeModel: string;
  temperature: number;
  customSystemPrompt: string;
}

export interface AiConfigUpdate {
  providers?: AiProviderUpdate[];
  activeProviderId?: string;
  activeModel?: string;
  temperature?: number;
  customSystemPrompt?: string;
}

export interface AiChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiCitation {
  id: string;
  title: string;
  icon: string | null;
}

export interface StorageInfo {
  dataDir: string;
  defaultDataDir?: string;
  isDesktop: boolean;
  isCustomDir: boolean;
}

export interface McpConfigPublic {
  enabled: boolean;
  requireToken: boolean;
  token: string;
  endpoint: string;
  stdioCommand: string;
  tools: { name: string; description: string }[];
}

export interface ClipRequest {
  url: string;
  title?: string;
  html?: string;
  text?: string;
  tags?: string[];
  parentId?: string | null;
}

export interface ClipResult {
  id: string;
  title: string;
  siteName: string;
  blockCount: number;
  pages: PageMeta[];
}

export interface ShareUpdateInput {
  enabled?: boolean;
  /** 传非空字符串设置新密码；传 "__CLEAR__" 清除密码；不传保持不变 */
  password?: string;
  allowFormSubmit?: boolean;
  showMeta?: boolean;
  showBrand?: boolean;
  rotateToken?: boolean;
}

export type PublicSharePayload =
  | {
      locked: true;
      title: string;
      icon: string | null;
    }
  | {
      locked: false;
      page: PageRecord;
      rows: PageMeta[];
    };

export interface WebDavConfigPublic {
  enabled: boolean;
  url: string;
  username: string;
  hasPassword: boolean;
  remoteDir: string;
}

export interface BackupConfigPublic {
  autoEnabled: boolean;
  intervalHours: number;
  keepCount: number;
  hasEncryptPassword: boolean;
  lastBackupAt: number | null;
  lastStatus: string | null;
  webdav: WebDavConfigPublic;
}

export interface BackupConfigUpdate {
  autoEnabled?: boolean;
  intervalHours?: number;
  keepCount?: number;
  /** 传非空设置自动备份加密密码；传 "__CLEAR__" 清除密码 */
  encryptPassword?: string;
  webdav?: {
    enabled?: boolean;
    url?: string;
    username?: string;
    /** 传非空设置 WebDAV 密码；传 "__CLEAR__" 清除密码 */
    password?: string;
    remoteDir?: string;
  };
}

export interface BackupSnapshotItem {
  filename: string;
  size: number;
  createdAt: number;
  encrypted: boolean;
}
