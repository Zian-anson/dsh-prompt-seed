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
 * 已经确认存在的目录（进程内记忆）。
 *
 * mkdir(recursive) 对已存在的目录是必然成功的空操作，但每次调用仍要走一遍路径
 * 解析与系统调用；采样发生在每次优化的收尾路径上，没必要为此付费。记一次即可。
 * 唯一要防的是"目录后来被外部删掉"——写入失败时失效该条目，下一次调用会重建
 * （见 catch 分支），行为与未缓存时一致。
 */
const readyDirs = new Set();

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
  const dir = dirname(file);
  const input = typeof record?.input === "string" ? record.input.slice(0, INPUT_LIMIT) : "";
  const line = `${JSON.stringify({ ...record, input })}\n`;
  const write = async () => {
    if (!readyDirs.has(dir)) {
      await mkdir(dir, { recursive: true });
      readyDirs.add(dir);
    }
    await appendFile(file, line, "utf8");
  };
  try {
    await write();
    return true;
  } catch {
    // 第一次失败最可能的成因是缓存里的目录已被外部删除：失效缓存并在同一次
    // 调用内重试一次。采样是旁路，一次重试的成本远低于丢掉一条样本——
    // 而这正是"缓存目录"若不处理会引入的新失败模式。
    readyDirs.delete(dir);
    try {
      await write();
      return true;
    } catch {
      return false;
    }
  }
}
