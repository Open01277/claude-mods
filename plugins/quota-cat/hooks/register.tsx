import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, Timer } from 'claude-code'

import type { QuotaCatLimit, QuotaCatNow } from '../types'

type Rarity = 'N' | 'R' | 'SR' | 'SSR' | 'UR'
type Mood = 0 | 1 | 2
type Stage = Mood | 'h1' | 'h2' | 'h3' | 'peek' | 'dead'
type Pools = Readonly<Record<Mood, readonly string[]>>

type Cat = {
  id: string
  name: string
  rarity: Rarity
  wrap: (face: string) => string
  lines: Pools
  faces?: Pools
  horrorWrap?: (face: string) => string
  horrorAt?: number
  deadFace?: string
  deadLine?: string
}

// Kept in $.store so the collection and pity outlive the session.
type Save = {
  v: 1
  cat: QuotaCatNow
  pity: number
  pulls: number
  cans: number
  dex: Record<string, { count: number; deaths: number }>
  history: string[]
  window: number | null
  lastPct: number | null
  warned: number
}

const limitsAtom = atom({ plugin: 'quota-cat', key: 'limits' } as const, null)
const catAtom = atom({ plugin: 'quota-cat', key: 'cat' } as const, null)
const previewAtom = atom({ plugin: 'quota-cat', key: 'preview' } as const, null)

const PITY = 30
const HALF_HOUR = 30 * 60_000
const WEEK_MS = 7 * 24 * 3600_000

const whiskers = (face: string) => `(=${face}=)`

const CATS: readonly Cat[] = [
  {
    id: 'plain',
    name: '普通貓',
    rarity: 'N',
    wrap: whiskers,
    lines: {
      0: ['今天也要好好寫 code 喵～', '陪你寫 code 是我的工作喵'],
      1: ['有點想睡了喵…', '喵～（打哈欠）額度過半了喔'],
      2: ['你是不是又叫我讀整個 repo', '慢、慢一點喵…額度在哭'],
    },
  },
  {
    id: 'orange',
    name: '橘貓',
    rarity: 'N',
    wrap: face => `(=  ${face}  =)`,
    lines: {
      0: ['今天也是吃飽飽的一天', '罐罐呢？我說罐罐呢？'],
      1: ['剛剛那些 token 好吃嗎？分我一點', '我沒有偷吃額度，是它自己變少的'],
      2: ['我沒有胖，是額度條變寬了', 'token 吃太多了…好撐…'],
    },
  },
  {
    id: 'tuxedo',
    name: '賓士貓',
    rarity: 'N',
    wrap: face => `(=${face}=)ʚɞ`,
    lines: {
      0: ['穿這麼正式，因為今天要上班', '領結打好了，準備開會喵'],
      1: ['會議中，請勿打擾喵', '這個會議…可以用 email 處理嗎'],
      2: ['這個需求…下週再說好嗎', '西裝都皺了…今天先這樣'],
    },
  },
  {
    id: 'shades',
    name: '墨鏡貓',
    rarity: 'R',
    wrap: whiskers,
    faces: { 0: ['■_■', '■ω■'], 1: ['■_■', '■‿■'], 2: ['■_■;', '■Д■'] },
    horrorWrap: face => `(=${face}=)  ■-■`,
    lines: {
      0: ['這點額度，小事', '額度？我不看那種東西'],
      1: ['還很多啦，冷靜', '墨鏡戴著，就看不到額度條了'],
      2: ['…好啦其實有點慌', '墨鏡起霧了…'],
    },
  },
  {
    id: 'engineer',
    name: '工程師貓',
    rarity: 'R',
    wrap: face => `(=${face}=)っ旦`,
    lines: {
      0: ['這個 bug 不是我寫的喵', '今天也要準時下班（不可能）'],
      1: ['在我的電腦上是好的啊', '先寫個 TODO，之後再說'],
      2: ['先 revert 再說', '這是 feature，不是 bug'],
    },
  },
  {
    id: 'black',
    name: '黑貓',
    rarity: 'R',
    wrap: whiskers,
    horrorAt: 70,
    faces: { 0: ['ↀωↀ', 'ↀ‿ↀ'], 1: ['ↀωↀ', 'ↀ_ↀ'], 2: ['ↀ∀ↀ', 'ↀωↀ'] },
    lines: {
      0: ['我只是隻普通的黑貓…真的', '聽說看到黑貓會帶來…算了，沒事'],
      1: ['要不要聽個故事？關於一個用光額度的人…', '今晚月色真美…額度也是'],
      2: ['快到了…我最喜歡的部分…', '再一點點…就可以開始講鬼故事了…'],
    },
  },
  {
    id: 'lucky',
    name: '招財貓',
    rarity: 'SR',
    wrap: face => `福(=${face}=)ﾉ彡`,
    lines: {
      0: ['招財進寶，招 token 進來', '今日運勢：大吉（額度除外）'],
      1: ['額度不會因為我招手就變多喔', '招了半天…只招到 rate limit'],
      2: ['手好痠，招不動了', '財神爺說他也沒額度了'],
    },
  },
  {
    id: 'space',
    name: '太空貓',
    rarity: 'SR',
    wrap: face => `◖(=${face}=)◗`,
    lines: {
      0: ['在太空中，沒有人聽得到你的 rate limit', '這是貓的一小步，額度的一大步'],
      1: ['休士頓，我們的額度出了點問題', '正在進入額度的大氣層…'],
      2: ['氧氣…我是說額度…剩不多了', '重力好重…是額度的重量…'],
    },
  },
  {
    id: 'schrodinger',
    name: '薛丁格的貓',
    rarity: 'SSR',
    wrap: face => `[ (=${face}=) ]`,
    deadFace: '[  ?  ]',
    deadLine: '盒子沒打開，所以我既死了也沒死',
    lines: {
      0: ['我在箱子裡。可能活著，也可能沒有', '你一觀測，我就塌縮給你看'],
      1: ['你的額度也一樣，沒打開 usage 前都是疊加態', '要不要賭，打開箱子時還有沒有額度？'],
      2: ['別打開箱子，拜託', '觀測到了…額度確定在減少…'],
    },
  },
  {
    id: 'god',
    name: '貓神',
    rarity: 'UR',
    wrap: face => `✧˖°(=${face}=)°˖✧`,
    lines: {
      0: ['吾乃額度之神，跪下', '凡人，汝的額度吾已過目'],
      1: ['吾亦無法幫你加額度', '神也是要看帳單的'],
      2: ['吾…也想下班了', '神蹟？沒有，只有 rate limit'],
    },
  },
]

const MOOD: Pools = {
  0: ['^･ω･^', '･ω･', '^‥^', '´∇｀', '≧ω≦', '^ω^', 'ˊᗜˋ', '◕ω◕'],
  1: ['-ω-', '´ω｀', 'ˇωˇ', '˘ω˘', '｡-ω-｡', '_ _'],
  2: ['；ω；', 'ﾟДﾟ', 'ＴωＴ', '°ω°', '´Д｀', '>ω<', '｡>﹏<｡'],
}
const WORK = ['｀ω´', 'ˋωˊ', '•ω•']
const HORROR = [
  ['⊙ω⊙', 'ʘωʘ', '◉ω◉'],
  ['◉ ◉', '⊙ ⊙', 'ʘ ʘ', 'ಠ ಠ'],
  ['▓ω░', '◉▓◉', '░ω▓', '▒ω▓'],
] as const
const PEEK = ['|ω・)', '|д゜)', '┃ω◉)', '|◉)', '|ω・) じーっ']
const DEAD = ['_(:3 」∠)_ ﾟ･魂･ﾟ', '(=×ω×=) ～魂～', '†(=✖ω✖=)†', '(=x_x=)']
const EGG = ['(=･ω･=)っ◯', '◯⊂(=･ω･=)', '(=ﾟ∀ﾟ=)っ◯']

const HORROR_LINES = [
  ['…你有聽到嗎…token 一個一個消失的聲音…', '剛剛…是誰在用你的額度…', '今晚的額度…特別安靜呢…'],
  ['我剛剛又數了一次額度…少了一個…', '不要再按 Enter 了…它會聽到…', '你知道額度用完的人…後來都去哪了嗎…'],
  ['額▓度░還█剩…不░多▓了…', '救…救救…我…的…token…', '螢幕…後面…有東西在吃額度…'],
  ['不要回頭……打開你的 usage 頁面看看……', '我一直…都在這裡看著你喔…', '就差一點點了…對吧？…嘻嘻…'],
] as const
const DEAD_LINES = ['它…會在 {cd} 後回來…', 'R.I.P. {name}，享年 5 小時', '我先走一步…{cd} 後見…']

const LUCK: Record<Rarity, readonly string[]> = {
  N: ['(´・ω・`) 又是 N…你是非洲人嗎', '(￣▽￣) 嗯，很普通的一抽'],
  R: ['(・∀・) 普普通通，還行', '(｀・ω・´) 小確幸'],
  SR: ['(ﾟ∀ﾟ) 喔喔！有點東西', 'ヽ(・∀・)ﾉ SR！今天運氣不錯'],
  SSR: ['ヽ(°〇°)ﾉ 歐皇降臨！！', 'Σ(ﾟДﾟ) SSR？！我沒看錯吧'],
  UR: ['(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧ 金色傳說！！快截圖！', '(((ﾟДﾟ))) UR…這輩子的運氣用完了'],
}
const RATES: readonly (readonly [Rarity, number])[] = [
  ['N', 55],
  ['R', 27],
  ['SR', 13],
  ['SSR', 4],
  ['UR', 1],
]
const RANK: Record<Rarity, number> = { N: 0, R: 1, SR: 2, SSR: 3, UR: 4 }
const RARITY_COLOR: Record<Rarity, string> = {
  N: 'gray',
  R: 'blue',
  SR: 'magenta',
  SSR: 'yellow',
  UR: 'red',
}

// Same seed, same pick: the face only changes when the percent moves.
function pick<T>(list: readonly T[], ...seed: readonly (string | number)[]): T {
  let hash = 2166136261
  for (const char of seed.join('|')) {
    hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16777619)
  }
  return list[(hash >>> 0) % list.length] as T
}

function chance<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)] as T
}

function catById(id: string): Cat {
  return CATS.find(cat => cat.id === id) ?? (CATS[0] as Cat)
}

function portrait(cat: Cat): string {
  return cat.wrap(pick((cat.faces ?? MOOD)[0], cat.id))
}

function toLimit(limit: SessionRateLimit | undefined): QuotaCatLimit | null {
  if (limit === undefined) return null
  const at = limit.resetsAt === undefined ? Number.NaN : Date.parse(limit.resetsAt)
  return { pct: limit.percentUsed, resetsAt: Number.isFinite(at) ? at : null }
}

function stageOf(pct: number, cat: Cat): Stage {
  if (pct >= 100) return 'dead'
  if (pct >= 99) return 'peek'
  if (pct >= 95) return 'h3'
  if (pct >= 90) return 'h2'
  if (pct >= (cat.horrorAt ?? 85)) return 'h1'
  if (pct >= 60) return 2
  if (pct >= 30) return 1
  return 0
}

function faceOf(cat: Cat, stage: Stage, seed: number, isWorking: boolean): string {
  if (stage === 'dead') return cat.deadFace ?? pick(DEAD, cat.id, seed)
  if (stage === 'peek') return pick(PEEK, cat.id, seed)
  if (stage === 'h1' || stage === 'h2' || stage === 'h3') {
    const pool = HORROR[stage === 'h1' ? 0 : stage === 'h2' ? 1 : 2]
    return (cat.horrorWrap ?? cat.wrap)(pick(pool, cat.id, seed))
  }
  const pool = cat.faces?.[stage] ?? (isWorking ? WORK : MOOD[stage])
  return cat.wrap(pick(pool, cat.id, seed))
}

function sayOf(cat: Cat, stage: Stage, seed: number, countdown: string): string {
  if (stage === 'dead') {
    const line = cat.deadLine ?? pick(DEAD_LINES, cat.id, seed)
    return line.replace('{cd}', countdown).replace('{name}', cat.name)
  }
  if (stage === 'peek') return pick(HORROR_LINES[3], seed)
  if (stage === 'h1') return pick(HORROR_LINES[0], seed)
  if (stage === 'h2') return pick(HORROR_LINES[1], seed)
  if (stage === 'h3') return pick(HORROR_LINES[2], seed)
  return pick(cat.lines[stage], cat.id, seed)
}

function dur(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes >= 1440) {
    const days = Math.floor(minutes / 1440)
    const hours = Math.floor((minutes % 1440) / 60)
    return hours > 0 ? `${days}天${hours}時` : `${days}天`
  }
  if (minutes >= 60) {
    return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
  }
  return `${minutes}m`
}

function bar(pct: number): string {
  const filled = Math.min(10, Math.max(0, Math.round(pct / 10)))
  return '█'.repeat(filled) + '░'.repeat(10 - filled)
}

function barColor(pct: number): string {
  return pct >= 85 ? 'red' : pct >= 60 ? 'yellow' : 'green'
}

function foodLine(week: QuotaCatLimit, now: number): { text: string; color: string } {
  const left = week.resetsAt === null ? null : Math.max(0, week.resetsAt - now)
  const restock = left === null ? '' : `（${dur(left)}後補貨）`
  if (left === 0) return { text: '補貨了！等下一筆資料', color: 'green' }
  if (week.pct >= 100) return { text: `吃光了…這週剩下的日子…牠們要吃什麼…${restock}`, color: 'red' }
  if (week.pct >= 90) return { text: `只剩袋底了…袋子裡…好像有東西在動…${restock}`, color: 'red' }
  if (left === null) return { text: '還夠吃', color: 'green' }
  const elapsed = WEEK_MS - left
  if (week.pct <= 0 || elapsed < 3 * 3600_000) return { text: `滿滿一整袋${restock}`, color: 'green' }
  const toEmpty = ((100 - week.pct) * elapsed) / week.pct
  if (toEmpty >= left) return { text: `夠吃到補貨${restock}`, color: 'green' }
  return {
    text: `照這速度 ${dur(toEmpty)} 後吃光，比補貨早 ${dur(left - toEmpty)}`,
    color: 'yellow',
  }
}

function critLine(delta: number): string {
  if (delta >= 20) {
    return `(╯°□°)╯︵ ┻━┻ 致命一擊！一輪吃掉 ${delta}%，你是不是叫它讀整個 node_modules`
  }
  if (delta >= 10) return `Σ(ﾟДﾟ) 會心一擊！這一輪 -${delta}%！你剛剛叫它做了什麼？？`
  return `(°ロ°) 暴擊！這一輪 -${delta}%`
}

function rollRarity(): Rarity {
  let ticket = Math.random() * 100
  for (const [rarity, weight] of RATES) {
    ticket -= weight
    if (ticket < 0) return rarity
  }
  return 'N'
}

function rollCat(rarity: Rarity = rollRarity()): Cat {
  return chance(CATS.filter(cat => cat.rarity === rarity))
}

function pull(save: Save): Cat {
  save.pity += 1
  save.pulls += 1
  const rarity = save.pity >= PITY ? (Math.random() < 0.2 ? 'UR' : 'SSR') : rollRarity()
  if (rarity === 'SSR' || rarity === 'UR') save.pity = 0
  return rollCat(rarity)
}

let queue: Promise<unknown> = Promise.resolve()

// Measurements, turn ends and commands all touch the save: one at a time.
function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job)
  queue = run.catch(() => undefined)
  return run
}

async function load($: EngineInterface): Promise<Save> {
  const raw = (await $.store.get('save')) as Partial<Save> | undefined
  if (raw !== undefined && raw.v === 1 && raw.cat !== undefined) return raw as Save
  const now = await $.clock.now()
  const save: Save = {
    v: 1,
    cat: { id: 'plain', since: now, isDead: false },
    pity: 0,
    pulls: 0,
    cans: 0,
    dex: { plain: { count: 1, deaths: 0 } },
    history: ['新手禮包：普通貓 ×1'],
    window: null,
    lastPct: null,
    warned: 0,
  }
  await $.store.set('save', save)
  $.ui.toast('扭蛋機到貨！新手禮包：普通貓 ×1 (=^･ω･^=)ﾉ', { timeoutMs: 10_000 })
  return save
}

async function persist($: EngineInterface, save: Save): Promise<void> {
  await $.store.set('save', save)
  await update($, catAtom, () => save.cat)
}

function isNewWindow(save: Save, five: QuotaCatLimit): boolean {
  if (save.window !== null && five.resetsAt !== null) {
    return five.resetsAt - save.window > HALF_HOUR
  }
  return save.lastPct !== null && five.pct + 20 < save.lastPct
}

function reincarnate($: EngineInterface, save: Save, now: number): void {
  const old = catById(save.cat.id)
  const hasDied = save.cat.isDead
  const cat = pull(save)
  const seen = save.dex[cat.id]?.count ?? 0
  save.dex[cat.id] = { count: seen + 1, deaths: save.dex[cat.id]?.deaths ?? 0 }
  if (seen > 0) save.cans += 1
  save.cat = { id: cat.id, since: now, isDead: false }
  save.warned = 0

  const isSame = cat.id === old.id
  const title = hasDied
    ? `《關於我額度用完後轉生成${isSame ? '…還是' : ''}${cat.name}這檔事》`
    : isSame
      ? `交班：${old.name} 下班了，結果接班的還是${cat.name}`
      : `交班：${old.name} 下班了，${cat.name} 接手`
  const have = CATS.filter(one => (save.dex[one.id]?.count ?? 0) > 0).length
  const extra =
    seen > 0 ? '重複！自動分解成罐罐 ×1，罐罐沒有任何用途' : `新貓入手！圖鑑 ${have}/${CATS.length}`
  const luck = chance(LUCK[cat.rarity])
  save.history = [`[${cat.rarity}] ${title}`, ...save.history].slice(0, 8)
  $.ui.toast(`${portrait(cat)} ${title} ── ${luck}`, { timeoutMs: 12_000 })
  $.ui.log(`扭蛋 [${cat.rarity}] ${title} ── ${luck}｜${extra}`)
}

async function ingest($: EngineInterface, rateLimits: readonly SessionRateLimit[]): Promise<void> {
  const five = toLimit(rateLimits.find(limit => limit.kind === 'five_hour'))
  const week = toLimit(rateLimits.find(limit => limit.kind === 'seven_day'))
  if (five === null && week === null) return
  await update($, limitsAtom, () => ({ five, week }))
  if (five === null) return

  const save = await load($)
  const now = await $.clock.now()
  const isNew = isNewWindow(save, five)
  if (isNew) reincarnate($, save, now)
  if (five.resetsAt !== null && (save.window === null || five.resetsAt > save.window)) {
    save.window = five.resetsAt
  }

  const cat = catById(save.cat.id)
  const pct = Math.floor(five.pct)
  const countdown = five.resetsAt === null ? '幾小時' : dur(five.resetsAt - now)
  if (five.pct >= 100 && !save.cat.isDead) {
    const entry = save.dex[cat.id] ?? { count: 1, deaths: 0 }
    save.dex[cat.id] = { ...entry, deaths: entry.deaths + 1 }
    $.ui.toast(`(✖╭╮✖) ${cat.name} 陣亡了…${countdown} 後轉生，到時候會抽到誰呢…`, {
      timeoutMs: 10_000,
    })
    $.ui.log(`陣亡 ${cat.name}（上工 ${dur(now - save.cat.since)}）`)
    save.cat = { ...save.cat, isDead: true }
  } else if (five.pct >= 95 && five.pct < 100 && save.warned < 2) {
    save.warned = 2
    $.ui.toast(`|ω・) 額度 ${pct}%…它…在看著你…`, { timeoutMs: 8000 })
  } else if (five.pct >= (cat.horrorAt ?? 85) && five.pct < 95 && save.warned < 1) {
    save.warned = 1
    $.ui.toast(`${cat.wrap('⊙ω⊙')} 額度 ${pct}%…燈…好像暗了一點…`, { timeoutMs: 8000 })
  }
  save.lastPct = five.pct
  await persist($, save)
}

async function dexText($: EngineInterface): Promise<string> {
  const save = await serial(() => load($))
  const now = await $.clock.now()
  const cat = catById(save.cat.id)
  const have = CATS.filter(one => (save.dex[one.id]?.count ?? 0) > 0).length
  const left = PITY - save.pity
  const rows = CATS.map(one => {
    const entry = save.dex[one.id]
    if (entry === undefined || entry.count === 0) return `[${one.rarity}] ？？？（尚未抽到）`
    const deaths = entry.deaths > 0 ? `，陣亡 ${entry.deaths} 次` : ''
    return `[${one.rarity}] ${one.name} ${portrait(one)} ×${entry.count}${deaths}`
  })
  return [
    `貓咪圖鑑 ${have}/${CATS.length} ｜ 總抽數 ${save.pulls} ｜ 保底還有 ${left} 抽（約 ${((left * 5) / 24).toFixed(1)} 天）｜ 罐罐 ${save.cans}（沒有任何用途）`,
    `現役：${portrait(cat)} ${cat.name} [${cat.rarity}]，上工 ${dur(now - save.cat.since)}${save.cat.isDead ? '（已陣亡，等待轉生）' : ''}`,
    '',
    ...rows,
    '',
    '最近：',
    ...save.history.map(line => `・${line}`),
    '',
    '玩法：/catdex 試抽 ｜ /catdex 十連 ｜ /catdex 預覽 ｜ /catdex 預覽 95 墨鏡貓',
  ].join('\n')
}

function trialText(times: number): string {
  const got = Array.from({ length: times }, () => rollCat())
  const best = got.reduce((top, cat) => (RANK[cat.rarity] > RANK[top.rarity] ? cat : top))
  const head =
    times === 1
      ? '【試抽・不計入圖鑑】'
      : '【十連試抽・不計入圖鑑】十連要 50 小時額度…騙你的，這是試抽 (=･ω･=)ﾉ'
  return [head, ...got.map(cat => `[${cat.rarity}] ${cat.name} ${portrait(cat)}`), chance(LUCK[best.rarity])].join('\n')
}

let tour: Timer | null = null

async function startPreview($: EngineInterface, words: readonly string[]): Promise<string> {
  const pctWord = words.find(word => /^\d{1,3}$/.test(word))
  const catWord = words.find(word => !/^\d{1,3}$/.test(word))
  const chosen = catWord === undefined ? undefined : CATS.find(cat => cat.name === catWord || cat.id === catWord)
  if (catWord !== undefined && chosen === undefined) {
    return `沒有這隻貓：${catWord}（有：${CATS.map(cat => cat.name).join('、')}）`
  }
  const catId = chosen?.id ?? null
  const now = await $.clock.now()
  tour?.cancel()
  tour = null

  if (pctWord !== undefined) {
    const pct = Math.min(100, Number(pctWord))
    await update($, previewAtom, () => ({ pct, until: now + 60_000, catId }))
    $.clock.after(60_500, () => void update($, previewAtom, () => null).catch(() => undefined))
    return `預覽 ${pct}% 一分鐘（只是演的，真實額度沒有動）`
  }

  const steps = [10, 45, 70, 87, 92, 96, 99, 100]
  let index = 0
  await update($, previewAtom, () => ({ pct: steps[0] ?? 10, until: now + 4000 * (steps.length + 1), catId }))
  tour = $.clock.every(4000, () => {
    index += 1
    const pct = steps[index]
    if (pct === undefined) {
      tour?.cancel()
      tour = null
      void update($, previewAtom, () => null).catch(() => undefined)
      return
    }
    void update($, previewAtom, value => (value === null ? null : { ...value, pct })).catch(() => undefined)
  })
  return '預覽：從 10% 一路演到陣亡，每 4 秒換一階（只是演的，真實額度沒有動）'
}

export const register: Register = on => {
  let turnStart: { turnId: string; pct: number; window: number | null } | null = null

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'catdex',
      description: '額度貓咪圖鑑：抽過的貓、陣亡紀錄、保底（試抽／十連／預覽）',
      argumentHint: '[試抽 | 十連 | 預覽 [0-100] [貓名]]',
    })
    await serial(async () => {
      const save = await load($)
      await update($, catAtom, () => save.cat)
    })
    const usage = await $.session.usage()
    await serial(() => ingest($, usage.rateLimits))
    // The countdowns move even when the percent does not.
    $.clock.every(60_000, () => $.ui.invalidate('ui.render'))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.changed.includes('rateLimits')) {
      await serial(() => ingest($, e.rateLimits))
    }

    return result
  })

  on('turn.start', async ($, e, next) => {
    const limits = await read($, limitsAtom)
    const five = limits?.five ?? null
    turnStart = five === null ? null : { turnId: e.turnId, pct: five.pct, window: five.resetsAt }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const start = turnStart
    if (e.agentId === undefined && start !== null && start.turnId === e.turnId) {
      turnStart = null
      const usage = await $.session.usage()
      const five = toLimit(usage.rateLimits.find(limit => limit.kind === 'five_hour'))
      const isSameWindow =
        five !== null &&
        (five.resetsAt === null || start.window === null
          ? five.resetsAt === start.window
          : Math.abs(five.resetsAt - start.window) < HALF_HOUR)
      const delta = five !== null && isSameWindow ? Math.round(five.pct - start.pct) : 0
      if (delta >= 5) $.ui.toast(critLine(delta), { timeoutMs: 8000 })
    }

    return result
  })

  on('command.run', { command: 'catdex' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(word => word.length > 0)
    const [verb, ...rest] = words
    if (verb === '試抽' || verb === 'try') return { text: trialText(1) }
    if (verb === '十連' || verb === '10') return { text: trialText(10) }
    if (verb === '預覽' || verb === 'preview') return { text: await startPreview($, rest) }

    return { text: await dexText($) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const held = await read($, catAtom)
    if (e.props.hasSurvey || held === null) return next(e)

    const limits = await read($, limitsAtom)
    const preview = await read($, previewAtom)
    const now = await $.clock.now()
    const shown = preview !== null && preview.until > now ? preview : null
    const cat = catById(shown?.catId ?? held.id)
    const five: QuotaCatLimit | null =
      shown === null
        ? (limits?.five ?? null)
        : { pct: shown.pct, resetsAt: now + (100 - shown.pct) * 3 * 60_000 + 20 * 60_000 }
    const week = limits?.week ?? null
    const isOver = shown === null && five !== null && five.resetsAt !== null && now >= five.resetsAt
    const countdown = five?.resetsAt == null ? '幾小時' : dur(five.resetsAt - now)

    let face = portrait(cat)
    let say = '還沒拿到額度資料…跟我說句話吧'
    let stage: Stage | null = null
    if (five !== null && isOver) {
      face = pick(EGG, cat.id, held.since)
      say = held.isDead
        ? `額度重置了！說句話就開扭蛋（${cat.name}轉生中…）`
        : '額度重置了！說句話就能開新扭蛋'
    } else if (five !== null) {
      stage = (shown === null && held.isDead) || five.pct >= 100 ? 'dead' : stageOf(five.pct, cat)
      const seed = Math.floor(five.pct)
      face = faceOf(cat, stage, seed, e.props.isWorking)
      say = sayOf(cat, stage, seed, countdown)
    }
    const isCreepy = stage === 'h1' || stage === 'h2' || stage === 'h3' || stage === 'peek'
    const faceColor = isCreepy ? 'red' : stage === 2 ? 'yellow' : undefined
    const food = week === null ? null : foodLine(week, now)
    const paint = (color: string | undefined) => (color === undefined ? {} : { color })

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Text bold dimColor={stage === 'dead'} {...paint(faceColor)}>
            {face}
          </Text>
          <Text color={RARITY_COLOR[cat.rarity]} bold={RANK[cat.rarity] >= RANK.SSR}>
            {`[${cat.rarity}]`}
          </Text>
          <Text>{cat.name}</Text>
          <Text dimColor italic={isCreepy} wrap="truncate-end">
            {`「${say}」`}
          </Text>
        </Box>
        {(five !== null || food !== null) && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
            {five !== null && !isOver && (
              <Box flexDirection="row" columnGap={1}>
                <Text dimColor>5h</Text>
                <Text color={barColor(five.pct)}>{bar(five.pct)}</Text>
                <Text>{`${Math.floor(five.pct)}%`}</Text>
                <Text dimColor>{`· ${countdown} 後重置`}</Text>
              </Box>
            )}
            {isOver && <Text dimColor>5h 已重置</Text>}
            {week !== null && food !== null && (
              <Box flexDirection="row" columnGap={1}>
                <Text dimColor>貓糧(週)</Text>
                <Text color={food.color}>{`${Math.floor(week.pct)}%`}</Text>
                <Text dimColor wrap="truncate-end">
                  {`· ${food.text}`}
                </Text>
              </Box>
            )}
            {shown !== null && <Text color="magenta">（預覽中）</Text>}
          </Box>
        )}
      </Box>
    )
  })
}
