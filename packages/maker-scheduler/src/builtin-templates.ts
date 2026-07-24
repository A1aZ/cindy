import type { ScheduleTemplate, TemplateCategory } from './types.js';

const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const DEFAULT_NOTIFY = { desktop: true, feishu: false } as const;

export const TEMPLATE_CATEGORIES: TemplateCategory[] = [
  { id: 'status-reports', name: '状态报告', order: 1 },
  { id: 'release-prep', name: '发布准备', order: 2 },
  { id: 'code-quality', name: '代码质量', order: 3 },
  { id: 'repo-maintenance', name: '仓库维护', order: 4 },
];

export const BUILTIN_TEMPLATES: ScheduleTemplate[] = [
  {
    id: 'standup-summary',
    name: '站会摘要',
    description: '总结昨天的 git 活动，锚定 commit/MR/文件',
    category: 'status-reports',
    source: 'builtin',
    prompt: `总结昨天的 git 活动，生成适合站会同步的摘要。
约束：
- 只使用仓库中的具体证据，包括 commit SHA、MR、文件路径、diff、测试结果或 CI 信号
- 按主题归纳，不要按流水账罗列全部提交
- 明确列出已完成、进行中、阻塞项和需要团队关注的风险
- 如果证据不足，请说明缺口，不要补编进展`,
    cronExpr: '0 9 * * 1-5',
    timezone: DEFAULT_TIMEZONE,
    recurring: true,
    agentKind: 'claude-code',
    useWorktree: false,
    notify: DEFAULT_NOTIFY,
  },
  {
    id: 'weekly-mr-summary',
    name: '每周 MR 摘要',
    description: '按成员和主题总结上周 MR，突出风险',
    category: 'status-reports',
    source: 'builtin',
    prompt: `总结上周合并或仍在评审中的 MR，生成团队周报摘要。
约束：
- 按成员和主题组织内容，引用 MR 编号、标题、相关 commit 和关键文件
- 突出高风险改动、未完成评审、测试缺口和可能影响发布的事项
- 不要把没有证据的推测写成事实
- 输出应便于团队快速决定下周优先级`,
    cronExpr: '0 9 * * 1',
    timezone: DEFAULT_TIMEZONE,
    recurring: true,
    agentKind: 'claude-code',
    useWorktree: false,
    notify: DEFAULT_NOTIFY,
  },
  {
    id: 'weekly-release-notes',
    name: '每周发布说明',
    description: '根据已合并 MR 起草发布说明',
    category: 'release-prep',
    source: 'builtin',
    prompt: `根据本周已合并 MR 起草发布说明。
约束：
- 只纳入有明确 MR、commit 或 changelog 证据的变化
- 按用户可感知的功能、修复、性能、内部维护分类
- 对破坏性变更、迁移步骤和配置变更单独标注
- 保留 MR 链接或编号，方便发布负责人追溯`,
    cronExpr: '0 9 * * 5',
    timezone: DEFAULT_TIMEZONE,
    recurring: true,
    agentKind: 'claude-code',
    useWorktree: false,
    notify: DEFAULT_NOTIFY,
  },
  {
    id: 'pre-release-check',
    name: '发版前检查',
    description: '打 tag 前核对 changelog、迁移、测试',
    category: 'release-prep',
    source: 'builtin',
    prompt: `执行发版前检查，确认当前仓库是否适合打 tag。
约束：
- 检查 changelog、版本号、数据库迁移、构建脚本、测试和 CI 状态
- 引用具体文件路径、命令输出、MR 或 commit 作为证据
- 将问题按阻塞、建议修复、可接受风险分类
- 不要修改代码；只输出检查结论和最小修复建议`,
    cronExpr: '0 13 * * 4',
    timezone: DEFAULT_TIMEZONE,
    recurring: true,
    agentKind: 'claude-code',
    useWorktree: false,
    notify: DEFAULT_NOTIFY,
  },
  {
    id: 'update-changelog',
    name: '更新变更日志',
    description: '用本周亮点和 MR 链接更新 changelog',
    category: 'release-prep',
    source: 'builtin',
    prompt: `根据本周亮点和已合并 MR 更新 changelog 草稿。
约束：
- 复用仓库现有 changelog 格式，不引入新的排版风格
- 每条变更都关联 MR、commit 或文件路径证据
- 优先写用户可理解的变化，避免内部实现细节淹没重点
- 如果 changelog 文件不存在或格式不明确，先说明建议方案，不要凭空创建结构`,
    cronExpr: '0 16 * * 5',
    timezone: DEFAULT_TIMEZONE,
    recurring: true,
    agentKind: 'claude-code',
    useWorktree: false,
    notify: DEFAULT_NOTIFY,
  },
  {
    id: 'daily-bug-scan',
    name: '每日 Bug 扫描',
    description: '扫描近期 commit 查找 bug 并提出最小修复',
    category: 'code-quality',
    source: 'builtin',
    prompt: `扫描最近的 commit（自上次运行以来，或过去 24 小时内），查找可能的 bug 并提出最小修复方案。
约束：
- 只使用仓库中的具体证据（commit SHA、MR、文件路径、diff、失败的测试、CI 信号）
- 不要臆造 bug；如果证据不足，请说明并跳过
- 优先选择最小且安全的修复；避免重构和无关清理
- 对每个疑点说明影响范围、复现线索和建议验证方式`,
    cronExpr: '0 9 * * *',
    timezone: DEFAULT_TIMEZONE,
    recurring: true,
    agentKind: 'claude-code',
    useWorktree: false,
    notify: DEFAULT_NOTIFY,
  },
  {
    id: 'test-gap-detection',
    name: '测试盲区检测',
    description: '找出变更中未测试的路径，补充测试',
    category: 'code-quality',
    source: 'builtin',
    prompt: `检查近期变更中的测试盲区，并提出补充测试方案。
约束：
- 对照 diff、现有测试文件、测试命令和失败记录判断覆盖缺口
- 优先指出高风险路径，包括状态机、数据迁移、IPC、权限和跨平台逻辑
- 给出最小测试用例建议，说明应验证的行为和失败条件
- 不要为了提高覆盖率建议无意义快照或脆弱测试`,
    cronExpr: '0 15 * * *',
    timezone: DEFAULT_TIMEZONE,
    recurring: true,
    agentKind: 'claude-code',
    useWorktree: false,
    notify: DEFAULT_NOTIFY,
  },
  {
    id: 'nightly-ci-report',
    name: '每晚 CI 报告',
    description: '总结 CI 失败和不稳定测试，提出修复建议',
    category: 'code-quality',
    source: 'builtin',
    prompt: `总结当天 CI 失败和不稳定测试，提出下一步修复建议。
约束：
- 引用具体 pipeline、job、测试名称、错误片段、commit 或 MR 作为证据
- 区分确定失败、疑似 flaky、环境问题和缺少信息的情况
- 对每个问题给出最小排查路径和优先级
- 不要把网络抖动或缓存问题直接归因到代码，除非有证据支持`,
    cronExpr: '0 21 * * *',
    timezone: DEFAULT_TIMEZONE,
    recurring: true,
    agentKind: 'claude-code',
    useWorktree: false,
    notify: DEFAULT_NOTIFY,
  },
  {
    id: 'dependency-sweep',
    name: '依赖清扫',
    description: '扫描过时依赖，提出安全升级方案',
    category: 'repo-maintenance',
    source: 'builtin',
    prompt: `扫描仓库依赖状态，提出安全且可回滚的升级方案。
约束：
- 优先关注安全漏洞、已知兼容性问题和项目实际使用到的关键依赖
- 引用 package 文件、lockfile、release note 或安全公告作为证据
- 将升级分为可直接升级、需要适配、建议暂缓三类
- 不要批量升级无关依赖；每个建议都要包含验证命令和回滚方式`,
    cronExpr: '0 9 1 * *',
    timezone: DEFAULT_TIMEZONE,
    recurring: true,
    agentKind: 'claude-code',
    useWorktree: true,
    notify: DEFAULT_NOTIFY,
  },
];
