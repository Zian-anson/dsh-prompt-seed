#!/usr/bin/env node
/**
 * 把 src/ 编译成可发布的 bundle 产物 lib/。
 *
 * 两类产物形态不同：
 *   - Host 半区是普通 ESM，直接复制（lib/ 内部保持相对 import，Node 原生解析）。
 *   - 浏览器半区必须包成 DSH 客户端的模块格式
 *     `window.__ModuleLoader__.load({ id, factory })`：factory 只注册不执行，
 *     真正的副作用在 materialize（首次 import/require）时才发生。
 *
 * 用法：node tools/build.mjs
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

/** Host 半区逐文件复制：文件名映射到 lib/ 下的目标名。 */
const HOST_COPIES = [
  ["src/prompt-templates.js", "lib/prompt-templates.js"],
  ["src/host-core.js", "lib/host-core.js"],
  ["src/message-text.js", "lib/message-text.js"],
  ["src/session-context.js", "lib/session-context.js"],
  ["src/sample-log.js", "lib/sample-log.js"],
  ["src/signal-inference.js", "lib/signal-inference.js"],
  ["src/host-plugin.js", "lib/index.js"],
];

/**
 * 缩进每一行。
 * @param {string} text 源文本。
 * @param {number} spaces 缩进空格数。
 * @returns {string} 缩进后的文本。
 */
function indent(text, spaces) {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.trim() === "" ? line : pad + line))
    .join("\n");
}

/**
 * 把浏览器半区的工厂函数体包成 `__ModuleLoader__` 模块。
 *
 * `require` 的解析顺序是「seed word → shell 实例」，`react` 属于 shell 提供的
 * seed word，因此不需要在 dsh.client.external 里声明。
 * @param {string} id 包名（必须与 package.json 的 name 一致）。
 * @param {string} body 工厂函数体。
 * @returns {string} 可直接被浏览器加载的模块源码。
 */
function wrapClientBundle(id, body) {
  return `/* ${id} — browser half. 由 tools/build.mjs 生成，请勿手改。 */
window.__ModuleLoader__.load({
	id: ${JSON.stringify(id)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** Shell-provided seed module; see the client module loader resolution order. */
		var React = require("react");

${indent(body.trim(), 2)}

		exports.name = "prompt-seed";
		exports.inject = ["slots"];
		exports.apply = apply;
		return module.exports;
	}
});
//# sourceURL=${id}/lib/client.js
`;
}

async function main() {
  await rm(join(root, "lib"), { recursive: true, force: true });
  await mkdir(join(root, "lib"), { recursive: true });

  for (const [from, to] of HOST_COPIES) {
    const source = await readFile(join(root, from), "utf8");
    await writeFile(join(root, to), source, "utf8");
  }

  const clientBody = await readFile(join(root, "src/client-plugin.js"), "utf8");
  const clientBundle = wrapClientBundle(pkg.name, clientBody);
  await writeFile(join(root, "lib/client.js"), clientBundle, "utf8");

  process.stdout.write(
    `built lib/index.js, lib/host-core.js, lib/prompt-templates.js, lib/client.js (${clientBundle.length} bytes) for ${pkg.name}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
