// What is in the pet's belly: the conversation as the next request sends it, in meals. A meal is one thing the
// context holds (a tool's result, what a tool was handed, a message), named for what it is; meals of one name add up.

export type Meal = { label: string; tokens: number; count: number }

// One message of `$.session.messages({ as: 'api' })`: its blocks as the Messages API spells them.
export type MealMessage = { role: 'user' | 'assistant'; content: readonly unknown[] }

// An image, at about the size the API scales one to.
const IMAGE_TOKENS = 1600
// A meal smaller than this is a snack: never one of the biggest.
const SNACK = 200

const CATEGORY: Readonly<Record<string, string>> = {
  'System prompt': '系統提示',
  'System tools': '內建工具',
  'MCP tools': 'MCP 工具',
  'Custom agents': '自訂 agent',
  'Memory files': '記憶檔',
  Skills: '技能',
  'Slash commands': '斜線指令',
  Messages: '對話',
}

// Rough tokens of text: about 3.5 ASCII characters to a token, about one token for every other character (CJK).
export function tokensOf(text: string): number {
  const ascii = text.replace(/[^\x00-\x7f]/g, '').length
  return Math.round(ascii / 3.5 + (text.length - ascii))
}

export function categoryName(name: string): string {
  return CATEGORY[name] ?? name
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function str(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  return typeof value === 'string' ? value : ''
}

// One line, at most `max` characters.
function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}

// A path from the session's root, else its last two parts; a long one keeps its end.
export function shortPath(path: string, root: string): string {
  const slashed = path.replace(/\\/g, '/')
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const isInside = base !== '' && slashed.toLowerCase().startsWith(`${base.toLowerCase()}/`)
  const short = isInside ? slashed.slice(base.length + 1) : slashed.split('/').slice(-2).join('/')
  return short.length <= 48 ? short : `…${short.slice(-47)}`
}

// A tool call as the list names it: the tool and what it was pointed at.
export function toolLabel(name: string, input: Record<string, unknown>, root: string): string {
  const path = str(input, 'file_path') || str(input, 'notebook_path')
  if (['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) {
    return path === '' ? name : `${name} ${shortPath(path, root)}`
  }
  if (name === 'Bash' || name === 'PowerShell') return `${name} ${clip(str(input, 'command').split('\n')[0] ?? '', 40)}`
  if (name === 'Grep' || name === 'Glob') return `${name} ${clip(str(input, 'pattern'), 30)}`
  if (name === 'WebFetch') return `WebFetch ${clip(str(input, 'url').replace(/^https?:\/\//, ''), 40)}`
  if (name === 'WebSearch') return `WebSearch ${clip(str(input, 'query'), 30)}`
  if (name === 'Agent' || name === 'Task') return `${name} ${clip(str(input, 'description'), 30)}`
  if (name === 'Skill') return `Skill ${str(input, 'skill')}`
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  return mcp === null ? name : `${mcp[1]}/${mcp[2]}`
}

// What a call's own arguments are, when they are big enough to count: a Write's whole file, an Edit's text.
function inputWord(name: string): string {
  if (name === 'Write') return '寫進去的內容'
  if (name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') return '改的內容'
  if (name === 'Agent' || name === 'Task') return '交代的任務'
  return '參數'
}

function textLabel(role: MealMessage['role'], text: string): string {
  if (/^\s*<system-reminder>/.test(text)) return '系統附加的提醒'
  if (/^\s*<local-command-stdout>/.test(text)) return '指令的輸出'
  const command = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/.exec(text)
  if (command !== null) return `指令 /${command[1]}`
  if (text.slice(0, 400).includes('This session is being continued from a previous conversation')) return '上次壓縮留下的摘要'
  return role === 'user' ? `你的訊息「${clip(text, 16)}」` : `Claude 的回覆「${clip(text, 16)}」`
}

function resultTokens(content: unknown): number {
  if (typeof content === 'string') return tokensOf(content)
  if (!Array.isArray(content)) return 0
  let tokens = 0
  for (const part of content) {
    const block = record(part)
    if (block.type === 'text') tokens += tokensOf(str(block, 'text'))
    else if (block.type === 'image') tokens += IMAGE_TOKENS
  }
  return tokens
}

// Every meal in the belly, biggest first.
export function mealsOf(messages: readonly MealMessage[], root: string): Meal[] {
  const uses = new Map<string, { name: string; input: Record<string, unknown> }>()
  for (const message of messages) {
    for (const part of message.content) {
      const block = record(part)
      if (block.type === 'tool_use') uses.set(str(block, 'id'), { name: str(block, 'name'), input: record(block.input) })
    }
  }
  const meals = new Map<string, Meal>()
  const eat = (label: string, tokens: number) => {
    if (tokens <= 0) return
    const meal = meals.get(label)
    meals.set(label, { label, tokens: (meal?.tokens ?? 0) + tokens, count: (meal?.count ?? 0) + 1 })
  }
  for (const message of messages) {
    for (const part of message.content) {
      const block = record(part)
      if (block.type === 'text') eat(textLabel(message.role, str(block, 'text')), tokensOf(str(block, 'text')))
      else if (block.type === 'thinking') eat('Claude 的思考', tokensOf(str(block, 'thinking')))
      else if (block.type === 'image') eat(message.role === 'user' ? '你貼的圖片' : '圖片', IMAGE_TOKENS)
      else if (block.type === 'tool_use') {
        const name = str(block, 'name')
        const input = record(block.input)
        eat(`${toolLabel(name, input, root)}（${inputWord(name)}）`, tokensOf(JSON.stringify(input)))
      } else if (block.type === 'tool_result') {
        const use = uses.get(str(block, 'tool_use_id'))
        eat(use === undefined ? '工具結果' : toolLabel(use.name, use.input, root), resultTokens(block.content))
      }
    }
  }
  return [...meals.values()].sort((a, b) => b.tokens - a.tokens)
}

// The biggest meals, snacks left out.
export function biggest(meals: readonly Meal[], count: number): Meal[] {
  return meals.filter(meal => meal.tokens >= SNACK).slice(0, count)
}
