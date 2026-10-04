import { expect, test } from 'claude-code/testing'

import { biggest, categoryName, mealsOf, shortPath, tokensOf, toolLabel } from '../hooks/meals'
import type { MealMessage } from '../hooks/meals'

const ROOT = 'D:\\proj'

test('tokens are estimated from the text: code by its characters, CJK one by one', () => {
  expect(tokensOf('')).toBe(0)
  expect(tokensOf('x'.repeat(350))).toBe(100)
  expect(tokensOf('肚子好撐')).toBe(4)
})

test('a tool call is named by what it was pointed at', () => {
  expect(toolLabel('Read', { file_path: 'D:\\proj\\src\\app.ts' }, ROOT)).toBe('Read src/app.ts')
  expect(toolLabel('Read', { file_path: 'C:\\Users\\me\\notes\\todo.md' }, ROOT)).toBe('Read notes/todo.md')
  expect(toolLabel('PowerShell', { command: 'git log -p\nGet-Date' }, ROOT)).toBe('PowerShell git log -p')
  expect(toolLabel('Bash', { command: `echo ${'a'.repeat(80)}` }, ROOT)).toMatch(/^Bash echo a{34}…$/)
  expect(toolLabel('WebFetch', { url: 'https://example.com/docs' }, ROOT)).toBe('WebFetch example.com/docs')
  expect(toolLabel('mcp__convo-diff__diff', {}, ROOT)).toBe('convo-diff/diff')
  expect(toolLabel('TodoWrite', {}, ROOT)).toBe('TodoWrite')
  expect(shortPath(`D:\\proj\\${'deep\\'.repeat(12)}file.ts`, ROOT)).toMatch(/^….*\/file\.ts$/)
})

test('meals of one name add up, a result goes by its call, and what a call was handed counts as its own', () => {
  const messages: MealMessage[] = [
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>\nCLAUDE.md\n</system-reminder>' }, { type: 'text', text: '幫我看 build' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'D:\\proj\\package-lock.json' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'x'.repeat(140_000) }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: 'D:\\proj\\a.ts', content: 'y'.repeat(35_000) } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w1', content: [{ type: 'text', text: 'File created successfully' }] }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: 'D:\\proj\\package-lock.json', offset: 9 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r2', content: [{ type: 'text', text: 'x'.repeat(14_000) }, { type: 'image' }] }] },
    { role: 'user', content: [{ type: 'image', source: {} }] },
  ]
  const meals = mealsOf(messages, ROOT)
  expect(meals[0]).toEqual({ label: 'Read package-lock.json', tokens: 40_000 + 4000 + 1600, count: 2 })
  expect(meals[1]?.label).toBe('Write a.ts（寫進去的內容）')
  expect(meals.map(meal => meal.label)).toContain('你貼的圖片')
  expect(meals.map(meal => meal.label)).toContain('系統附加的提醒')
  expect(meals.map(meal => meal.label)).toContain('你的訊息「幫我看 build」')

  // Snacks never make the list.
  const top = biggest(meals, 5)
  expect(top.map(meal => meal.label)).toEqual(['Read package-lock.json', 'Write a.ts（寫進去的內容）', '你貼的圖片'])
})

test("after a compaction, the summary stands in for what it replaced", () => {
  const summary = `This session is being continued from a previous conversation that ran out of context. ${'s'.repeat(7000)}`
  const meals = mealsOf([{ role: 'user', content: [{ type: 'text', text: summary }] }], ROOT)
  expect(meals).toEqual([{ label: '上次壓縮留下的摘要', tokens: tokensOf(summary), count: 1 }])
})

test('the context breakdown reads in Chinese', () => {
  expect(categoryName('System tools')).toBe('內建工具')
  expect(categoryName('Messages')).toBe('對話')
  expect(categoryName('Something new')).toBe('Something new')
})
