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
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const problems = [];
let checked = 0;

// ---- 1) 测试计数 ----
// 统计 test/*.test.mjs 的顶层测试声明（本仓库所有用例都是顶层 test(...)，嵌套子测试会改变口径）
const testFiles = readdirSync(join(root, "test")).filter((name) => name.endsWith(".test.mjs"));
const actual = testFiles.reduce((sum, name) => sum + (read(join("test", name)).match(/^test\(/gm) || []).length, 0);
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

// ---- 3) 真实 socket 检查数 ----
// 这条数字最初是手写的，于是很快漂了：脚本跑 14 项、FEATURES 写 12 项，而 CI 全程是绿的
// ——因为没有任何守卫在看这个数。未纳入守卫的数字就是会漂，这正是本脚本存在的理由。
//
// 数的是脚本里的 DECLARED_CHECKS 常数，而不是源码里的 `check("` 出现次数：循环里生成的
// 检查在源码中只出现一次、运行时跑多次，源码计数永远对不上运行时计数。脚本结束前会拿
// 实际执行条数与这个常数核对，于是"文档 = 常数 = 实际执行"三者被锁在一起。
const wireDeclared = /const DECLARED_CHECKS = (\d+);/.exec(read("tools/check-route-wire.mjs"));
if (wireDeclared === null) {
  console.error("[docs] 读不到 tools/check-route-wire.mjs 的 DECLARED_CHECKS：守卫本身失效比数字漂移更危险");
  process.exit(1);
}
const wireChecks = Number(wireDeclared[1]);
if (wireChecks === 0) {
  console.error("[docs] 没统计到任何真实 socket 检查：正则或写法变了，守卫本身失效比数字漂移更危险");
  process.exit(1);
}
const wireClaims = [
  ["README.md", /✅ (\d+) checks, run by `npm test`/, "英文 README 验证表"],
  ["docs/FEATURES.md", /`npm run check:wire`，(\d+) 项/, "FEATURES 验证手段"],
];
for (const [file, pattern, where] of wireClaims) {
  const found = read(file).match(pattern);
  if (!found) {
    problems.push(`${file}（${where}）：找不到声明，模式可能已失效`);
    continue;
  }
  checked += 1;
  if (Number(found[1]) !== wireChecks) problems.push(`${file}（${where}）：声明 ${found[1]}，实际 ${wireChecks}`);
}

if (problems.length > 0) {
  console.error(`[docs] 实际测试数 ${actual}、版本 ${pkgVersion}、真实 socket 检查 ${wireChecks}，以下声明不一致：`);
  for (const line of problems) console.error("  - " + line);
  process.exit(1);
}
console.log(
  `[docs] ${checked} 处声明与仓库一致：${actual} 项测试、${wireChecks} 项真实 socket 检查、版本 ${pkgVersion}`,
);
