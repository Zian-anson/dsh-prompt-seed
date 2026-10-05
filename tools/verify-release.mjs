#!/usr/bin/env node
/**
 * 发布物验证：把"发布包 = 仓库"这条承诺变成可执行命令。
 *
 * 用法：node tools/verify-release.mjs v0.9.3 [--install]
 *
 *   --install  额外把发布 URL 装进一个一次性 DSH profile（README 首推路径的实测：
 *              用户到底能不能装上、装到的版本是不是它），装完立即清理。
 *
 * 为什么值得一个脚本：发布包是用户真正拿到的东西，而它由一次性的手工流程产出——
 * 打包时忘了跑构建、src 改了但 lib 没重新生成、tag 打在了错误的提交上，都会让
 * "仓库里是好的、装到用户那儿是坏的"。这些都不会被单元测试发现，因为它们测的是
 * 源码，不是产物。逐字节比对是唯一能证明两者一致的办法。
 *
 * 退出码：0 = 一致；1 = 有任何不一致（含下载失败）。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tag = process.argv[2];
const alsoInstall = process.argv.includes("--install");
if (!tag || tag.startsWith("--")) {
  console.error("用法：node tools/verify-release.mjs <tag>（例如 v0.9.3）");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const repo = (() => {
  const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url ?? "";
  const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!match) {
    console.error("[release] package.json 里找不到 GitHub 仓库地址，无法定位发布资产");
    process.exit(1);
  }
  return match[1] + "/" + match[2];
})();

const version = tag.replace(/^v/, "");
if (version !== pkg.version) {
  console.error(`[release] tag ${tag} 与 package.json 版本 ${pkg.version} 不一致——先对齐再验证`);
  process.exit(1);
}

const assetName = `${pkg.name}-${version}.tgz`;
const url = `https://github.com/${repo}/releases/download/${tag}/${assetName}`;
const work = mkdtempSync(join(tmpdir(), "po-release-"));
const failures = [];
const note = (line) => console.log(line);

try {
  note(`[release] 下载 ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    console.error(`[release] 下载失败：HTTP ${response.status}（发布资产不存在或未公开？）`);
    process.exit(1);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const archive = join(work, assetName);
  writeFileSync(archive, bytes);
  note(`[release] 资产 ${assetName} 共 ${(bytes.length / 1024).toFixed(1)} KB`);

  execFileSync("tar", ["-xzf", archive, "-C", work], { stdio: "inherit" });
  const shipped = join(work, "package");

  // 1) 版本必须与 tag 一致
  const shippedPkg = JSON.parse(readFileSync(join(shipped, "package.json"), "utf8"));
  if (shippedPkg.version !== version) failures.push(`包内版本 ${shippedPkg.version} ≠ tag ${version}`);

  // 2) 必带文件（漏任何一个，用户侧要么装不上、要么看不到许可与说明）
  for (const required of ["LICENSE", "README.md", "CHANGELOG.md", "cordis.patch.yml", "package.json"]) {
    try {
      statSync(join(shipped, required));
    } catch {
      failures.push(`缺少必需文件 ${required}`);
    }
  }
  for (const entry of [shippedPkg.main, shippedPkg.exports?.["./client"], shippedPkg.dsh?.bundle?.patch]) {
    if (typeof entry !== "string") continue;
    try {
      statSync(join(shipped, entry));
    } catch {
      failures.push(`清单声明的入口 ${entry} 不在包里`);
    }
  }

  // 3) lib/ 必须与本地构建产物逐字节一致（这是本脚本存在的理由）
  const localLib = join(root, "lib");
  const shippedLib = join(shipped, "lib");
  const walk = (dir, prefix = "") => {
    const out = [];
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = prefix === "" ? name : prefix + "/" + name;
      if (statSync(full).isDirectory()) out.push(...walk(full, rel));
      else out.push(rel);
    }
    return out;
  };
  const localFiles = walk(localLib);
  const shippedFiles = walk(shippedLib);
  if (localFiles.join("|") !== shippedFiles.join("|")) {
    failures.push(`lib/ 文件清单不同：\n  本地 ${localFiles.join(", ")}\n  发布 ${shippedFiles.join(", ")}`);
  }
  for (const rel of localFiles) {
    const a = readFileSync(join(localLib, rel));
    let b = null;
    try {
      b = readFileSync(join(shippedLib, rel));
    } catch {
      continue;
    }
    if (!a.equals(b)) failures.push(`lib/${rel} 与本地构建产物不一致（发布包可能是过期构建）`);
  }
  note(`[release] 已比对 ${localFiles.length} 个 lib 产物`);
  // 4) 可选：真的装一次。README 首推的就是这条 URL，用户走的路必须实测——
  //    资产能下载 ≠ 能安装（清单、入口、patch 任何一处不对都会在装载时炸）。
  if (alsoInstall) {
    // 两条路径都要试，而且必须说清哪条成了。URL 直装是 README 首推，但已知在部分 pnpm
    // 版本上会撞 ERR_PNPM_MISSING_TARBALL_INTEGRITY（它为 https tarball 写 lockfile 时
    // 不写 integrity，随后又拒绝自己的条目）；本地文件路径不受影响，README 已给出该退路。
    // 只报"某条成功"而不说哪条，等于把用户的真实体验藏起来。
    const attempt = (label, spec) => {
      const profile = "verify-release-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
      const started = Date.now();
      try {
        execFileSync("dsh", ["plugin", "--profile", profile, "add", spec], { encoding: "utf8", stdio: "pipe" });
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        const installed = join(homedir(), ".dsh", "profiles", profile, "node_modules", pkg.name, "package.json");
        const installedVersion = JSON.parse(readFileSync(installed, "utf8")).version;
        if (installedVersion !== version) {
          failures.push(`${label}：安装后的版本是 ${installedVersion}，期望 ${version}`);
          return false;
        }
        note(`[release] 实装通过（${label}）：${seconds}s，版本 ${installedVersion}`);
        return true;
      } catch (error) {
        // pnpm 的诊断行可能落在 stdout，也可能落在 stderr——两路都看，别只看一路
        const raw = [error.stdout, error.stderr, error.message].filter(Boolean).map(String).join("\n");
        const known = raw.includes("ERR_PNPM_MISSING_TARBALL_INTEGRITY");
        // 优先取真正的错误行（pnpm 会把诊断行的前缀写成 ERR_*），否则退回首个非空行
        const diagnostic = raw.split("\n").map((line) => line.trim()).find((line) => line.includes("ERR_")) ?? raw.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
        note(`[release] 实装未通过（${label}）：${known ? "已知 pnpm https-tarball 完整性缺陷（ERR_PNPM_MISSING_TARBALL_INTEGRITY）" : diagnostic.slice(0, 160)}`);
        return false;
      } finally {
        rmSync(join(homedir(), ".dsh", "profiles", profile), { recursive: true, force: true });
      }
    };

    // 本地文件路径：先用刚下载并已验证过的资产（与远端字节相同）做一次确定性实装。
    const localTarball = join(work, assetName);
    const localOk = attempt("本地 tarball", localTarball);
    if (!localOk) failures.push("实装失败：本地 tarball 路径都不通，说明包本身有问题（清单/入口），不是 pnpm 的问题");

    // URL 直装：记录结果但不因此判失败——README 已把它标注为"可能撞上游 pnpm 缺陷"。
    const urlOk = attempt("README 的 URL 直装", url);
    if (!urlOk && localOk) {
      note("[release] 注意：URL 直装在这台机器上不可用（README 的故障排查条目已覆盖此退路）");
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`[release] ${failures.length} 项不一致：`);
  for (const line of failures) console.error("  - " + line);
  process.exit(1);
}
console.log(`[release] ${tag} 与仓库一致：版本、清单、lib/ 产物全部通过`);
