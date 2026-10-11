#!/usr/bin/env node
/**
 * 本地开发环守卫：profile 里声明的 `file:` 依赖必须真实存在，而且**装到的版本必须与
 * 那个 tarball 里的版本一致**。
 *
 * 为什么需要它：开发环里最常失效的不是代码，而是"配置指向一个已经不存在的 tarball"。
 * 症状有两种，都很贵：本地 `install` 直接失败；或者更隐蔽的一种——配置文件指向新包，
 * 而 node_modules 里躺着的还是旧产物，于是"改了没生效"被误判成代码问题。这类漂移发生
 * 在包的外面，所以包内的 175 项测试一条都覆盖不到它。
 *
 * 用法：node tools/check-local-install.mjs [profileDir]
 *   profileDir 缺省取 $DSH_PROFILE_DIR，再缺省取 ~/.dsh/profiles/$DSH_PROFILE（默认 desktop）。
 *
 * 找不到 profile（例如 CI）时打印一行说明并以 0 退出：它是本地守卫，不是通用测试，
 * 在没有 DSH 的机器上失败只会变成噪音。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const profileDir =
  process.argv[2] ??
  process.env.DSH_PROFILE_DIR ??
  join(homedir(), ".dsh", "profiles", process.env.DSH_PROFILE ?? "desktop");

const manifest = join(profileDir, "package.json");
if (!existsSync(manifest)) {
  console.log(`[install] 跳过：找不到 profile（${profileDir}）——这是本地守卫，没有 DSH 的机器上不适用`);
  process.exit(0);
}

/**
 * 读 tarball 里的 package.json 版本。
 * 不引入 tar 解析依赖（本仓库零运行时依赖），直接用系统 tar 读单文件。
 * @param {string} file tarball 路径。
 * @returns {string | null} 版本号，读取失败返回 null。
 */
function tarballVersion(file) {
  try {
    const raw = execFileSync("tar", ["-xzOf", file, "package/package.json"], { encoding: "utf8" });
    const version = JSON.parse(raw).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

const pkg = JSON.parse(readFileSync(manifest, "utf8"));
const dependencies = pkg.dependencies ?? {};
const problems = [];
let checked = 0;

for (const [name, spec] of Object.entries(dependencies)) {
  if (typeof spec !== "string" || !spec.startsWith("file:")) continue;
  checked += 1;
  const declared = spec.slice("file:".length);
  const target = isAbsolute(declared) ? declared : resolve(profileDir, declared);

  if (!existsSync(target)) {
    problems.push(`${name}: 声明的 ${spec} 不存在（${target}）——重新 install 会直接失败，或者更糟：装着的仍是旧产物`);
    continue;
  }

  const wanted = tarballVersion(target);
  const installedManifest = join(profileDir, "node_modules", name, "package.json");
  if (!existsSync(installedManifest)) {
    problems.push(`${name}: 已声明 ${spec}，但 node_modules 里没有装（跑一次 install）`);
    continue;
  }
  const installed = JSON.parse(readFileSync(installedManifest, "utf8")).version;

  if (wanted === null) {
    problems.push(`${name}: 读不出 ${target} 里的版本，tarball 可能是坏的`);
    continue;
  }
  if (installed !== wanted) {
    problems.push(
      `${name}: 装着 ${installed}，而 ${spec} 里是 ${wanted}——产物的版本对不上，跑一次 install`,
    );
  }
}

if (problems.length > 0) {
  console.error(`[install] ${problems.length} 项本地依赖漂移：`);
  for (const line of problems) console.error("  - " + line);
  process.exit(1);
}
console.log(`[install] ${checked} 个 file: 依赖与已装产物一致`);
