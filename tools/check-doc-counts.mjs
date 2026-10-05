#!/usr/bin/env node
/**
 * 文档计数守卫：README（中英）与 FEATURES 里声明的测试数必须等于真实测试数。
 *
 * 为什么需要它：同一类数字漂移在这个项目里已经手工修过三次——每加一批测试，
 * 徽章、正文与功能清单就落后一轮。数字是读者判断整份文档是否最新的最廉价信号，
 * 留在文档里的旧数字会让整页内容一起打折。机器能查的事不该靠人记得。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

// 只统计顶层测试声明（本仓库所有用例都是顶层 test(...)，嵌套子测试会改变口径）
const testSource = read("test/optimizer.test.mjs");
const actual = (testSource.match(/^test\(/gm) || []).length;
if (actual === 0) {
  console.error("[doc-counts] 没统计到任何测试：正则或测试写法变了，守卫本身失效比数字漂移更危险");
  process.exit(1);
}

/** 每处声明：文件、正则（第 1 组为数字）、人类可读位置。 */
const claims = [
  ["README.md", /tests-(\d+)%20passing/, "英文 README 徽章"],
  ["README.md", /runs (\d+) tests/, "英文 README 开发说明"],
  ["README.zh-CN.md", /tests-(\d+)%20passing/, "中文 README 徽章"],
  ["README.zh-CN.md", /\| (\d+) 项单元\/契约\/路由测试 \|/, "中文 README 文件表"],
  ["README.zh-CN.md", /再跑 (\d+) 项测试/, "中文 README 开发说明"],
  ["docs/FEATURES.md", /单元测试 (\d+) 项/, "FEATURES 验证手段"],
  ["docs/FEATURES.md", /单元测试\*\*（(\d+) 项）/, "FEATURES 明细"],
  ["docs/FEATURES.md", /\| \*\*单元测试\*\* \| ✅ (\d+) 项全通过 \|/, "FEATURES 模块表"],
];

const mismatches = [];
let checked = 0;
for (const [file, pattern, where] of claims) {
  const found = read(file).match(pattern);
  if (!found) {
    mismatches.push(`${file}（${where}）：找不到声明，模式可能已失效`);
    continue;
  }
  checked += 1;
  if (Number(found[1]) !== actual) {
    mismatches.push(`${file}（${where}）：声明 ${found[1]}，实际 ${actual}`);
  }
}

if (mismatches.length > 0) {
  console.error(`[doc-counts] 实际测试数 ${actual}，以下声明不一致：`);
  for (const line of mismatches) console.error("  - " + line);
  process.exit(1);
}
console.log(`[doc-counts] ${checked} 处声明与真实测试数一致：${actual} 项`);
