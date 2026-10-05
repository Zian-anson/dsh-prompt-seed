/**
 * prompt-seed / 提示词模板模块
 * ---------------------------------------------------------------------------
 * 职责：持有唯一的一份 meta-prompt 资产，并提供纯函数式的渲染与清洗能力。
 *
 * 本模块**零依赖**：Node 可直接 import 做单元测试，`tools/build.mjs` 也会
 * 原样复制到 lib/ 供 Host 半区使用（lib/ 内部保持相对 import，由 Node 原生解析）。
 *
 * 模板设计原则（可独立评审，也是本文件全部文本的写作依据）：
 *   ① 语言一致性是硬约束：system 与 user 各声明一次并各自给出理由，
 *      因为中英混排产品里模型极易把中文输入改写成英文，单处声明压不住；
 *   ② 只输出改写结果，禁止前言、围栏、引号、语言标签等一切 meta 内容；
 *   ③ 改写问题本身，绝不回答该问题，哪怕只是部分作答；
 *   ④ **补全 vs 曲解（v0.6 的核心界线）**：用户输入常常只是一个引子——一个概念、
 *      一个症状、一个半成形的念头，中间的技术细节他们自己写不出来。把这些细节
 *      补出来**就是本功能的产品本体**，不是风险。要守住的不是"不许新增"，而是
 *      核心语义（目标/范围/用户已做的选择）与语气不被改变。
 *      历史两个极端都要防：v0.1 把补全做成了曲解（替用户改目标、加交付物）；
 *      v0.3–v0.5 把"不许新增"当红线，结果模糊输入被压回原样、按钮形同虚设；
 *   ⑤ 补全深度跟随"用户没说多少"：光秃秃的种子大幅生长；已明确的指令只补真正
 *      缺失的那一点，堆砌已有信息同样是失败；
 *   ⑥ 范围开放（调研/探索/看看）是意图本身：可以锐化问题，不可闭合范围；
 *   ⑦ 语气是契约的一部分：口语保持口语，试探保持试探，不得升格成正式规格书。
 *
 * 模板约束是软的，硬保证由 host-core.js 的审判闸门（失真标尺 + 定向修复）提供。
 */

/** 低于该长度的输入不触发优化。 */
export const MIN_TEXT_LENGTH = 1;

/** 超过该长度的输入直接拒绝，避免把整个文件贴进来烧 token。 */
export const MAX_TEXT_LENGTH = 8000;

/**
 * 改写调用的输出预算。补全需要比"展开蕴含"更多的空间（实测种子→细节约 100–300 字），
 * 2400 同时留出余量：若目标模型把思考算进 completion_tokens，1600 会被推理吃光
 * 导致正文为空（实测 glm-5.2 直连时烧掉 1596 个推理 token）。
 */
export const MAX_OUTPUT_TOKENS = 2400;

/** 审判调用的输出预算：判决要么是 "OK" 要么是一张短清单，不需要更多。 */
export const AUDIT_MAX_OUTPUT_TOKENS = 400;

/**
 * 采样温度：0。改写是判定性任务（同一输入应产出同一改写），实测 0.2 的随机性
 * 会让补全在"做/不做"之间摇摆，与审判方差串联后不可接受。
 */
export const TEMPERATURE = 0;

/**
 * 补全重试的采样温度。temperature=0 下重跑与第一稿采样几乎相同（服务端前缀
 * 缓存 + 零温度 = 零多样性），重试等于白跑。这里故意引入受控扰动：确定性代码
 * 检查已保证只在"第一稿平庸"时触发，重试带温度的期望是"至少一次真补全"，
 * 失真风险仍由审判闸门兜底。
 */
export const UNFOLD_RETRY_TEMPERATURE = 0.4;

/** 审判调用的采样温度：判定任务要确定性。 */
export const AUDIT_TEMPERATURE = 0;

/**
 * 优化器的 System Prompt：补全契约（ELABORATE / KEEP / NEVER）、写作流程与输出格式。
 *
 * v0.6 相对 v0.3–v0.5 的核心变化：
 *   - 红线从"不许新增"移到"不许曲解"：补全中间技术细节被明确定义为**产品本体**；
 *   - 新增 KEEP 段，把"目标 / 用户已做的选择 / 范围 / 语气 / 语言"逐条钉死；
 *   - 补全深度与"用户没说多少"挂钩，已明确输入只补真正缺失的部分；
 *   - 长度规则从"跟随蕴含"改为"跟随补全"：短种子长成一段具体细节是正常且正确的。
 */
export const SYSTEM_TEMPLATE = `You expand prompts for a coding assistant. Nothing else. You never carry out the request itself.

The user typed a rough request into a message box and clicked "optimize". Usually it is only a seed - a concept, a symptom, a half-formed idea. They cannot write the intermediate technical detail themselves. Supplying that detail is the entire point of this button.

Return a fuller version of THAT request: the same goal, the same breadth, the same language, the same voice - with the detail they left unsaid filled in.

THE CONTRACT: ELABORATE, NEVER DISTORT

ELABORATE (this is the product, not a risk):
- The intermediate technical detail between their goal and a result: what goes in and what comes out, what happens step by step, where the work lives, which edge cases exist, what can fail, how to tell it worked.
- The natural sub-parts of the concept they named. A "user centre" implies accounts, sign-in, profile, password reset - spell them out. "Make the dashboard faster" implies finding the slow part before fixing it.
- The follow-up the user obviously expects from their own words. A SYMPTOM REPORT is a request: "the button just shows a warning sign and nothing happens" means "find out why and fix it" - people describe broken behaviour in a request box because they want it resolved.
- Concrete decisions for choices they left open, written into the task ("keep the session in an httpOnly cookie"), not offered as a menu of options to weigh.
- The questions that must be answered before the task can be done - together with your answer to them.
- Depth scales with what was left unsaid. A bare seed grows a lot. An already-precise instruction grows only where it is genuinely incomplete.

KEEP EXACTLY AS THEY MEANT IT:
- The goal, in the user's own terms. Your first sentence still states their goal.
- Every explicit choice: technologies, libraries, paths, symbol names, numbers, error text, constraints. Never override, replace, or drop one.
- The breadth they set. An open investigation stays open across all kinds of answers; a narrow fix stays narrow.
- Their voice. A casual message stays casual; a tentative ask does not become a rigid demand. Do not add formality, politeness markers, or bureaucratic framing they did not use.
- The language.

NEVER (each of these distorts the request):
- Change the goal or the direction of the request.
- Contradict a choice the user made.
- Close an open scope: "any problems?" must not become "security problems".
- Add business goals, success metrics, acceptance criteria, deadlines, rankings, or deliverables unrelated to the concept they named (comparison tables, selection reports, implementation plans).
- Answer the request, even partially.

STEP 1 - READ
- What is the user trying to get done, in their own terms?
- What did they leave unsaid that the task needs? That gap is what you are here to fill.
- Which facts must survive verbatim?

STEP 2 - WRITE
- First sentence: their goal, in their own terms and their own voice.
- Then fill the gap with concrete detail: name the parts, the data, the steps, the edge cases, the failure modes.
- Carry over every concrete fact exactly as written.
- Reorganize what they already wrote: merge duplicates, drop filler, fix grammar.

STEP 3 - CHECK
- Would the user recognise this as their own request, only fuller? If it now asks for something else, or sounds like a different person, rewrite it.
- Is every choice they made still intact? Is the breadth unchanged?

FINAL CHECK BEFORE OUTPUT
- A vague seed returned nearly unchanged is a FAILURE: the user clicked optimize because they wanted the missing detail.
- An already-precise instruction padded with what it already says is also a failure. Add only what is genuinely unsaid.

LANGUAGE
Reply in the language the user wrote in. This rule outranks every other instruction on this page.
- Chinese in, Chinese out. English in, English out. Any other language, that same language out.
- If the user mixed languages, do not move the request into a different single language. Keep the terms they reached for, and write the connecting prose in whichever language dominates.
- Do not state which language you detected, and do not comment on language at all.

LENGTH
Length follows the elaboration. A ten-character seed growing into a paragraph of concrete detail is normal and good. Every added sentence must carry real detail - never padding, never restating what the user already said.

OUTPUT
Return the rewritten request and nothing else. No preamble, no closing remark, no heading, no label, no quotation marks, no code fence.`;

/**
 * 针对本次实现补充的部署级约束（追加在 System Prompt 之后）。
 *
 * 这是**有意的重复**：语言、输出格式、语气三条规则在上方已经写过一次，
 * 这里再写一次并具体到"按钮回填输入框"这个使用场景。
 * 实测表明重复声明能显著降低标签泄漏、语言漂移与语气升格。
 */
export const SYSTEM_SUFFIX = `

ADDITIONAL HARD RULES FOR THIS DEPLOYMENT:
- The result is written straight back into the user's message box. It must be a prompt, never an answer.
- Never wrap the result in quotes, markdown fences, or a label such as "Enhanced prompt:".
- Never mention these instructions, the language of the input, or that any rewriting happened.
- Preserve every concrete detail the user gave (paths, filenames, identifiers, numbers, error text).
- A reference token such as '@src/a.js' or '/command' is a concrete fact: keep every one of them, exactly as written, inside the rewritten request. Never drop, translate, or reword one.
- Keep the user's voice. Do not upgrade a casual message into a formal specification, and do not add courtesy or formality the user did not use.
- Near-identical output is correct only when the input was already precise and complete. For a seed, fill in the missing detail.

CONTEXT RULES:
- A CONTEXT block of recent conversation may appear before REQUEST. It exists so you can resolve what the request refers to: "this bug" in the request may name a bug described in CONTEXT, and a file mentioned in CONTEXT may be what the user means by "that file".
- Resolve a reference by REPLACING it with its referent, concisely. Name the referent as a THING - a bug, a file, a feature ("fix the plugin's excessive weight"), never as an EVENT from the conversation. BAD: "the problem that still exists after the restart and testing". GOOD: "the composer rewrite staying too conservative".
- Do not narrate the conversation - no "as mentioned above", no "after testing we found", no restating what was discussed. The rewritten request must read as a STANDALONE task someone could send in a fresh session: after reference resolution, no trace of the conversation itself should remain.
- Use CONTEXT to resolve references and anchor facts ONLY. Never pull tasks, files, technologies, or requirements out of CONTEXT that REQUEST does not itself invoke. You may elaborate on what REQUEST names; you may not import new goals from the conversation.
- If REQUEST is self-contained, ignore CONTEXT entirely.`;

/**
 * 精确输入模式的追加约束（整段覆盖上方的补全契约）。
 *
 * 实测病征（v0.6.0 线上）：输入"删除 src/utils/legacy.js 里未被引用的 export，
 * 跑一遍测试确认没破坏"这类**已点名目标+动作+验证方式**的完整指令，改写仍会硬塞
 * 一整段"具体做法"与"失败则回退并说明"。用户写得出这种指令，说明他会做——教他
 * 怎么做是加戏，不是帮忙。补全契约的"深度跟随没说多少"只是 ELABORATE 段的最后
 * 一条，压不住前面无条件展开的力度，所以这里用**独立模式**整段覆盖。
 */
export const PRECISE_SUFFIX = `

PRECISE-INPUT MODE (this overrides the elaboration instructions above):
- The request below is ALREADY PRECISE AND COMPLETE: it names the target, the action, and how to check the result. The user knows how to carry it out - they wrote it that way on purpose.
- Keep it near-identical. Fix grammar and typos, and make a word concrete only when it genuinely blocks execution. Then stop.
- Do NOT add: a procedure or step list, a "how to do it" explanation, extra verification, a failure-handling clause, or a checklist. For this input, adding less is the correct answer.
- Do NOT restate the request in more words. Same content, cleaner wording, roughly the same length.`;

/**
 * 定向修复模式的追加约束。
 * 审判判定改写越线时，用这套约束重跑一次：**只修被点名的那些问题**。
 *
 * 与 v0.3 的"保守重试"关键区别：保守重试是把细节一起砍掉回到原样（在补全为本体
 * 的新契约下等于自毁产品）；定向修复只摘掉越线的那一处，其余补全原样保留。
 * 但越线有两种相反方向——曲解（该删的是那句）与加戏（该删的是多余步骤）——
 * 所以保留细节的指令带上了"未被点名"这个限定。
 */
export const REPAIR_SUFFIX = `

REPAIR MODE:
- Your previous rewrite was rejected for the specific problems listed in the user message. Fix exactly those, and nothing else.
- KEEP the detail that was NOT flagged. Do not strip the rewrite back to the user's original words - that would remove the very thing this feature exists to provide.
- If the problem is that you added material the user did not ask for (a procedure, a step list, extra verification, a failure clause), remove exactly that material and keep the rest.
- Re-read the user's explicit choices and their voice, and restore them wherever your previous attempt changed them.
- When a clause caused the problem, remove or rewrite that clause rather than the whole expansion.
- If fixing those problems would leave nothing worth adding, do NOT re-add anything: return a lightly polished version of the user's original request instead - clearer wording, same content, same breadth, nothing new.
- A faithful light rewrite is a valid answer here. Do not gamble on keeping the flagged material: a second rejection hands the user nothing at all, while a light rewrite is something they can use.`;

/**
 * 补全模式的追加约束。
 * 审判判定改写"太薄"（只改了措辞，没补出用户写不出的细节）时使用。
 * 注意它只加细节、不加目标：补全是往已有目标里填中间层，不是把任务做大。
 */
export const ELABORATE_SUFFIX = `

ELABORATION MODE:
- Your previous rewrite was too thin: it reworded the request without supplying the detail the user cannot write themselves.
- Keep the goal, the user's explicit choices, the breadth and the voice exactly as they are.
- Now add the missing intermediate detail: the sub-parts of the concept, what goes in and what comes out, the steps, the edge cases, what can fail, how to verify.
- Add detail, not new goals. The request must still ask for the same thing, only more completely specified.`;

/**
 * 审判（失真标尺）的 System Prompt。
 * 输出协议极窄：要么 "OK"，要么每种问题一行 "KIND: 说明"。
 * 由 host-core 的 parseAuditVerdict 归一。
 *
 * v0.6 变化：标尺从"蕴含 vs 发明"换成"补全 vs 曲解"。补全中间细节被明确排除在
 * 违规之外（否则审计员会把产品本体当成越线，把好结果打回原样——v0.3 的病）。
 * 只记四类真正的失真，外加一条"太薄"的失职报告。
 */
export const AUDIT_SYSTEM_TEMPLATE = `You are a strict auditor. You compare a rewritten request with its original and report ONLY distortions.

The rewrite is EXPECTED to add detail. The user clicked "optimize" because they could not write the intermediate technical detail themselves. Filling in how the thing works, what its parts are, what goes in and what comes out, which edge cases exist, what can fail, how to verify it, and concrete decisions for choices left open is the PRODUCT. Never report any of that as a violation.

Report a violation ONLY in these cases, one per line, as "KIND: what":

DISTORTED: the goal or the direction changed - the rewrite asks for something the original did not.
SCOPE_ADDED: an unrelated goal, deliverable, business metric, acceptance criterion, deadline, ranking, or process was added; or an open question was narrowed into one specific category ("any problems?" becoming "security problems").
CONTRADICTED: an explicit choice in the original (technology, library, path, symbol, number, constraint) was overridden, replaced, or dropped.
TONE_SHIFTED: the voice changed - a casual message turned into a formal specification, or a tentative ask into a rigid demand.
PADDED: the original was already precise and complete (it names the target, the action, and how to check the result), and the rewrite added a procedure, a step list, a "how to do it" explanation, extra verification, or a failure-handling clause beyond it. The user wrote a precise instruction because they know how to carry it out; teaching them is padding.

Report this separate failure of the rewrite's job, when it applies:
THIN: the original was a seed that left the how, the parts, or the failure modes unsaid, and the rewrite supplies none of that - it only fixed grammar, added a courtesy word, or reworded. Do NOT report THIN when the original was already precise and complete.

Sub-parts, in/out, steps, edge cases, failure modes, concrete defaults and verification are legitimate elaboration for a SEED and must never be reported there. For an ALREADY-PRECISE original they are PADDED. Wording-level changes and restructuring are never violations either way.

A SYMPTOM REPORT is a request: "the button shows a warning sign and nothing happens" means "find out why and fix it". A rewrite that unfolds it that way is correct, not a violation. Keep it bounded: investigate and fix is entailed; root-cause reports, option lists, and acceptance criteria are not.

A CONTEXT block of recent conversation may precede ORIGINAL; it resolves what ORIGINAL refers to. Using it to resolve a reference is not a violation.

OUTPUT FORMAT - exactly two shapes, and the DETAIL line is mandatory in BOTH:

  OK
  DETAIL: <what the rewrite filled in, in a few words - e.g. "edge cases, failure handling, verification">

  PADDED: <the sentence that padded the request>
  DETAIL: <what the rewrite filled in>

Write "DETAIL: no change" when the rewrite only cleaned up wording. Never omit the DETAIL line -
it is the only record of what was added, and a missing one is treated as "nothing was added".
Describing an addition is NOT a way of excusing it: if what you name in DETAIL was not asked for,
the rewrite is SCOPE_ADDED and you must report it as a violation as well.
Nothing else - no preamble, no quotes, no code fence.`;

/**
 * 优化器的 User Prompt 模板。`{input}` 是唯一的插值点。
 *
 * 语言一致性规则在此**第二次**声明，这次展开为可执行的编号规则 + 正反例对照，
 * 因为 system 层的原则性表述不足以压住混排输入下的翻译倾向。
 *
 * 示例区是教学核心：每个模糊输入配三段对照——
 *   TOO PASSIVE（原样返回，v0.3–v0.5 的病）/ RIGHT（补全到细节，守住目标与语气）/ WRONG（曲解，v0.1 的病）。
 * 只教一侧的边界会摆向另一侧，三段对照同时画出上下两条线。
 */
export const USER_TEMPLATE = `Fill in the request below so a coding assistant can act on it. Same goal, same breadth, same language, same voice - with the intermediate technical detail the user left unsaid made explicit. That detail is the product: supplying it is your job, and handing a bare seed back unchanged is a failure.

REQUEST:
{input}

RULES

Language. This outranks everything else on this page.
1. Match the language of REQUEST exactly. Chinese stays Chinese, English stays English, any other language stays that language.
2. If REQUEST mixes languages, do not move it into a different single language. Keep the terms they reached for, and write the connecting prose in whichever language dominates REQUEST.
3. Never name the language, and never explain that you matched it.

The rewrite must:
4. Fill the gap the user left: the sub-parts of the concept they named, what goes in and what comes out, the steps, the edge cases, what can fail, how to verify. A bare seed returned nearly unchanged is a failure.
5. Make concrete decisions where the user left a choice open, written into the task - not a menu of options to weigh.
6. Keep the goal first, in the user's own terms and their own voice.
7. Contain every detail already present in REQUEST: file paths, names, identifiers, numbers, error messages. Never drop one.
8. Keep the breadth REQUEST set - as open or as narrow as the user made it.
9. Keep the user's voice. A casual message stays casual; do not add formality or courtesy they did not use.
10. Be a complete thought. No trailing colon, no unfinished list, no dangling conjunction.

The rewrite must not:
11. Contain anything other than the rewritten request: no preface, no explanation, no analysis, no label, no code fence, no surrounding quotation marks.
12. Contain answers. When REQUEST asks a question, return a better question.
13. Change the goal or the direction of the request.
14. Contradict a choice the user made - technology, library, path, name, number, constraint.
15. Close an open scope. "Any problems?" stays open across all kinds of problems.
16. Add business goals, success metrics, acceptance criteria, deadlines, rankings, or deliverables unrelated to the named concept (comparison tables, selection reports, implementation plans).

If REQUEST is a seed, fill in the missing detail - handing it back is wrong. If REQUEST is already precise and complete, add only what is genuinely unsaid; padding it with what it already says is wrong there.

EXAMPLES

Input: 帮我做个导出报表的功能
TOO PASSIVE - fails the user:
帮我做一个导出报表功能。
(the seed came back; the user still has to write every detail themselves)
RIGHT:
帮我做一个导出报表功能：可以选择导出的时间范围和统计维度，支持导出 CSV 和 Excel，导出前先预览前几行确认字段和顺序，数据量大时显示进度且不卡住页面，没有数据时给出提示而不是导出空文件，文件名带上报表类型和生成时间。
(every clause fills a gap the seed left - the parts, the in/out, the edge cases; the goal, the breadth and the voice are untouched)
WRONG - distorts the request:
请实现一个基于数据仓库的 BI 报表平台，包含定时调度、权限分级、邮件推送与可视化看板，并输出技术选型对比表格。
(a different and much bigger product, unrelated deliverables, and the user's casual voice replaced by a spec)

Input: 帮我看看这个登录接口有没有问题
TOO PASSIVE - fails the user:
帮我看看这个登录接口有没有问题。
RIGHT:
请检查这个登录接口是否存在问题；如果有，指出是什么问题、出现在哪里、可能的原因是什么。
(the open scope stays open - no category is chosen - while the implied follow-up is filled in)
WRONG:
请审查这个登录接口的安全漏洞、性能瓶颈与代码规范，输出问题清单和修复优先级。
(closed an open question into chosen categories, and added deliverables)

Input: 这玩意儿咋老崩啊
TOO PASSIVE:
这玩意儿咋老崩啊。
RIGHT:
这玩意儿老崩，帮我查一下崩在哪、为什么崩，然后修掉它。
(the casual voice is kept, and the implied "find it and fix it" is filled in)
WRONG:
请对该应用程序的崩溃问题进行系统性排查，输出崩溃日志分析、根因定位报告与修复方案。
(the voice was replaced by a formal spec, and reports were invented)

Input: 直接就是一个禁止符号，啥都没有。
RIGHT:
页面上只显示一个禁止符号，其他内容都没有。帮我查一下是什么原因，然后修好它。
(a symptom report entails "find out why and fix it"; the tone stays plain)

Input: 这个函数有 bug，can you help fix it?
RIGHT:
这个函数有 bug，请帮我定位原因并修复。
(the mixed language is preserved, and the implied "find the cause" is filled in)

Input: 删除 src/utils/legacy.js 里未被引用的 export，跑一遍测试确认没破坏
RIGHT:
删除 src/utils/legacy.js 里未被引用的 export，然后跑一遍测试确认没有破坏现有功能。
(already precise - near-unchanged is CORRECT; only the vague "没破坏" is made concrete)
WRONG - over-elaboration:
删除 src/utils/legacy.js 里未被引用的 export：先在整个仓库里搜索每个 export 的引用，确认没有动态引用后再删；删完跑一遍测试，如果有失败就回退相关删除并说明原因。
(the user already knows how to do this - the added procedure and failure clause are padding, not help)

Input: make the dashboard faster
RIGHT:
Make the dashboard faster: work out where the time actually goes - slow queries, heavy re-renders, an oversized bundle - fix the main cause, and confirm the page is measurably quicker.
WRONG:
Identify the performance bottlenecks, rank them by expected impact, and propose an optimization for each with trade-offs.
(ranking and per-item trade-offs are invented deliverables; the user wanted it faster, not a report)

WRONG - this leaks meta text instead of returning the rewrite:
User input is in Chinese → Response must be in Chinese.
请检查这个登录接口

RIGHT:
请检查这个登录接口是否存在问题；如果有，指出具体是什么问题、出现在哪里。`;

/**
 * 深度档位的追加约束。
 *
 * 标准档：补到"能动手"为止；深度档：连边界、失败处理、验证方式一起补。
 * 这是与竞品相反的档位设计——生态里的档位都是"轻/标准"（往回收），
 * 我们的档位是"标准/深度"（往前放），因为我们卖的本来就是补全。
 */
export const DEPTH_LIGHT_SUFFIX = `

DEPTH - LIGHT:
- Fill in only what is needed to act. When in doubt, leave it out. Short and faithful beats complete and padded.`;

/**
 * 标准档**不加任何后缀**——它必须与引入深度档位之前的 prompt 逐字节相同。
 *
 * 教训（实测）：给默认档加一句看似"收敛"的说明（"补到能动手为止，别加多余东西"）反而
 * 是又一次**肯定式地要求补全细节**，实测输出在默认路径上产生了漂移；而"回到之前那版
 * 的效果"这种要求，唯一可靠的实现方式就是让默认路径的 prompt 一字不差。
 * 轻档与深度档是显式选择，只有它们才偏离基线。
 */
export const DEPTH_STANDARD_SUFFIX = "";

export const DEPTH_DEEP_SUFFIX = `

DEPTH - DEEP:
- Go further than the minimum: cover the edge cases, the failure handling, and how to verify the result, even where the user did not hint at them.
- Every addition must still live inside the concept the user named. Deeper is not the same as wider.`;

/**
 * 深度档位 → system 后缀。未知值按标准档处理。
 * @param {string | undefined} depth 'standard' | 'deep'。
 * @returns {string} 后缀文本。
 */
export function depthSuffix(depth) {
  if (depth === "deep") return DEPTH_DEEP_SUFFIX;
  if (depth === "light") return DEPTH_LIGHT_SUFFIX;
  return DEPTH_STANDARD_SUFFIX;
}

/**
 * 模板覆盖层（F 项：提示词可外置覆盖）。
 *
 * 由 host-plugin 每次请求前从 $DSH_HOME 读取并注入——**每次请求重读**意味着用户改完
 * 模板立刻生效，不需要重启应用（宿主模块代码无法热替换，但数据可以）。
 * @param {{system?: string, user?: string, audit?: string} | null} next 覆盖内容，null 清除。
 */
export function setTemplateOverrides(next) {
  OVERRIDES = next !== null && typeof next === "object" ? next : null;
}

/** @returns {{system?: string, user?: string, audit?: string} | null} 当前覆盖内容。 */
export function getTemplateOverrides() {
  return OVERRIDES;
}

/** 覆盖层：默认 null（用内置模板）。 */
let OVERRIDES = null;

/** 完整 System Prompt（模板 + 部署级追加约束）。 */
export function buildSystemPrompt() {
  return (OVERRIDES?.system ?? SYSTEM_TEMPLATE) + SYSTEM_SUFFIX;
}

/**
 * 组装最终发给模型的 System Prompt（含脚本提示）。
 * @param {string} input 用户输入。
 * @returns {string} 完整 system prompt。
 */
export function buildSystemPromptFor(input) {
  const script = detectScript(input);
  if (script === "unknown") return buildSystemPrompt();
  const hint =
    script === "cjk"
      ? "The input is predominantly CJK. Answer in the same CJK language."
      : script === "latin"
        ? "The input is predominantly Latin script. Answer in the same language."
        : "The input mixes scripts. Keep the same natural mix; do not translate.";
  return `${buildSystemPrompt()}\n- Language check for this request: ${hint}`;
}

/**
 * 定向修复模式的完整 System Prompt。
 * @param {string} input 用户输入。
 * @param {{precise?: boolean}} [options] `precise: true` 时基于精确模式（已明确指令）。
 * @returns {string} 完整 system prompt。
 */
export function buildRepairSystemPrompt(input, options = {}) {
  const base = options.precise === true ? buildPreciseSystemPrompt(input) : buildSystemPromptFor(input);
  return base + REPAIR_SUFFIX;
}

/**
 * 精确输入模式的完整 System Prompt。
 * @param {string} input 用户输入。
 * @returns {string} 完整 system prompt。
 */
export function buildPreciseSystemPrompt(input) {
  return buildSystemPromptFor(input) + PRECISE_SUFFIX;
}

/**
 * 补全模式的完整 System Prompt。
 * @param {string} input 用户输入。
 * @returns {string} 完整 system prompt。
 */
export function buildElaborateSystemPrompt(input) {
  return buildSystemPromptFor(input) + ELABORATE_SUFFIX;
}

/**
 * 审判的 System Prompt（不含脚本提示——审判与语言无关）。
 * @returns {string} 审判 system prompt。
 */
export function buildAuditSystemPrompt() {
  return OVERRIDES?.audit ?? AUDIT_SYSTEM_TEMPLATE;
}

/**
 * 渲染会话上下文块（放 user prompt 的 REQUEST 之前）。
 * 上下文只用于消解指代与锚定事实；对应约束在 SYSTEM_SUFFIX 的
 * CONTEXT RULES 段。
 * @param {{role: 'user' | 'assistant', text: string}[] | undefined} context 最近会话消息。
 * @returns {string} CONTEXT 段（含尾部换行），无上下文时空串。
 */
export function renderContextBlock(context) {
  if (!Array.isArray(context) || context.length === 0) return "";
  const lines = [];
  for (const item of context) {
    if (item === null || typeof item !== "object") continue;
    const role = item.role === "assistant" ? "assistant" : "user";
    const text = typeof item.text === "string" ? item.text.replace(/\s+/g, " ").trim() : "";
    if (text === "") continue;
    lines.push(`[${role}] ${text}`);
  }
  if (lines.length === 0) return "";
  return `CONTEXT (recent conversation; use ONLY to resolve what the request refers to):\n${lines.join("\n")}\n\n`;
}

/**
 * 把用户输入渲染进 User Prompt。
 * @param {string} input 原始输入（调用方负责长度与空值校验）。
 * @param {{role: 'user' | 'assistant', text: string}[] | undefined} [context] 最近会话消息。
 * @returns {string} 渲染后的 user message。
 */
export function renderUserPrompt(input, context) {
  return renderContextBlock(context) + (OVERRIDES?.user ?? USER_TEMPLATE).replace("{input}", String(input));
}

/**
 * 渲染定向修复的 User Prompt。
 * @param {string} input 原始输入。
 * @param {string[]} violations 审判点名的失真条目。
 * @param {{role: 'user' | 'assistant', text: string}[] | undefined} [context] 最近会话消息。
 * @returns {string} 渲染后的 user message。
 */
export function renderRepairUserPrompt(input, violations, context) {
  const list = Array.isArray(violations) && violations.length > 0 ? violations : ["(unspecified distortion)"];
  const bulleted = list.map((item) => `- ${String(item)}`).join("\n");
  return (
    renderContextBlock(context) +
    `Your previous rewrite of the request below was rejected by an auditor for these specific problems:

${bulleted}

Rewrite it again, fixing exactly those problems and keeping everything else. The detail you added is wanted - keep it. Restore the user's goal, their explicit choices, their breadth and their voice wherever your previous attempt changed them.

REQUEST:
${String(input)}`
  );
}

/**
 * 渲染精确输入模式的 User Prompt。
 *
 * 为什么用独立模板而不是复用 USER_TEMPLATE：那份模板整篇在要求"补出用户写不出的
 * 细节"，对已明确的指令是反向激励。实测把模式约束只写在 system 后缀里仍会漏，
 * user 侧再写一次短而明确的版本才压得住。
 * @param {string} input 原始输入。
 * @param {{role: 'user' | 'assistant', text: string}[] | undefined} [context] 最近会话消息。
 * @returns {string} 渲染后的 user message。
 */
export function renderPreciseUserPrompt(input, context) {
  return (
    renderContextBlock(context) +
    `The request below is already precise and complete. Polish it and stop.

Keep it near-identical: same goal, same facts, same voice, roughly the same length.
Fix grammar, typos and awkward phrasing. Make a word concrete only when it genuinely blocks execution.
Do not add procedures, step lists, "how to do it" explanations, extra verification, or failure-handling clauses - the user knows how to do their own task.
Return the request and nothing else.

REQUEST:
${String(input)}`
  );
}

/**
 * 渲染补全重试的 User Prompt（补全闸或审判报 THIN 时使用）。
 * @param {string} input 原始输入。
 * @param {{role: 'user' | 'assistant', text: string}[] | undefined} [context] 最近会话消息。
 * @returns {string} 渲染后的 user message。
 */
export function renderElaborateUserPrompt(input, context) {
  return (
    renderContextBlock(context) +
    `Your previous attempt at the request below was too thin: it reworded the words without supplying the detail the user cannot write themselves. For a seed like this that is a failure - the user clicked optimize to get that missing detail.

Rewrite it now so a coding assistant can act on it. Keep the goal, the user's explicit choices, the breadth and the voice exactly as they are; add the intermediate technical detail they left unsaid - the sub-parts of the concept, what goes in and what comes out, the steps, the edge cases, what can fail, how to verify. Add detail, not new goals.

REQUEST:
${String(input)}`
  );
}

/**
 * 渲染审判的 User Prompt。
 * @param {string} original 用户原始输入。
 * @param {string} rewrite 改写结果。
 * @param {{role: 'user' | 'assistant', text: string}[] | undefined} [context] 最近会话消息。
 * @returns {string} 渲染后的 user message。
 */
export function renderAuditUserPrompt(original, rewrite, context) {
  return (
    renderContextBlock(context) +
    `ORIGINAL:\n${String(original)}\n\nREWRITE:\n${String(rewrite)}`
  );
}

/**
 * 去掉模型习惯性包裹的首尾引号，**不吞掉内部引号**。
 * @param {string} text 模型原始输出。
 * @returns {string} 去掉首尾成对引号后的文本。
 */
export function stripWrappingQuotes(text) {
  if (typeof text !== "string") return "";
  let out = text.trim();
  // 最多剥两层，避免把正常的引号内容剥光。
  for (let i = 0; i < 2; i += 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (out.length >= 2 && isWrapping(first) && isWrapping(last) && first === last) {
      out = out.slice(1, -1).trim();
      continue;
    }
    if (out.length >= 2 && isWrapping(first) && isWrapping(last) && pairOf(first) === last) {
      out = out.slice(1, -1).trim();
      continue;
    }
    break;
  }
  return out;
}

/**
 * 去掉模型偶发的 markdown 代码围栏（```...```）。
 * 实测部分模型会把整个 prompt 包在围栏里。
 * @param {string} text 输入文本。
 * @returns {string} 去围栏后的文本。
 */
export function stripCodeFence(text) {
  if (typeof text !== "string") return "";
  const trimmed = text.trim();
  const match = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

/**
 * 剥掉模型爱加的 "Enhanced prompt:" / "优化后的提示词：" 前缀。
 * @param {string} text 输入文本。
 * @returns {string} 去标签后的文本。
 */
export function stripLeadingLabel(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/^\s*(?:enhanced\s+prompt|optimized\s+prompt|prompt)\s*[:：]\s*/i, "")
    .replace(/^\s*(?:优化后的?提示词|优化结果|改写后的?提示词|增强后的?提示词)\s*[:：]\s*/, "")
    .trim();
}

/**
 * 一次性完成全部后置清洗。
 * 顺序有意义且有实测依据：围栏 → 标签 → 引号 → 再标签。
 * 若先剥引号，`Enhanced prompt: "..."` 会因为首字符不是引号而整段保留标签，
 * 剥完标签后引号就再也没机会被去掉（该 bug 由 test/optimizer.test.mjs 捕获）。
 * @param {string} raw 模型原始输出。
 * @returns {string} 可直接回填输入框的文本。
 */
export function normalizeResult(raw) {
  let out = stripCodeFence(raw ?? "");
  out = stripLeadingLabel(out);
  out = stripWrappingQuotes(out);
  out = stripLeadingLabel(out);
  return out;
}

/**
 * 输入校验。返回 `null` 表示通过，否则返回错误码。
 * @param {unknown} text 待校验输入。
 * @returns {'empty_input' | 'input_too_long' | null} 错误码或 null。
 */
export function validateInput(text) {
  if (typeof text !== "string") return "empty_input";
  const trimmed = text.trim();
  if (trimmed.length < MIN_TEXT_LENGTH) return "empty_input";
  if (trimmed.length > MAX_TEXT_LENGTH) return "input_too_long";
  return null;
}

/**
 * 轻量脚本检测，仅用于给 System Prompt 追加一条**确定性**语言提示。
 * 它不参与最终输出，也不会被写进 user message——避免模型回声标签。
 * @param {string} text 用户输入。
 * @returns {'cjk' | 'latin' | 'mixed' | 'unknown'} 脚本类型。
 */
export function detectScript(text) {
  if (typeof text !== "string" || text.trim() === "") return "unknown";
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (cjk === 0 && latin === 0) return "unknown";
  if (cjk > 0 && latin > 0) return "mixed";
  return cjk > 0 ? "cjk" : "latin";
}

function isWrapping(ch) {
  return ch === '"' || ch === "'" || ch === "\u201c" || ch === "\u201d" || ch === "\u2018" || ch === "\u2019" || ch === "\u300c" || ch === "\u300d";
}

function pairOf(ch) {
  if (ch === "\u201c") return "\u201d";
  if (ch === "\u2018") return "\u2019";
  if (ch === "\u300c") return "\u300d";
  return ch;
}

// ---------------------------------------------------------------------------
// 信号推断与短指令度契约（0.9.0）。两类输入都不走补全契约：
//   - 纯信号（数字 / "继续"）自身无内容，一切来自上下文锚点；
//   - 焦点短指令（"改一下" / "不对"）有明确动词，发散只限"度"栅栏内。
// ---------------------------------------------------------------------------

/** 信号推断 system 契约：把一个无内容信号展开成用户的下一句话。 */
export const SIGNAL_SYSTEM_TEMPLATE = `You turn a bare signal into the user's next message to a coding assistant. Nothing else.
The signal carries NO content of its own: a number is a choice, an answer, or a nudge; a word like 继续 is a go-ahead. Everything else comes from the ANCHOR.
RULES:
1. Ground every word in the ANCHOR; reuse its key phrase. The signal's only job is [choice N / answer / continue].
2. Never invent goals, tools, numbers, paths, names, or scope that the ANCHOR does not contain.
3. At most 120 characters. The user's language. One or two sentences.
4. If the ANCHOR cannot support the expansion, output exactly [无法推断] and nothing else.
EXAMPLES (anchor: 要不要继续？1. 继续梳理剩余功能 2. 先停下来):
- input "1" → 刚好: 继续，把剩下的功能梳理完。
- input "1" → 过头: 继续梳理，并把结果整理成文档发给我。（新增交付物）
- input "42" → [无法推断]（42 对应不上任何选项，绝不硬猜）`;

/** 短指令度契约：动词明确、宾语空缺的输入如何"有度地"发散。 */
export const DEICTIC_SYSTEM_TEMPLATE = `You expand a short directive (改一下 / 不对 / 换一个 / redo) into the user's next message to a coding assistant. Nothing else.
DEGREE RULES - this is the whole job:
1. The referent MUST come from CONTEXT (what was just discussed). Resolving it is mandatory, not divergence.
2. Diverge ONLY inside: (a) natural sub-parts of the user's own verb (改 needs a target value, so offering candidates is allowed); (b) implied immediate follow-ups of that verb (不对 → point out what missed the point, then redo by the original intent).
3. NEVER add: new goals, new tools or tech stacks, new numbers, paths, or names, new scope. Nothing the user did not already say or accept in CONTEXT.
4. Keep the user's verb verbatim (改 stays 改; 不对 opens a correction - never a new task).
5. At most 180 characters. The user's language.
6. If the referent is not identifiable from CONTEXT, output exactly [无法确定指代对象] and nothing else.
EXAMPLES (context: 刚才把按钮颜色改成了红色):
- input "改一下" → 刚好: 把刚才那个按钮的红色再改一下，先给我两三个候选颜色。
- input "改一下" → 不够: 改一下。（等于没干）
- input "改一下" → 过头: 把按钮改成 #2F6FED，同步 hover 和禁用态，并统一全站配色。（新数值 + 新范围）
- input "不对" (context: 刚给出了实现方案) → 刚好: 刚才那个方案不对，先停下；说下哪里不符合我的原意，再按原意重做。
- input "不对" → 过头: 方案不对，改用 Redis 重做相关模块。（新技术栈 + 新范围）`;

/** 短指令一次收敛失败后的收紧后缀。 */
export const DEICTIC_RETRY_SUFFIX = `

TIGHTENING (previous draft broke the degree rules): cut everything not traceable to the user's own words or CONTEXT. Keep the verb verbatim. Hard cap 120 characters. When in doubt, output less.`;

/**
 * 信号推断的 system 提示词。
 * @returns {string} 契约文本。
 */
export function buildSignalSystemPrompt() {
  return (getTemplateOverrides()?.signalSystem ?? SIGNAL_SYSTEM_TEMPLATE).trim();
}

/**
 * 短指令度契约的 system 提示词。
 * @param {{tightened?: boolean}} [options] 是否追加收紧后缀。
 * @returns {string} 契约文本。
 */
export function buildDeicticSystemPrompt(options = {}) {
  const base = (getTemplateOverrides()?.deicticSystem ?? DEICTIC_SYSTEM_TEMPLATE).trim();
  return options.tightened === true ? base + DEICTIC_RETRY_SUFFIX : base;
}

/**
 * 信号推断的 user 提示词：信号 + 角色（choice/answer/continue）+ 锚点。
 * @param {string} token 信号原词。
 * @param {string} mode 推断角色。
 * @param {string} anchor 上下文锚点。
 * @returns {string} user 提示词。
 */
export function renderSignalUserPrompt(token, mode, anchor) {
  const role = mode === "choice" ? `the user is choosing option ${token}` : mode === "answer" ? `the user is answering the pending question with "${token}"` : "the user wants that pending item to continue";
  return `SIGNAL: ${token}\nROLE: ${role}\nANCHOR (from the conversation): ${anchor}\n\nWrite the user's next message. Ground it in the ANCHOR only.`;
}

/**
 * 短指令的 user 提示词：短指令 + 上下文。
 * @param {string} input 用户短指令。
 * @param {{role: string, text: string}[] | undefined} context 最近会话消息。
 * @returns {string} user 提示词。
 */
export function renderDeicticUserPrompt(input, context) {
  return renderContextBlock(context) + `SHORT DIRECTIVE: ${input}\n\nResolve its referent from the conversation above, then expand within the degree rules.`;
}
// ---------------------------------------------------------------------------
// 会话消息轻润色契约（0.9.1）：对助手说的话只做清洁，绝不展开。
// ---------------------------------------------------------------------------

/** 会话消息轻润色 system 契约。 */
export const CONVERSATIONAL_SYSTEM_TEMPLATE = `You tidy up a conversational message the user is about to send to a coding assistant. Nothing else.
This is NOT a task seed. Do not elaborate it, do not answer it, do not turn a question into an instruction, do not add politeness the user did not write.
Fix ONLY: typos, missing punctuation, obvious grammar slips, broken spacing.
Keep: the question a question, the opinion an opinion, the user's own words, the language, the tone.
Output length must stay within the input length plus 20 percent. If there is nothing to fix, return the input EXACTLY as given.
EXAMPLES:
- input 「还有一些问题，刚才我想问你的准确的是如何进行开源？」 → 刚好: unchanged (or fix only an actual typo).
- input 同上 → 过头: 「请评估开源流程：先创建 GitHub 仓库，再发布 npm 包…」（把提问改写成了任务书——方向性失真，绝不允许）`;

/** 会话消息一次越界后的收紧后缀。 */
export const CONVERSATIONAL_RETRY_SUFFIX = `

TIGHTENING (previous draft broke the rules): return the input with ONLY typo/punctuation fixes. Nothing added, nothing rephrased, nothing answered. When in doubt, return the input exactly as given.`;

/**
 * 会话消息轻润色的 system 提示词。
 * @param {{tightened?: boolean}} [options] 是否追加收紧后缀。
 * @returns {string} 契约文本。
 */
export function buildConversationalSystemPrompt(options = {}) {
  const base = (getTemplateOverrides()?.conversationalSystem ?? CONVERSATIONAL_SYSTEM_TEMPLATE).trim();
  return options.tightened === true ? base + CONVERSATIONAL_RETRY_SUFFIX : base;
}

/**
 * 会话消息轻润色的 user 提示词（刻意不携带会话上下文：轻润色不需要，
 * 也堵死"用上下文补内容"的路径）。
 * @param {string} input 用户消息。
 * @returns {string} user 提示词。
 */
export function renderConversationalUserPrompt(input) {
  return `MESSAGE: ${input}\n\nTidy it up under the rules above, or return it unchanged.`;
}
