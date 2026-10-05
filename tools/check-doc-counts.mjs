#!/usr/bin/env node
/**
 * 文档一致性守卫：README（中英）、FEATURES 与 CHANGELOG 里声明的数字和版本，
 * 必须与仓库真实状态一致。
 *
 * 为什么需要它：同一类漂移在这个项目里已经手工修过多次——每加一批测试，徽章、正文
 * 与功能清单就落后一轮；每次升版本，安装 URL 与 CHANGELOG 段落就可能漏一处。数字与
 * 版本是读者判断整份文档是否最新的最廉价信号，留在文档里的旧值会让整页内容一起打折。
 * 机器能查的事不该靠人记得。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const problems = [];
let checked = 0;

// ---- 1) 测试计数 ----
// 只统计顶层测试声明（本仓库所有用例都是顶层 test(...)，嵌套子测试会改变口径）
const actual = (read("test/optimizer.test.mjs").match(/^test\(/gm) || []).length;
if (actual === 0) {
  console.error("[docs] 没统计到任何测试：正则或测试写法变了，守卫本身失效比数字漂移更危险");
  process.exit(1);
}

/** 每处计数声明：文件、正则（第 1 组为数字）、人类可读位置。 */
const countClaims = [
  ["README.md", /tests-(\d+)%20passing/, "英文 README 徽章"],
  ["README.md", /runs (\d+) tests/, "英文 README 开发说明"],
  ["README.zh-CN.md", /tests-(\d+)%20passing/, "中文 README 徽章"],
  ["README.zh-CN.md", /\| (\d+) 项单元\/契约\/路由测试 \|/, "中文 README 文件表"],
  ["README.zh-CN.md", /再跑 (\d+) 项测试/, "中文 README 开发说明"],
  ["docs/FEATURES.md", /单元测试 (\d+) 项/, "FEATURES 验证手段"],
  ["docs/FEATURES.md", /单元测试\*\*（(\d+) 项）/, "FEATURES 明细"],
  ["docs/FEATURES.md", /\| \*\*单元测试\*\* \| ✅ (\d+) 项全通过 \|/, "FEATURES 模块表"],
];
for (const [file, pattern, where] of countClaims) {
  const found = read(file).match(pattern);
  if (!found) {
    problems.push(`${file}（${where}）：找不到声明，模式可能已失效`);
    continue;
  }
  checked += 1;
  if (Number(found[1]) !== actual) problems.push(`${file}（${where}）：声明 ${found[1]}，实际 ${actual}`);
}

// ---- 2) 版本一致性 ----
// 升版本时最容易漏的就是安装 URL 与 CHANGELOG 段落：用户复制到的下载链接会指向旧版本，
// 而这件事没人会主动去查。
const pkgVersion = JSON.parse(read("package.json")).version;
const versionClaims = [
  ["README.md", /releases\/download\/v([0-9.]+)\//, "英文 README 安装 URL"],
  ["README.zh-CN.md", /releases\/download\/v([0-9.]+)\//, "中文 README 安装 URL"],
];
for (const [file, pattern, where] of versionClaims) {
  const found = read(file).match(pattern);
  if (!found) {
    problems.push(`${file}（${where}）：找不到版本化的发布链接`);
    continue;
  }
  checked += 1;
  if (found[1] !== pkgVersion) problems.push(`${file}（${where}）：链接指向 v${found[1]}，package.json 是 ${pkgVersion}`);
}
if (read("CHANGELOG.md").includes(`## [${pkgVersion}]`)) {
  checked += 1;
} else {
  problems.push(`CHANGELOG.md：没有 ## [${pkgVersion}] 段落（版本已升但没记变更）`);
}

if (problems.length > 0) {
  console.error(`[docs] 实际测试数 ${actual}、版本 ${pkgVersion}，以下声明不一致：`);
  for (const line of problems) console.error("  - " + line);
  process.exit(1);
}
console.log(`[docs] ${checked} 处声明与仓库一致：${actual} 项测试、版本 ${pkgVersion}`);
