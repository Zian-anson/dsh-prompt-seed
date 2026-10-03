/**
 * prompt-seed / 拒绝样本落盘
 * ---------------------------------------------------------------------------
 * 保真闸门的"蕴含分类表"是手写清单，永远可能漏类——每漏一类就是一次误拒，
 * 而误拒对用户表现为"功能坏了"。靠猜补不齐，必须用真实样本补。
 *
 * 这里把每次 fidelity_rejected 的输入与审判条目追加到本地 JSONL，
 * 供后续按真实分布补分类表、写回归用例。
 *
 * 边界：
 *   - 只落本地文件，不上报任何地方；
 *   - 输入截断（默认 4000 字符），避免把超长草稿整份写盘；
 *   - 任何失败都被吞掉：采样绝不能影响优化主流程；
 *   - `samples: false` 可完全关闭。
 */

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 单条样本里输入文本的最大长度。 */
const INPUT_LIMIT = 4000;

/**
 * 解析样本文件路径。
 * @param {string | boolean | undefined} configured 行配置 `samples`：字符串为自定义路径，false 关闭。
 * @returns {string | null} 文件路径；null 表示关闭。
 */
export function resolveSamplePath(configured) {
  if (configured === false) return null;
  if (typeof configured === "string" && configured.trim() !== "") return configured;
  const home =
    typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.trim() !== ""
      ? process.env.DSH_HOME
      : join(homedir(), ".dsh");
  return join(home, "prompt-seed", "samples.jsonl");
}

/**
 * 追加一条样本。失败静默（采样是旁路，不是主流程）。
 * @param {string} file 样本文件路径。
 * @param {object} record 样本记录（含 input / added / provider / model 等）。
 * @returns {Promise<boolean>} 是否写入成功。
 */
export async function appendSample(file, record) {
  if (typeof file !== "string" || file === "") return false;
  try {
    await mkdir(dirname(file), { recursive: true });
    const input = typeof record?.input === "string" ? record.input.slice(0, INPUT_LIMIT) : "";
    await appendFile(file, `${JSON.stringify({ ...record, input })}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}
