import { useRef, type CSSProperties } from "react";
import { ImageOff, Palette, Shuffle, SmilePlus, Upload, X } from "lucide-react";
import { reportError, uploadFile } from "../store";
import { Popover } from "./Popover";

const EMOJI_GROUPS: { name: string; emoji: string[] }[] = [
  {
    name: "常用",
    emoji: "📄 📝 📒 📚 📌 📎 💡 ✅ ⭐ 🔥 🎯 🚀 💼 📅 📊 📈 🗂️ 🧠 💬 🔖 🏠 ❤️ 🎉 ⚙️".split(" "),
  },
  {
    name: "表情与人物",
    emoji: "😀 😄 😊 😉 😍 🤔 😎 🥳 😴 🤯 😭 😡 👍 👎 👏 🙏 💪 👀 🧑‍💻 🧑‍🎓 🧑‍🍳 🧑‍🎨 👋 🤝".split(" "),
  },
  {
    name: "自然与食物",
    emoji: "🌱 🌳 🌸 🌻 🍀 🍁 🌈 ☀️ 🌙 ⛅ 🌊 ⛰️ 🐶 🐱 🐼 🦊 🐳 🦋 🍎 🍊 🍜 🍣 ☕ 🍰".split(" "),
  },
  {
    name: "物品与活动",
    emoji: "💻 📱 ⌨️ 🖥️ 📷 🎧 🎮 🎨 🎬 🎵 ⚽ 🏀 🏃 🧘 ✈️ 🚗 🚲 🗺️ 🏆 🎁 💰 🔑 🔒 🧰".split(" "),
  },
];

const ALL_EMOJI = EMOJI_GROUPS.flatMap((g) => g.emoji);

interface EmojiPickerProps {
  anchor: HTMLElement;
  hasIcon: boolean;
  onPick: (emoji: string | null) => void;
  onClose: () => void;
}

export function EmojiPicker({ anchor, hasIcon, onPick, onClose }: EmojiPickerProps) {
  return (
    <Popover anchor={anchor} onClose={onClose} className="emoji-picker">
      <div className="picker-toolbar">
        <button
          type="button"
          className="text-btn"
          onClick={() => onPick(ALL_EMOJI[Math.floor(Math.random() * ALL_EMOJI.length)])}
        >
          <Shuffle size={14} /> 随机
        </button>
        {hasIcon && (
          <button
            type="button"
            className="text-btn"
            onClick={() => {
              onPick(null);
              onClose();
            }}
          >
            <X size={14} /> 移除
          </button>
        )}
      </div>
      <div className="emoji-scroll">
        {EMOJI_GROUPS.map((group) => (
          <div key={group.name}>
            <div className="picker-group-title">
              {group.name === "常用" && <SmilePlus size={12} />} {group.name}
            </div>
            <div className="emoji-grid">
              {group.emoji.map((e) => (
                <button
                  key={e}
                  type="button"
                  className="emoji-cell"
                  onClick={() => {
                    onPick(e);
                    onClose();
                  }}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Popover>
  );
}

export const COVER_PRESETS: Record<string, string> = {
  "preset:sunrise": "linear-gradient(120deg, #f6d365 0%, #fda085 100%)",
  "preset:ocean": "linear-gradient(120deg, #89f7fe 0%, #66a6ff 100%)",
  "preset:meadow": "linear-gradient(120deg, #d4fc79 0%, #96e6a1 100%)",
  "preset:blossom": "linear-gradient(120deg, #fbc2eb 0%, #a6c1ee 100%)",
  "preset:dusk": "linear-gradient(120deg, #a18cd1 0%, #fbc2eb 100%)",
  "preset:ember": "linear-gradient(120deg, #ff9a9e 0%, #fecfef 100%)",
  "preset:night": "linear-gradient(120deg, #2b5876 0%, #4e4376 100%)",
  "preset:forest": "linear-gradient(120deg, #134e5e 0%, #71b280 100%)",
  "preset:sand": "#e9e5dc",
  "preset:slate": "#8a9099",
  "preset:rose": "#e8b4b8",
  "preset:teal": "#7fb7be",
};

const PRESET_KEYS = Object.keys(COVER_PRESETS);

export const randomCover = () => PRESET_KEYS[Math.floor(Math.random() * 8)];

export function coverStyle(cover: string, coverY = 50): CSSProperties {
  if (COVER_PRESETS[cover]) return { background: COVER_PRESETS[cover] };
  // 只接受本应用上传目录里的图片
  if (/^\/uploads\/[a-f0-9]{16}\.[a-z0-9]{1,8}$/.test(cover)) {
    const y = typeof coverY === "number" && Number.isFinite(coverY) ? Math.max(0, Math.min(100, coverY)) : 50;
    return {
      backgroundImage: `url("${cover}")`,
      backgroundSize: "cover",
      backgroundPosition: `center ${y}%`,
    };
  }
  return { background: "var(--hover)" };
}

interface CoverPickerProps {
  anchor: HTMLElement;
  onPick: (cover: string | null) => void;
  onClose: () => void;
}

export function CoverPicker({ anchor, onPick, onClose }: CoverPickerProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <Popover anchor={anchor} onClose={onClose} align="end" className="cover-picker">
      <div className="picker-toolbar">
        <button type="button" className="text-btn" onClick={() => fileRef.current?.click()}>
          <Upload size={14} /> 上传图片
        </button>
        <button
          type="button"
          className="text-btn"
          onClick={() => {
            onPick(null);
            onClose();
          }}
        >
          <ImageOff size={14} /> 移除
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
              onPick(await uploadFile(file));
              onClose();
            } catch (err) {
              reportError(err instanceof Error ? err.message : "上传失败");
            }
          }}
        />
      </div>
      <div className="picker-group-title">
        <Palette size={12} /> 渐变与纯色
      </div>
      <div className="cover-grid">
        {PRESET_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            className="cover-cell"
            aria-label={`封面 ${key.replace("preset:", "")}`}
            style={{ background: COVER_PRESETS[key] }}
            onClick={() => onPick(key)}
          />
        ))}
      </div>
    </Popover>
  );
}
