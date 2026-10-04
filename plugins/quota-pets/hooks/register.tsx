import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit, Timer } from 'claude-code'

import type {
  QuotaPetsActivity,
  QuotaPetsBelly,
  QuotaPetsCompaction,
  QuotaPetsLife,
  QuotaPetsLimit,
  QuotaPetsPreview,
  QuotaPetsScene,
} from '../types'

type Rarity = 'N' | 'R' | 'SR' | 'SSR' | 'UR'
type Kind = 'cat' | 'dog'
type Mood = 0 | 1 | 2
type Stage = Mood | 'h1' | 'h2' | 'h3' | 'peek' | 'dead'
type Pools = Readonly<Record<Mood, readonly string[]>>

type Pet = {
  id: string
  name: string
  kind: Kind
  rarity: Rarity
  wrap: (face: string) => string
  lines: Pools
  faces?: Pools
  horrorWrap?: (face: string) => string
  horrorAt?: number
  deadFace?: string
  deadLine?: string
  yawnWrap?: (face: string) => string
  nightLine?: string
  // What the pet says with a full belly, then one about to burst.
  bellyLines?: readonly [string, string]
}

// What the pet talks about when the quota leaves it room: the hour, a long run of work, its belly.
type Aside =
  | { kind: 'night'; time: string }
  | { kind: 'walk'; ms: number }
  | { kind: 'back' }
  | { kind: 'slim'; isAuto: boolean }
  | { kind: 'belly'; stage: 2 | 3 }

// The belly as the band draws it: `fill` is how close auto-compaction is, 1 when it runs.
type BellyView = { pct: number | null; fill: number | null; compacted: QuotaPetsCompaction | null }

// What every cat, or every dog, falls back on when the pet brings nothing of its own.
type Species = {
  label: string
  treat: string
  mood: Pools
  work: readonly string[]
  horror: readonly [readonly string[], readonly string[], readonly string[]]
  peek: readonly string[]
  dead: readonly string[]
  egg: readonly string[]
  horrorLines: readonly [readonly string[], readonly string[], readonly string[], readonly string[]]
  deadLines: readonly string[]
  warnings: readonly [string, string]
  yawn: readonly string[]
  nightLines: readonly string[]
  nightToast: string
  sleepNag: string
  walkLines: readonly string[]
  walkNags: readonly [string, string, string]
  backLines: readonly string[]
  bellyLines: readonly [readonly string[], readonly string[]]
  burpLines: readonly string[]
  slimLines: readonly string[]
}

// Kept in $.store so the collection and pity outlive the session. Each conversation's pet is its own key.
type Save = {
  v: 2
  pity: number
  pulls: number
  treats: Record<Kind, number>
  dex: Record<string, { count: number; deaths: number }>
  history: string[]
}

const limitsAtom = atom({ plugin: 'quota-pets', key: 'limits' } as const, null)
const lifeAtom = atom({ plugin: 'quota-pets', key: 'pet' } as const, null)
const previewAtom = atom({ plugin: 'quota-pets', key: 'preview' } as const, null)
const bellyAtom = atom({ plugin: 'quota-pets', key: 'belly' } as const, null)
const activityAtom = atom({ plugin: 'quota-pets', key: 'activity' } as const, null)

const PITY = 30
const KEEP_LIVES = 50
const MINUTE = 60_000
const HALF_HOUR = 30 * MINUTE
const DAY_MS = 24 * 3600_000
const WEEK_MS = 7 * DAY_MS
// Ten quiet minutes is a break; fifty minutes without one and the pet wants a walk, then asks every half hour.
const BREAK_MS = 10 * MINUTE
const WALK_AFTER = 50 * MINUTE
const WALK_AGAIN = 30 * MINUTE
const BACK_FOR = 10 * MINUTE
const SLIM_FOR = 10 * MINUTE
// Past midnight and before five, the pet is sleepy.
const NIGHT_ENDS = 5

const whiskers = (face: string) => `(=${face}=)`
const floppy = (face: string) => `U${face}U`
const pointy = (face: string) => `V${face}V`

const SPECIES: Readonly<Record<Kind, Species>> = {
  cat: {
    label: '貓',
    treat: '罐罐',
    mood: {
      0: ['^･ω･^', '･ω･', '^‥^', '´∇｀', '≧ω≦', '^ω^', 'ˊᗜˋ', '◕ω◕'],
      1: ['-ω-', '´ω｀', 'ˇωˇ', '˘ω˘', '｡-ω-｡', '_ _'],
      2: ['；ω；', 'ﾟДﾟ', 'ＴωＴ', '°ω°', '´Д｀', '>ω<', '｡>﹏<｡'],
    },
    work: ['｀ω´', 'ˋωˊ', '•ω•'],
    horror: [
      ['⊙ω⊙', 'ʘωʘ', '◉ω◉'],
      ['◉ ◉', '⊙ ⊙', 'ʘ ʘ', 'ಠ ಠ'],
      ['▓ω░', '◉▓◉', '░ω▓', '▒ω▓'],
    ],
    peek: ['|ω・)', '|д゜)', '┃ω◉)', '|◉)', '|ω・) じーっ'],
    dead: ['_(:3 」∠)_ ﾟ･魂･ﾟ', '(=×ω×=) ～魂～', '†(=✖ω✖=)†', '(=x_x=)'],
    egg: ['(=･ω･=)っ◯', '◯⊂(=･ω･=)', '(=ﾟ∀ﾟ=)っ◯'],
    horrorLines: [
      ['…你有聽到嗎…token 一個一個消失的聲音…', '剛剛…是誰在用你的額度…', '今晚的額度…特別安靜呢…'],
      ['我剛剛又數了一次額度…少了一個…', '不要再按 Enter 了…它會聽到…', '你知道額度用完的人…後來都去哪了嗎…'],
      ['額▓度░還█剩…不░多▓了…', '救…救救…我…的…token…', '螢幕…後面…有東西在吃額度…'],
      ['不要回頭……打開你的 usage 頁面看看……', '我一直…都在這裡看著你喔…', '就差一點點了…對吧？…嘻嘻…'],
    ],
    deadLines: ['它…會在 {cd} 後回來…', 'R.I.P. {name}，享年 5 小時', '我先走一步…{cd} 後見…'],
    warnings: ['燈…好像暗了一點…', '它…在看著你…'],
    yawn: ['´ρ｀', '-ρ-', '˘ρ˘', '-ω-'],
    nightLines: ['（打呵欠）都 {time} 了…還不睡喵？', '我先睡了喔…你也早點睡', '半夜寫的 code，明天的你會看不懂喵'],
    nightToast: '已經 {time} 了…寫完這段就去睡吧喵',
    sleepNag: '都 {time} 了，還連續寫了 {m}…真的該睡了喵',
    walkLines: ['已經連續寫 {m}了…起來伸個懶腰嘛喵', '（用肉球拍你的手）{m}了，休息一下啦', '陪我去窗邊曬太陽好不好？都 {m}了'],
    walkNags: [
      '已經連續寫 {m}了，起來走走、喝口水吧喵',
      '（跳上桌子）{m}了！真的該休息了喵',
      '（直接躺在鍵盤上）{m}了…不休息，就別想打字了喵',
    ],
    backLines: ['休息回來了！精神好多了喵', '伸完懶腰了，繼續加油喵'],
    bellyLines: [
      ['肚子好撐…剛剛那些 token 好難消化', '吃太多了喵…要不要 /compact 一下？'],
      ['再吃就要吐了喵…', '肚子快撐破了…毛球要出來了…'],
    ],
    burpLines: ['（吐了一顆毛球）…舒服多了喵', '剛剛吐掉的…是前面的對話嗎？有點想不起來了'],
    slimLines: ['減肥成功！身輕如燕喵', '瘦下來了，又可以吃了喵'],
  },
  dog: {
    label: '狗',
    treat: '骨頭',
    mood: {
      0: ['・ᴥ・', '•ᴥ•', '^ᴥ^', 'ᵔᴥᵔ', '◕ᴥ◕', '≧ᴥ≦', 'ˊᴥˋ', '･ᴥ･'],
      1: ['-ᴥ-', '´ᴥ｀', 'ˇᴥˇ', '˘ᴥ˘', '｡-ᴥ-｡', '_ _'],
      2: ['；ᴥ；', 'ﾟДﾟ', 'ＴᴥＴ', '°ᴥ°', '´Д｀', '>ᴥ<', '｡>﹏<｡'],
    },
    work: ['｀ᴥ´', 'ˋᴥˊ', '•ᴥ•'],
    horror: [
      ['⊙ᴥ⊙', 'ʘᴥʘ', '◉ᴥ◉'],
      ['◉ ◉', '⊙ ⊙', 'ʘ ʘ', 'ಠ ಠ'],
      ['▓ᴥ░', '◉▓◉', '░ᴥ▓', '▒ᴥ▓'],
    ],
    peek: ['|ᴥ・)', '|U・ᴥ)', '┃ᴥ◉)', '|◉)', '|ᴥ・) じーっ'],
    dead: ['_(:3 」∠)_ ﾟ･魂･ﾟ', 'U×ᴥ×U ～魂～', '†U✖ᴥ✖U†', 'Ux_xU'],
    egg: ['U･ᴥ･Uっ◯', '◯⊂U･ᴥ･U', 'Uﾟ∀ﾟUっ◯'],
    horrorLines: [
      ['…汪？（盯著你身後的角落）', '（對著沒有人的那張椅子一直搖尾巴）', '我聞到了…額度快用完的味道…'],
      ['汪汪汪汪！！（對著空無一人的走廊）', '那個角落…有人在用你的額度…汪…', '我剛剛去埋骨頭…挖出來的是…你的 token…'],
      ['汪▓汪░…額█度…', '嗚…嗚嗚…（夾著尾巴，不肯靠近螢幕）', '主▓人░…快…跑…'],
      ['……（牠不叫了。牠只是一直看著你）', '乖…坐下…不要動…嘻嘻…', '你身後…一直都有一隻…你看不到的…'],
    ],
    deadLines: ['（趴下裝死）…{cd} 後再叫我', 'R.I.P. {name}，好狗狗，享年 5 小時', '汪…沒電了…{cd} 後再陪你玩'],
    warnings: ['牠開始對著牆角低吼了…', '牠不叫了…它…在看著你…'],
    yawn: ['´ρ｀', '-ρ-', '˘ᴥ˘', '-ᴥ-'],
    nightLines: ['（打呵欠）主人，{time} 了，該睡覺了汪', '我已經在床邊等你了…', '（把你的拖鞋叼到床邊）'],
    nightToast: '（打了個大呵欠）{time} 了…該睡了汪',
    sleepNag: '（趴在你腳邊睡著了）{time} 了，你也連續寫了 {m}，該睡了',
    walkLines: ['（叼著牽繩）{m}了！散步！散步！', '（坐在門口盯著你）都 {m}了，該出門走走了吧', '汪！{m}了！喝水！站起來！伸展！'],
    walkNags: [
      '（叼著牽繩跑過來）已經連續寫 {m}了，出去走走吧汪',
      '（把牽繩放在你腳上）{m}了…散步…',
      '（咬著你的褲管往門口拖）汪！{m}了！！',
    ],
    backLines: ['散步回來了！汪！精神百倍！', '（尾巴搖不停）休息完了，再來！'],
    bellyLines: [
      ['肚子圓滾滾了汪…', '吃太飽了，想趴著消化一下…要不要 /compact？'],
      ['汪…再塞就要吐了…', '（翻肚躺平）一口都吃不下了…'],
    ],
    burpLines: ['（吐完）…汪，肚子空空的好舒服', '前面聊了什麼…我好像忘了汪'],
    slimLines: ['減肥成功！可以再跑十圈汪', '瘦下來了！（原地轉圈）'],
  },
}

const PETS: readonly Pet[] = [
  {
    id: 'plain',
    name: '普通貓',
    kind: 'cat',
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
    kind: 'cat',
    rarity: 'N',
    wrap: face => `(=  ${face}  =)`,
    bellyLines: ['這點 token 才開胃而已', '好啦…我承認我吃太多了'],
    lines: {
      0: ['今天也是吃飽飽的一天', '罐罐呢？我說罐罐呢？'],
      1: ['剛剛那些 token 好吃嗎？分我一點', '我沒有偷吃額度，是它自己變少的'],
      2: ['我沒有胖，是額度條變寬了', 'token 吃太多了…好撐…'],
    },
  },
  {
    id: 'tuxedo',
    name: '賓士貓',
    kind: 'cat',
    rarity: 'N',
    wrap: face => `(=${face}=)ʚɞ`,
    lines: {
      0: ['穿這麼正式，因為今天要上班', '領結打好了，準備開會喵'],
      1: ['會議中，請勿打擾喵', '這個會議…可以用 email 處理嗎'],
      2: ['這個需求…下週再說好嗎', '西裝都皺了…今天先這樣'],
    },
  },
  {
    id: 'keyboard',
    name: '鍵盤貓',
    kind: 'cat',
    rarity: 'N',
    wrap: face => `[asdf(=${face}=)jkl;]`,
    lines: {
      0: ['asdfghjkl;;;;;;;;;;', '我躺的位置剛好是 Enter，不客氣'],
      1: ['你要打字？可是我在這裡耶', '剛剛幫你 commit 了一些 ;;;;;;'],
      2: ['額度快沒了？那你更不需要鍵盤了', '我躺下去的時候好像按到 Ctrl+C…'],
    },
  },
  {
    id: 'intern',
    name: '實習生貓',
    kind: 'cat',
    rarity: 'N',
    wrap: face => `(=${face}=)ﾉ[實習]`,
    faces: { 0: ['°ω°', '・ω・'], 1: ['°ω°;', '・ω・;'], 2: ['ﾟДﾟ;;', '°Д°;;'] },
    lines: {
      0: ['第一天上班！請問 git 是什麼？', '我 push 到 main 了，這樣對嗎？'],
      1: ['我剛剛跑了 rm -rf…等等，這是什麼意思？', '學長說不能碰 production…那剛剛那個是？'],
      2: ['額度是…要錢的嗎？？', '我只是想試試看 while (true)…'],
    },
  },
  {
    id: 'shades',
    name: '墨鏡貓',
    kind: 'cat',
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
    kind: 'cat',
    rarity: 'R',
    wrap: face => `(=${face}=)っ旦`,
    nightLine: '{time} 了…這個時間寫的 bug 特別多喔',
    lines: {
      0: ['這個 bug 不是我寫的喵', '今天也要準時下班（不可能）'],
      1: ['在我的電腦上是好的啊', '先寫個 TODO，之後再說'],
      2: ['先 revert 再說', '這是 feature，不是 bug'],
    },
  },
  {
    id: 'black',
    name: '黑貓',
    kind: 'cat',
    rarity: 'R',
    wrap: whiskers,
    horrorAt: 70,
    faces: { 0: ['ↀωↀ', 'ↀ‿ↀ'], 1: ['ↀωↀ', 'ↀ_ↀ'], 2: ['ↀ∀ↀ', 'ↀωↀ'] },
    nightLine: '深夜 {time}…正是我最喜歡的時段…',
    lines: {
      0: ['我只是隻普通的黑貓…真的', '聽說看到黑貓會帶來…算了，沒事'],
      1: ['要不要聽個故事？關於一個用光額度的人…', '今晚月色真美…額度也是'],
      2: ['快到了…我最喜歡的部分…', '再一點點…就可以開始講鬼故事了…'],
    },
  },
  {
    id: 'pm',
    name: 'PM貓',
    kind: 'cat',
    rarity: 'R',
    wrap: face => `(=${face}=)っ[需求]`,
    deadLine: '這個 sprint 先到這，{cd} 後開檢討會',
    nightLine: '{time} 了還在改？需求明天再說啦',
    lines: {
      0: ['這個很簡單吧？明天上線', '我不懂技術，但為什麼要這麼久？'],
      1: ['客戶說要改一下，就一下下', '這個需求跟上次的不衝突吧？（衝突）'],
      2: ['額度不夠？那就用愛發電', '時程不變，需求再加三個'],
    },
  },
  {
    id: 'lucky',
    name: '招財貓',
    kind: 'cat',
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
    kind: 'cat',
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
    kind: 'cat',
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
    id: 'liquid',
    name: '液態貓',
    kind: 'cat',
    rarity: 'SSR',
    // Cats are liquid: the lower the quota, the further it spreads.
    wrap: face => face,
    faces: {
      0: ['(=^ω^=)', '(=･ω･=)'],
      1: ['~(=-ω-=)~', '~(=˘ω˘=)~'],
      2: ['~~~(=_ω_=)~~~', '~~~(=；ω；=)~~~'],
    },
    horrorWrap: face => `~~~~(=${face}=)~~~~`,
    yawnWrap: face => `~~(=${face}=)~~`,
    deadFace: '～～～～～～～～',
    deadLine: '貓是液體，這下證實了。{cd} 後請把我倒回來',
    lines: {
      0: ['我是固體，暫時的', '把我放進什麼容器，我就是什麼形狀'],
      1: ['開始…有點…融化了…', '額度在流失，我也在流'],
      2: ['我已經是液體了，請拿杯子', '別踩到我，我攤在地上'],
    },
  },
  {
    id: 'god',
    name: '貓神',
    kind: 'cat',
    rarity: 'UR',
    wrap: face => `✧˖°(=${face}=)°˖✧`,
    nightLine: '凡人，{time} 了，吾命汝就寢',
    lines: {
      0: ['吾乃額度之神，跪下', '凡人，汝的額度吾已過目'],
      1: ['吾亦無法幫你加額度', '神也是要看帳單的'],
      2: ['吾…也想下班了', '神蹟？沒有，只有 rate limit'],
    },
  },
  {
    id: 'mutt',
    name: '米克斯',
    kind: 'dog',
    rarity: 'N',
    wrap: floppy,
    lines: {
      0: ['今天也在 7-11 門口顧店，自動門一開我就醒', '巡邏完畢，你的 repo 很安全汪'],
      1: ['剛剛那台機車我追過了，額度我追不到', '有陌生的 process 在跑，要我去咬嗎？'],
      2: ['汪！額度剩不多了！汪！', '我叫了三次了，你都沒在聽'],
    },
  },
  {
    id: 'shiba',
    name: '柴犬',
    kind: 'dog',
    rarity: 'N',
    wrap: pointy,
    lines: {
      0: ['不要。（柴犬學會的第一個詞）', '我很乖，只是不想聽你的'],
      1: ['要我 refactor？不要。', '說不走就不走（整隻趴在額度條上）'],
      2: ['柴之嗚嗚嗚嗚——（被拖著走）', '不寫了，拖我也沒用'],
    },
  },
  {
    id: 'dachshund',
    name: '臘腸狗',
    kind: 'dog',
    rarity: 'N',
    wrap: face => `U${face}U═╤════╤═~`,
    bellyLines: ['吃下去的 token 還在肚子裡排隊', '身體太長，吃的東西還沒到屁股就滿了…'],
    lines: {
      0: ['我的身體跟你的 stack trace 一樣長', '我很長，請耐心看完我'],
      1: ['頭已經到了，屁股還在上一個 commit', '你的 log 跟我一樣，越拉越長'],
      2: ['剩下的額度，比我的腿還短', '屁股還沒到，額度就先沒了'],
    },
  },
  {
    id: 'single',
    name: '單身狗',
    kind: 'dog',
    rarity: 'N',
    wrap: face => `U${face}U ♡?`,
    deadFace: 'U×ᴥ×U ♡…',
    deadLine: '一個人來，一個人走。{cd} 後一個人回來',
    lines: {
      0: ['我不孤單，我有你跟你的 terminal', 'pair programming？我一直都是 solo programming'],
      1: ['你也是一個人在寫 code 嗎？握爪', '別人在約會，我們在 debug'],
      2: ['額度跟我的感情一樣，快沒了', '連額度都要離開我了嗎…'],
    },
  },
  {
    id: 'salaryman',
    name: '社畜狗',
    kind: 'dog',
    rarity: 'N',
    wrap: face => `U${face}U [加班中]`,
    faces: { 0: ['-ᴥ-', '˘ᴥ˘'], 1: ['ˇᴥˇ', '_ᴥ_'], 2: ['×ᴥ×;', 'ﾟДﾟ;'] },
    deadLine: '過勞了…{cd} 後打卡上班',
    nightLine: '凌晨 {time}，責任制的夜晚才剛開始…',
    lines: {
      0: ['累得跟狗一樣，我就是那隻狗', '早安，今天也是責任制的一天'],
      1: ['責任制：責任是我的，制度是你的', '下班？那是什麼新的 API 嗎'],
      2: ['加班費可以用額度折抵嗎？', '我不是在工作，就是在去工作的路上'],
    },
  },
  {
    id: 'husky',
    name: '哈士奇',
    kind: 'dog',
    rarity: 'R',
    wrap: pointy,
    faces: { 0: ['◕ᴥ◔', 'ºᴥ◉'], 1: ['◔ᴥ◕', '-ᴥ◉'], 2: ['◉Д◔', 'ºДº'] },
    lines: {
      0: ['沙發是我拆的，這個 repo 我也拆了', '我剛剛踩過鍵盤，好像按到 git push --force'],
      1: ['嗷嗚～～（不明所以地嚎叫）', '你說不能 force push？嗷嗚？'],
      2: ['嗷嗚嗚嗚——額度——嗚——', '家拆完了，額度也拆完了'],
    },
  },
  {
    id: 'golden',
    name: '黃金獵犬',
    kind: 'dog',
    rarity: 'R',
    wrap: face => `U${face}Uﾉ LGTM`,
    lines: {
      0: ['這個 PR 我看都沒看，LGTM！', '你寫的 code 都好棒！（每次都這樣說）'],
      1: ['Approve！Approve！全部 Approve！', 'CI 紅了？沒關係，你最棒了！'],
      2: ['額度快沒了…但你還是最棒的！', 'LGTM…（尾巴搖得有點慢了）'],
    },
  },
  {
    id: 'chihuahua',
    name: '吉娃娃',
    kind: 'dog',
    rarity: 'R',
    wrap: face => `((V${face}V))`,
    faces: { 0: ['ºᴥº', '°ᴥ°'], 1: ['ºᴥº;', '°ᴥ°;'], 2: ['ºДº;;', '°Д°;;'] },
    lines: {
      0: ['（發抖）我、我沒有在怕', '汪汪汪汪！（對著你的游標狂吠）'],
      1: ['汪汪汪！（對著 rate limit 狂吠）', '我是在發抖沒錯，但不是因為額度'],
      2: ['汪汪汪汪汪汪汪汪！！！', '我抖得比你的 flaky test 還不穩'],
    },
  },
  {
    id: 'simp',
    name: '舔狗',
    kind: 'dog',
    rarity: 'R',
    wrap: face => `U${face}U ♡♡`,
    faces: { 0: ['♡ᴥ♡', '◕ᴥ◕'], 1: ['♡ᴥ♡', '｡♡ᴥ♡｡'], 2: ['；ᴥ；', '♡Д♡;'] },
    deadLine: '我把額度全給你了…{cd} 後再來找你',
    lines: {
      0: ['你已讀不回我的 PR…沒關係，我再改一版', '你說要 refactor，我連夜重寫了三遍'],
      1: ['你的 bug 我都幫你扛', '你 force push 蓋掉我的 commit…一定有你的理由'],
      2: ['額度都給你用，我不需要', '舔到最後一無所有…但我還是想 approve 你'],
    },
  },
  {
    id: 'watchdog',
    name: '看門狗',
    kind: 'dog',
    rarity: 'R',
    wrap: face => `V${face}V [watchdog]`,
    deadLine: 'watchdog timeout。系統將於 {cd} 後重啟',
    lines: {
      0: ['watchdog 運作中，一切正常汪', '汪！偵測到未授權的 force push'],
      1: ['心跳檢查…你還活著嗎？', '你很久沒回應了，要不要幫你重啟'],
      2: ['watchdog timer 快逾時了…', '汪汪汪！額度異常！準備重啟！'],
    },
  },
  {
    id: 'doge',
    name: '狗狗幣',
    kind: 'dog',
    rarity: 'SR',
    wrap: face => `V${face}VっÐ`,
    faces: { 0: ['◔ᴥ◔', '◕ᴥ◕'], 1: ['◔ᴥ◔', '¬ᴥ¬'], 2: ['◔Д◔', '¬Д¬'] },
    lines: {
      0: ['很 code。非常 wow。', '哇。額度。好多。'],
      1: ['很燒。非常 token。wow。', 'to the moon！（指的是額度用量）'],
      2: ['很慌。非常沒額度。wow。', '狗狗幣跌了，額度也跌了'],
    },
  },
  {
    id: 'hachiko',
    name: '忠犬八公',
    kind: 'dog',
    rarity: 'SR',
    wrap: face => `U${face}U ◷`,
    deadFace: 'U˘ᴥ˘U ◷…',
    deadLine: '沒關係，我很會等。{cd} 後額度就回來了',
    nightLine: '再晚我都會等你…可是 {time} 了，該睡了',
    lines: {
      0: ['你回來了！我一直在等你', '不管你去哪裡，我都在這裡等'],
      1: ['我在等…等你把這個 bug 修好', '你今天也會回來寫 code 對吧'],
      2: ['就算額度用完，我也會等', '等額度回來…我很會等的'],
    },
  },
  {
    id: 'hotdog',
    name: '熱狗',
    kind: 'dog',
    rarity: 'SR',
    wrap: face => `⊂(U${face}U)⊃`,
    deadFace: '⊂(U×ᴥ×U)⊃ 焦',
    deadLine: '烤過頭了。{cd} 後換一根新的',
    lines: {
      0: ['剛出爐的熱狗，溫度剛好', '要加芥末還是番茄醬？'],
      1: ['額度燒成這樣，我都變熱狗了', 'CPU 好燙…我快熟了'],
      2: ['烤焦了…是額度的味道', '我已經熟透了，可以上桌了'],
    },
  },
  {
    id: 'strategist',
    name: '狗頭軍師',
    kind: 'dog',
    rarity: 'SR',
    wrap: face => `V${face}Vﾉ扇`,
    deadLine: '此乃天意，非戰之罪 [狗頭]。{cd} 後再獻計',
    lines: {
      0: ['這段 code 寫得真好 [狗頭]', '不用寫測試啦，上線再說 [狗頭]'],
      1: ['額度還很多，盡量用 [狗頭]', '直接 push 到 main 最快了 [狗頭]'],
      2: ['額度快沒了？那就再開一個帳號 [狗頭]', '我早就料到了，只是沒說 [狗頭]'],
    },
  },
  {
    id: 'cerberus',
    name: '地獄三頭犬',
    kind: 'dog',
    rarity: 'SSR',
    wrap: face => `V${face}VV${face}VV-ᴥ-V`,
    horrorWrap: face => `V${face}VV${face}VV${face}V`,
    horrorAt: 70,
    deadFace: 'V×ᴥ×VV×ᴥ×VV×ᴥ×V',
    deadLine: '三顆頭同時下班了…{cd} 後一起回來',
    lines: {
      0: ['一顆頭寫 code，一顆 review，一顆在睡', '三顆頭，三倍可愛，三倍額度'],
      1: ['三顆頭在吵要不要 refactor', '我負責看守額度的大門，汪汪汪'],
      2: ['三顆頭都在喊餓…是額度不夠的那種餓', '左邊那顆說牠還想再跑一次 test'],
    },
  },
  {
    id: 'tiangou',
    name: '天狗',
    kind: 'dog',
    rarity: 'UR',
    wrap: face => `✧˖°V${face}Vっ☾`,
    deadFace: '✧˖°V×ᴥ×V ☽ﾟ･',
    deadLine: '月亮吐回去了…{cd} 後吾再來吃',
    nightLine: '{time} 了，吾要去吃月亮，汝該睡了',
    bellyLines: ['吾連月亮都吃得下…這點 token…嗝', '連吾都吃不下了…再吃要把月亮吐出來了'],
    lines: {
      0: ['吾乃天狗，連月亮都吃得下，額度算什麼', '今晚的月亮，是吾吃掉的'],
      1: ['天狗食月，順便食額度', '月亮吃完了，接下來吃你的 token'],
      2: ['吃太多月亮…有點撐…', '連吾都吃不下了…你的額度呢？'],
    },
  },
]

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
  SSR: 'warning',
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

function petById(id: string): Pet {
  return PETS.find(pet => pet.id === id) ?? (PETS[0] as Pet)
}

function portrait(pet: Pet): string {
  return pet.wrap(pick((pet.faces ?? SPECIES[pet.kind].mood)[0], pet.id))
}

// The usage panel rounds up (23.2% reads 24%), so the band does too.
function pctText(pct: number): string {
  return `${Math.ceil(pct)}%`
}

function toLimit(limit: SessionRateLimit | undefined): QuotaPetsLimit | null {
  if (limit === undefined) return null
  const at = limit.resetsAt === undefined ? Number.NaN : Date.parse(limit.resetsAt)
  return { pct: limit.percentUsed, resetsAt: Number.isFinite(at) ? at : null }
}

function stageOf(pct: number, pet: Pet): Stage {
  if (pct >= 100) return 'dead'
  if (pct >= 99) return 'peek'
  if (pct >= 95) return 'h3'
  if (pct >= 90) return 'h2'
  if (pct >= (pet.horrorAt ?? 85)) return 'h1'
  if (pct >= 60) return 2
  if (pct >= 30) return 1
  return 0
}

function faceOf(pet: Pet, stage: Stage, seed: number, isWorking: boolean): string {
  const species = SPECIES[pet.kind]
  if (stage === 'dead') return pet.deadFace ?? pick(species.dead, pet.id, seed)
  if (stage === 'peek') return pick(species.peek, pet.id, seed)
  if (stage === 'h1' || stage === 'h2' || stage === 'h3') {
    const pool = species.horror[stage === 'h1' ? 0 : stage === 'h2' ? 1 : 2]
    return (pet.horrorWrap ?? pet.wrap)(pick(pool, pet.id, seed))
  }
  const pool = pet.faces?.[stage] ?? (isWorking ? species.work : species.mood[stage])
  return pet.wrap(pick(pool, pet.id, seed))
}

function sayOf(pet: Pet, stage: Stage, seed: number, countdown: string): string {
  const species = SPECIES[pet.kind]
  if (stage === 'dead') {
    const line = pet.deadLine ?? pick(species.deadLines, pet.id, seed)
    return line.replace('{cd}', countdown).replace('{name}', pet.name)
  }
  if (stage === 'peek') return pick(species.horrorLines[3], seed)
  if (stage === 'h1') return pick(species.horrorLines[0], seed)
  if (stage === 'h2') return pick(species.horrorLines[1], seed)
  if (stage === 'h3') return pick(species.horrorLines[2], seed)
  return pick(pet.lines[stage], pet.id, seed)
}

// Minutes round up, as the usage panel's countdown does.
function dur(ms: number): string {
  const minutes = Math.max(0, Math.ceil(ms / 60_000))
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

function countdownOf(five: QuotaPetsLimit | null, now: number): string {
  return five?.resetsAt == null ? '幾小時' : dur(five.resetsAt - now)
}

function bar(pct: number): string {
  const filled = Math.min(10, Math.max(0, Math.round(pct / 10)))
  return '█'.repeat(filled) + '░'.repeat(10 - filled)
}

function barColor(pct: number): string {
  return pct >= 85 ? 'error' : pct >= 60 ? 'warning' : 'success'
}

// Which of the week's seven days it is, counted from the last restock.
function dayOf(left: number): number {
  return Math.max(0, Math.min(6, Math.floor((WEEK_MS - left) / DAY_MS)))
}

// The week's food is seven days' worth: the line compares the day being eaten with the day it is.
function foodLine(week: QuotaPetsLimit, now: number): { text: string; color: string } {
  const left = week.resetsAt === null ? null : Math.max(0, week.resetsAt - now)
  const restock = left === null ? '' : `（${dur(left)}後補貨）`
  if (left === 0) return { text: '補貨了！等下一筆資料', color: 'success' }
  if (week.pct >= 100) return { text: `吃光了…這週剩下的日子…牠們要吃什麼…${restock}`, color: 'error' }
  if (week.pct >= 90) return { text: `只剩袋底了…袋子裡…好像有東西在動…${restock}`, color: 'error' }
  if (left === null) return { text: '還夠吃', color: 'success' }
  if (week.pct <= 0 || WEEK_MS - left < 3 * 3600_000) return { text: `滿滿一整袋${restock}`, color: 'success' }
  const eaten = (week.pct * 7) / 100
  const ahead = Math.floor(eaten) - dayOf(left)
  // The restock time only shows on the last day, to keep the band short.
  const tail = left < DAY_MS ? restock : ''
  if (ahead >= 2) return { text: `偷吃到${ahead === 2 ? '後天' : `${ahead} 天後`}的份了${tail}`, color: 'warning' }
  if (ahead === 1) return { text: `在偷吃明天的份${tail}`, color: 'warning' }
  if (left < DAY_MS && 7 - eaten >= 1.5) {
    return { text: `最後一天還剩 ${Math.round(7 - eaten)} 天份，吃大餐！${restock}`, color: 'success' }
  }
  if (ahead === 0) return { text: `照進度在吃${tail}`, color: 'success' }
  return { text: `存了 ${-ahead} 天份${tail}`, color: 'success' }
}

// The week's food as seven ghosts, one per day, that Pac-Man eats in order; each one eaten leaves a dot.
// Blue: a day that has come. Dim: a day still ahead. Yellow: a day eaten before it came. Red: the last of the food.
function lane(week: QuotaPetsLimit, now: number, isScary: boolean): { glyph: string; color?: string }[] {
  const eaten = Math.min(7, (week.pct * 7) / 100)
  const done = Math.min(7, Math.floor(eaten + 1e-9))
  const today = week.resetsAt === null ? 6 : dayOf(Math.max(0, week.resetsAt - now))
  const dots = Array.from({ length: done }, (_, day) => (day > today ? { glyph: '·', color: 'warning' } : { glyph: '·' }))
  const ghosts = Array.from({ length: 7 - done }, (_, index) => {
    const day = done + index
    if (isScary) return { glyph: 'ᗣ', color: 'error' }
    if (day <= today) return { glyph: 'ᗣ', color: 'blue' }
    return eaten > day ? { glyph: 'ᗣ', color: 'warning' } : { glyph: 'ᗣ' }
  })
  return [...dots, { glyph: 'ᗧ', color: 'warning' }, ...ghosts]
}

// Read in the machine's own time zone: the pet keeps the person's hours.
function isNight(now: number): boolean {
  return new Date(now).getHours() < NIGHT_ENDS
}

function clockText(now: number): string {
  const date = new Date(now)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

// The night a moment belongs to, so the pet says goodnight once a night.
function nightOf(now: number): string {
  const date = new Date(now)
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

// A run of work as the pet says it: 52 分鐘, 1 小時 10 分.
function spanText(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE))
  if (minutes < 60) return `${minutes} 分鐘`
  const rest = minutes % 60
  return rest === 0 ? `${Math.floor(minutes / 60)} 小時` : `${Math.floor(minutes / 60)} 小時 ${rest} 分`
}

function tokensText(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)
}

// How long this run of work has gone on; 0 once it has been quiet long enough to count as a break.
function streakOf(activity: QuotaPetsActivity | null, now: number): number {
  return activity !== null && now - activity.last < BREAK_MS ? now - activity.since : 0
}

// How close the context is to auto-compaction: 1 when it runs (the whole window when it is off or unknown).
function fillOf(belly: QuotaPetsBelly): number | null {
  const full = belly.threshold ?? belly.window
  return belly.tokens === null || full <= 0 ? null : belly.tokens / full
}

function bellyStage(fill: number | null): 0 | 1 | 2 | 3 {
  if (fill === null) return 0
  if (fill >= 0.9) return 3
  if (fill >= 0.75) return 2
  return fill >= 0.5 ? 1 : 0
}

function gauge(fill: number): string {
  const filled = Math.min(5, Math.max(0, Math.round(fill * 5)))
  return '●'.repeat(filled) + '○'.repeat(5 - filled)
}

const NO_BELLY: BellyView = { pct: null, fill: null, compacted: null }

// The belly the band draws: this conversation's, or the one a preview acts out.
function bellyOf(held: QuotaPetsBelly | null, conv: number, shown: QuotaPetsPreview | null, now: number): BellyView {
  const scene = shown?.scene ?? null
  if (scene === 'belly') {
    const pct = shown?.belly ?? 85
    const full = held !== null && held.threshold !== null && held.window > 0 ? held.threshold / held.window : 1
    return { pct, fill: pct / 100 / full, compacted: null }
  }
  if (scene === 'burp' || scene === 'slim') {
    return { pct: null, fill: null, compacted: { at: now, isAuto: scene === 'burp', before: 167_000, after: 23_000 } }
  }
  if (held === null || held.conv !== conv) return NO_BELLY
  return { pct: held.pct, fill: fillOf(held), compacted: held.compacted }
}

// The belly's cell in the band: how full it is, or that a compaction just emptied it.
function bellyCell(belly: BellyView, now: number): { gauge: string; text: string; color: string } | null {
  if (belly.pct !== null && belly.fill !== null) {
    const stage = bellyStage(belly.fill)
    return { gauge: gauge(belly.fill), text: `${belly.pct}%`, color: stage >= 3 ? 'error' : stage >= 2 ? 'warning' : 'success' }
  }
  if (belly.compacted !== null && now - belly.compacted.at < SLIM_FOR) {
    return { gauge: gauge(0), text: belly.compacted.isAuto ? '剛吐完' : '剛減肥完', color: 'success' }
  }
  return null
}

function bellyAside(belly: BellyView): Aside | null {
  const stage = bellyStage(belly.fill)
  return stage === 2 || stage === 3 ? { kind: 'belly', stage } : null
}

// What the pet brings up, most pressing first: bedtime, a walk, coming back from one, a compaction, a full belly.
function asideOf(now: number, activity: QuotaPetsActivity | null, belly: BellyView): Aside | null {
  if (isNight(now)) return { kind: 'night', time: clockText(now) }
  const streak = streakOf(activity, now)
  if (streak >= WALK_AFTER) return { kind: 'walk', ms: streak }
  if (activity !== null && activity.back !== null && now - activity.back < BACK_FOR) return { kind: 'back' }
  if (belly.compacted !== null && now - belly.compacted.at < SLIM_FOR) return { kind: 'slim', isAuto: belly.compacted.isAuto }
  return bellyAside(belly)
}

function sceneAside(scene: QuotaPetsScene, now: number, belly: BellyView): Aside | null {
  if (scene === 'night') return { kind: 'night', time: isNight(now) ? clockText(now) : '02:17' }
  if (scene === 'walk') return { kind: 'walk', ms: 52 * MINUTE }
  if (scene === 'back') return { kind: 'back' }
  if (scene === 'burp' || scene === 'slim') return { kind: 'slim', isAuto: scene === 'burp' }
  return bellyAside(belly)
}

function yawnOf(pet: Pet, seed: number): string {
  return `${(pet.yawnWrap ?? pet.wrap)(pick(SPECIES[pet.kind].yawn, pet.id, seed))} zZ`
}

function asideLine(pet: Pet, aside: Aside, seed: number): string {
  const species = SPECIES[pet.kind]
  if (aside.kind === 'night') return (pet.nightLine ?? pick(species.nightLines, pet.id, seed)).replace('{time}', aside.time)
  if (aside.kind === 'walk') return pick(species.walkLines, pet.id, seed).replace('{m}', spanText(aside.ms))
  if (aside.kind === 'back') return pick(species.backLines, pet.id, seed)
  if (aside.kind === 'slim') return pick(aside.isAuto ? species.burpLines : species.slimLines, pet.id, seed)
  const isBursting = aside.stage === 3
  const own = isBursting ? pet.bellyLines?.[1] : pet.bellyLines?.[0]
  return own ?? pick(isBursting ? species.bellyLines[1] : species.bellyLines[0], pet.id, seed)
}

function bellyToast(pet: Pet, pct: number | null, hasThreshold: boolean): string {
  const tail = hasThreshold ? '再吃就要吐了（快要自動壓縮了）' : '可以 /compact 幫牠消化一下'
  return `${portrait(pet)} 肚子快撐爆了（context ${pct ?? '?'}%）…${tail}`
}

function slimToast(pet: Pet, compacted: QuotaPetsCompaction): string {
  const { isAuto, before, after } = compacted
  const change = before !== null && after !== null ? `肚子從 ${tokensText(before)} ${isAuto ? '縮' : '瘦'}到 ${tokensText(after)}` : ''
  return isAuto
    ? `${portrait(pet)} 撐到吐了…（自動壓縮）${change}`
    : `${portrait(pet)} 減肥成功！${change === '' ? '身輕如燕' : change}`
}

function walkToast(pet: Pet, ms: number, nags: number, now: number): string {
  const species = SPECIES[pet.kind]
  const m = spanText(ms)
  if (isNight(now)) return `${yawnOf(pet, now)} ${species.sleepNag.replace('{time}', clockText(now)).replace('{m}', m)}`
  return `${portrait(pet)} ${(species.walkNags[Math.min(nags, 2)] ?? '').replace('{m}', m)}`
}

function nightToast(pet: Pet, now: number): string {
  return `${yawnOf(pet, now)} ${SPECIES[pet.kind].nightToast.replace('{time}', clockText(now))}`
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

function rollPet(rarity: Rarity = rollRarity()): Pet {
  return chance(PETS.filter(pet => pet.rarity === rarity))
}

function pull(save: Save): Pet {
  save.pity += 1
  save.pulls += 1
  const rarity = save.pity >= PITY ? (Math.random() < 0.2 ? 'UR' : 'SSR') : rollRarity()
  if (rarity === 'SSR' || rarity === 'UR') save.pity = 0
  return rollPet(rarity)
}

function owned(save: Save, kind?: Kind): number {
  return PETS.filter(pet => (kind === undefined || pet.kind === kind) && (save.dex[pet.id]?.count ?? 0) > 0).length
}

// Puts a pulled pet in the dex; a duplicate becomes its species' treat.
function collect(save: Save, pet: Pet): string {
  const seen = save.dex[pet.id]?.count ?? 0
  save.dex[pet.id] = { count: seen + 1, deaths: save.dex[pet.id]?.deaths ?? 0 }
  const { label, treat } = SPECIES[pet.kind]
  if (seen === 0) return `新${label}入手！圖鑑 ${owned(save)}/${PETS.length}`
  save.treats[pet.kind] += 1
  return `重複！自動分解成${treat} ×1，${treat}沒有任何用途`
}

function remember(save: Save, pet: Pet, title: string): void {
  save.history = [`[${pet.rarity}] ${title}`, ...save.history].slice(0, 8)
}

function announce($: EngineInterface, save: Save, pet: Pet, title: string, extra: string): void {
  const luck = chance(LUCK[pet.rarity])
  remember(save, pet, title)
  $.ui.toast(`${portrait(pet)} [${pet.rarity}] ${title} ── ${luck}`, { timeoutMs: 12_000 })
  $.ui.log(`扭蛋 [${pet.rarity}] ${title} ── ${luck}｜${extra}`)
}

let queue: Promise<unknown> = Promise.resolve()

// Measurements, turn starts and commands all touch the save: one at a time.
function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job)
  queue = run.catch(() => undefined)
  return run
}

async function load($: EngineInterface): Promise<Save> {
  const raw = (await $.store.get('save')) as Partial<Save> | undefined
  if (raw !== undefined && raw.v === 2) return raw as Save
  const save: Save = {
    v: 2,
    pity: 0,
    pulls: 0,
    treats: { cat: 0, dog: 0 },
    dex: {},
    history: ['扭蛋機到貨：貓狗混池，每個對話抽一隻'],
  }
  await $.store.set('save', save)
  return save
}

function lifeKey(conv: number): string {
  return `life:${conv}`
}

// The warnings a pet arriving this late in the window would already have shown.
function warnedAt(pet: Pet, pct: number | null): number {
  if (pct === null) return 0
  if (pct >= 95) return 2
  return pct >= (pet.horrorAt ?? 85) ? 1 : 0
}

// A new conversation pulls its own pet; one pulled after the quota ran out is dead on arrival.
// An ordinary pull is quiet (the band shows the pet, /petdex keeps it); dead on arrival is announced.
function hatch($: EngineInterface, save: Save, conv: number, five: QuotaPetsLimit | null, now: number): QuotaPetsLife {
  const pet = pull(save)
  const extra = collect(save, pet)
  const isDead = five !== null && five.pct >= 100
  if (isDead) {
    const entry = save.dex[pet.id] ?? { count: 1, deaths: 0 }
    save.dex[pet.id] = { ...entry, deaths: entry.deaths + 1 }
  }
  const title = isDead
    ? `新對話抽到${pet.name}…但額度已經用完，牠一出蛋就陣亡了（${countdownOf(five, now)} 後轉生）`
    : `新對話，新扭蛋：${pet.name}`
  if (isDead) announce($, save, pet, title, extra)
  else remember(save, pet, title)

  return {
    conv,
    id: pet.id,
    since: now,
    isDead,
    window: five?.resetsAt ?? null,
    lastPct: five?.pct ?? null,
    warned: warnedAt(pet, five?.pct ?? null),
  }
}

function isNewWindow(life: QuotaPetsLife, five: QuotaPetsLimit): boolean {
  if (life.window !== null && five.resetsAt !== null) {
    return five.resetsAt - life.window > HALF_HOUR
  }
  return life.lastPct !== null && five.pct + 20 < life.lastPct
}

function reincarnate($: EngineInterface, save: Save, life: QuotaPetsLife, now: number): QuotaPetsLife {
  const old = petById(life.id)
  const pet = pull(save)
  const extra = collect(save, pet)
  const isSame = pet.id === old.id
  const isCross = pet.kind !== old.kind
  const title = life.isDead
    ? `《關於我額度用完後${isCross ? '跨物種' : ''}轉生成${isSame ? '…還是' : ''}${pet.name}這檔事》`
    : isSame
      ? `交班：${old.name} 下班了，結果接班的還是${pet.name}`
      : `交班：${old.name} 下班了，${pet.name} 接手${isCross ? `（換${SPECIES[pet.kind].label}顧店了）` : ''}`
  announce($, save, pet, title, extra)

  return { ...life, id: pet.id, since: now, isDead: false, warned: 0 }
}

// Death at 100%, and the two creepy warnings on the way there.
function mourn($: EngineInterface, save: Save, life: QuotaPetsLife, five: QuotaPetsLimit, now: number): QuotaPetsLife {
  const pet = petById(life.id)
  const species = SPECIES[pet.kind]
  if (five.pct >= 100 && !life.isDead) {
    const entry = save.dex[pet.id] ?? { count: 1, deaths: 0 }
    save.dex[pet.id] = { ...entry, deaths: entry.deaths + 1 }
    $.ui.toast(`(✖╭╮✖) ${pet.name} 陣亡了…${countdownOf(five, now)} 後轉生，到時候會抽到誰呢…`, {
      timeoutMs: 10_000,
    })
    $.ui.log(`陣亡 ${pet.name}（上工 ${dur(now - life.since)}）`)
    return { ...life, isDead: true }
  }
  if (five.pct >= 95 && five.pct < 100 && life.warned < 2) {
    $.ui.toast(`${species.peek[0]} 額度 ${pctText(five.pct)}…${species.warnings[1]}`, { timeoutMs: 8000 })
    return { ...life, warned: 2 }
  }
  if (five.pct >= (pet.horrorAt ?? 85) && five.pct < 95 && life.warned < 1) {
    const face = (pet.horrorWrap ?? pet.wrap)(species.horror[0][0] ?? '')
    $.ui.toast(`${face} 額度 ${pctText(five.pct)}…${species.warnings[0]}`, { timeoutMs: 8000 })
    return { ...life, warned: 1 }
  }
  return life
}

// Keeps the newest conversations' pets so a resumed conversation finds its own.
async function prune($: EngineInterface): Promise<void> {
  const lives = (await $.store.keys()).filter(key => key.startsWith('life:'))
  const stale = lives.sort((a, b) => Number(a.slice(5)) - Number(b.slice(5))).slice(0, -KEEP_LIVES)
  for (const key of stale) await $.store.delete(key)
}

// This conversation's pet: the one already out, the one a resumed conversation left, or a new pull.
async function lifeOf(
  $: EngineInterface,
  save: Save,
  conv: number,
  five: QuotaPetsLimit | null,
  now: number,
): Promise<QuotaPetsLife> {
  const held = await read($, lifeAtom)
  if (held !== null && held.conv === conv) return held
  const kept = (await $.store.get(lifeKey(conv))) as QuotaPetsLife | undefined
  if (kept !== undefined && kept.conv === conv && PETS.some(pet => pet.id === kept.id)) return kept
  const life = hatch($, save, conv, five, now)
  await prune($)
  return life
}

async function ingest($: EngineInterface, rateLimits: readonly SessionRateLimit[]): Promise<void> {
  const five = toLimit(rateLimits.find(limit => limit.kind === 'five_hour'))
  const week = toLimit(rateLimits.find(limit => limit.kind === 'seven_day'))
  if (five !== null || week !== null) await update($, limitsAtom, () => ({ five, week }))

  const { startedAt: conv } = await $.session.usage()
  const now = await $.clock.now()
  const save = await load($)
  const before = JSON.stringify(save)
  let life = await lifeOf($, save, conv, five, now)
  if (five !== null) {
    if (isNewWindow(life, five)) life = reincarnate($, save, life, now)
    if (five.resetsAt !== null && (life.window === null || five.resetsAt > life.window)) {
      life = { ...life, window: five.resetsAt }
    }
    life = { ...mourn($, save, life, five, now), lastPct: five.pct }
  }
  if (JSON.stringify(save) !== before) await $.store.set('save', save)
  await $.store.set(lifeKey(conv), life)
  await update($, lifeAtom, () => life)
}

async function petNow($: EngineInterface): Promise<Pet | null> {
  const life = await read($, lifeAtom)
  return life === null ? null : petById(life.id)
}

// A new reading of the context window: the belly fills, and says so once when it is about to burst.
async function digest($: EngineInterface, context: SessionContextUsage): Promise<void> {
  const { startedAt: conv } = await $.session.usage()
  const prior = await read($, bellyAtom)
  const isSame = prior !== null && prior.conv === conv
  const { window, percent } = context
  const tokens = context.tokens ?? (percent === undefined ? null : Math.round((percent / 100) * window))
  const pct = percent ?? (tokens === null || window <= 0 ? null : Math.round((tokens / window) * 100))
  let belly: QuotaPetsBelly = {
    conv,
    tokens,
    pct,
    window,
    threshold: prior !== null && prior.window === window ? prior.threshold : null,
    warned: isSame && prior.warned,
    compacted: isSame ? prior.compacted : null,
  }
  const stage = bellyStage(fillOf(belly))
  if (stage === 3 && !belly.warned) {
    const pet = await petNow($)
    if (pet !== null) $.ui.toast(bellyToast(pet, pct, belly.threshold !== null), { timeoutMs: 10_000 })
    belly = { ...belly, warned: true }
  } else if (stage < 2 && belly.warned) {
    belly = { ...belly, warned: false }
  }
  await update($, bellyAtom, () => belly)
}

// The windows whose compaction threshold was already asked for, so a session with it off asks once.
const learned = new Set<number>()

// The token count auto-compaction runs at, from the engine's local estimate: no request is sent.
async function learn($: EngineInterface): Promise<void> {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const { window, breakdown } = usage.context
  learned.add(window)
  const threshold = breakdown?.isAutoCompactEnabled === true ? (breakdown.autoCompactThreshold ?? null) : null
  await update($, bellyAtom, prior => (prior !== null && prior.window === window ? { ...prior, threshold } : prior))
}

// Off the hook's path: the estimate reads the whole context.
function learnLater($: EngineInterface): void {
  $.clock.after(0, () => {
    void serial(() => learn($)).catch(error => $.ui.log(`compaction threshold unknown: ${String(error)}`, { to: 'debug' }))
  })
}

// A compaction empties the belly: an auto one is the pet throwing up, a /compact is a diet that worked.
async function slim($: EngineInterface, isAuto: boolean, before: number | null, after: number | null): Promise<void> {
  const now = await $.clock.now()
  const { startedAt: conv, context } = await $.session.usage()
  const compacted: QuotaPetsCompaction = { at: now, isAuto, before, after }
  await update($, bellyAtom, prior => ({
    conv,
    tokens: null,
    pct: null,
    window: prior?.window ?? context.window,
    threshold: prior?.threshold ?? null,
    warned: false,
    compacted,
  }))
  const pet = await petNow($)
  if (pet !== null) $.ui.toast(slimToast(pet, compacted), { timeoutMs: 10_000 })
}

// A sign the session is at work (a turn starting or ending, a minute of one running): it starts a run or keeps one going.
async function stir($: EngineInterface, now: number): Promise<void> {
  const prior = await read($, activityAtom)
  let activity: QuotaPetsActivity =
    prior === null
      ? { since: now, last: now, nags: 0, back: null, night: null }
      : now - prior.last >= BREAK_MS
        ? { ...prior, since: now, last: now, nags: 0, back: prior.nags > 0 ? now : null }
        : { ...prior, last: now }
  if (isNight(now) && activity.night !== nightOf(now)) {
    const pet = await petNow($)
    if (pet !== null) $.ui.toast(nightToast(pet, now), { timeoutMs: 10_000 })
    activity = { ...activity, night: nightOf(now) }
  }
  await update($, activityAtom, () => activity)
}

// Every minute: a running turn keeps the run of work going, and a long run has the pet asking for a walk.
async function tick($: EngineInterface, isBusy: boolean): Promise<void> {
  const now = await $.clock.now()
  if (isBusy) await stir($, now)
  const activity = await read($, activityAtom)
  const streak = streakOf(activity, now)
  if (activity === null || streak < WALK_AFTER + activity.nags * WALK_AGAIN) return
  const pet = await petNow($)
  if (pet !== null) $.ui.toast(walkToast(pet, streak, activity.nags, now), { timeoutMs: 12_000 })
  await update($, activityAtom, value => (value === null ? null : { ...value, nags: value.nags + 1 }))
}

async function dexText($: EngineInterface): Promise<string> {
  const save = await serial(() => load($))
  const life = await read($, lifeAtom)
  const now = await $.clock.now()
  const section = (kind: Kind) => {
    const pets = PETS.filter(pet => pet.kind === kind)
    const rows = pets.map(pet => {
      const entry = save.dex[pet.id]
      if (entry === undefined || entry.count === 0) return `[${pet.rarity}] ？？？（尚未抽到）`
      const deaths = entry.deaths > 0 ? `，陣亡 ${entry.deaths} 次` : ''
      return `[${pet.rarity}] ${pet.name} ${portrait(pet)} ×${entry.count}${deaths}`
    })
    return [`── ${SPECIES[kind].label} ${owned(save, kind)}/${pets.length} ──`, ...rows]
  }
  let current = '這個對話：還沒抽到（說句話就會抽）'
  if (life !== null) {
    const pet = petById(life.id)
    const dead = life.isDead ? '（已陣亡，等待轉生）' : ''
    const belly = await read($, bellyAtom)
    const streak = streakOf(await read($, activityAtom), now)
    const extras = [
      belly !== null && belly.conv === life.conv && belly.pct !== null ? `肚子 ${belly.pct}%` : null,
      streak >= MINUTE ? `已經連續寫 ${spanText(streak)}` : null,
    ].filter((extra): extra is string => extra !== null)
    current = `這個對話：${portrait(pet)} ${pet.name} [${pet.rarity}]，上工 ${dur(now - life.since)}${dead}${extras.map(extra => `｜${extra}`).join('')}`
  }
  const { cat, dog } = SPECIES
  return [
    `寵物圖鑑 ${owned(save)}/${PETS.length} ｜ 總抽數 ${save.pulls} ｜ 保底還有 ${PITY - save.pity} 抽 ｜ ${cat.treat} ${save.treats.cat}・${dog.treat} ${save.treats.dog}（都沒有任何用途）`,
    current,
    '',
    ...section('cat'),
    '',
    ...section('dog'),
    '',
    '最近：',
    ...save.history.map(line => `・${line}`),
    '',
    '玩法：/petdex 試抽 ｜ /petdex 十連 ｜ /petdex 預覽 ｜ /petdex 預覽 95 柴犬',
    '　　　/petdex 預覽 深夜｜散步｜回來｜肚子 85｜吐｜減肥（可以接名字）',
    '肚子是 context：快自動壓縮時會撐、壓縮完會吐（/compact 是減肥）。連續寫 50 分鐘會吵著散步，半夜會催你睡。',
  ].join('\n')
}

function trialText(times: number): string {
  const got = Array.from({ length: times }, () => rollPet())
  const best = got.reduce((top, pet) => (RANK[pet.rarity] > RANK[top.rarity] ? pet : top))
  const head =
    times === 1
      ? '【試抽・不計入圖鑑】'
      : '【十連試抽・不計入圖鑑】十連要開 10 個對話…騙你的，這是試抽 (=･ω･=)ﾉ U・ᴥ・U'
  return [head, ...got.map(pet => `[${pet.rarity}] ${pet.name} ${portrait(pet)}`), chance(LUCK[best.rarity])].join('\n')
}

let tour: Timer | null = null

const SCENES: Readonly<Record<string, QuotaPetsScene>> = {
  深夜: 'night',
  night: 'night',
  散步: 'walk',
  walk: 'walk',
  回來: 'back',
  back: 'back',
  肚子: 'belly',
  belly: 'belly',
  吐: 'burp',
  burp: 'burp',
  減肥: 'slim',
  slim: 'slim',
}
const SCENE_LABEL: Record<QuotaPetsScene, string> = {
  night: '深夜',
  walk: '散步',
  back: '散步回來',
  belly: '肚子',
  burp: '撐到吐',
  slim: '減肥成功',
}

// The toast a scene would pop for real, if it pops one: acted out at an hour that fits it.
async function sceneToast($: EngineInterface, pet: Pet, preview: QuotaPetsPreview, now: number): Promise<string | null> {
  const scene = preview.scene ?? null
  if (scene === 'night') return nightToast(pet, isNight(now) ? now : new Date(now).setHours(2, 17, 0, 0))
  if (scene === 'walk') return walkToast(pet, 52 * MINUTE, 0, isNight(now) ? new Date(now).setHours(15, 0, 0, 0) : now)
  if (scene === 'burp' || scene === 'slim') {
    return slimToast(pet, { at: now, isAuto: scene === 'burp', before: 167_000, after: 23_000 })
  }
  if (scene !== 'belly') return null
  const held = await read($, bellyAtom)
  const belly = bellyOf(held, held?.conv ?? 0, preview, now)
  return bellyStage(belly.fill) === 3 ? bellyToast(pet, belly.pct, held !== null && held.threshold !== null) : null
}

async function startPreview($: EngineInterface, words: readonly string[]): Promise<string> {
  const isNumber = (word: string) => /^\d{1,3}$/.test(word)
  const pctWord = words.find(isNumber)
  const sceneWord = words.find(word => SCENES[word] !== undefined)
  const scene = sceneWord === undefined ? null : (SCENES[sceneWord] ?? null)
  const petWord = words.find(word => !isNumber(word) && SCENES[word] === undefined)
  const chosen = petWord === undefined ? undefined : PETS.find(pet => pet.name === petWord || pet.id === petWord)
  if (petWord !== undefined && chosen === undefined) {
    const names = (kind: Kind) => PETS.filter(pet => pet.kind === kind).map(pet => pet.name).join('、')
    return `沒有這隻：${petWord}（貓：${names('cat')}｜狗：${names('dog')}）`
  }
  const petId = chosen?.id ?? null
  const now = await $.clock.now()
  tour?.cancel()
  tour = null
  // A later preview outlives this one's timer.
  const until = now + 60_000
  const clear = () => void update($, previewAtom, value => (value?.until === until ? null : value)).catch(() => undefined)

  if (scene !== null) {
    const belly = scene === 'belly' ? Math.min(100, Number(pctWord ?? 85)) : null
    const preview: QuotaPetsPreview = { pct: 20, until, petId, scene, belly }
    await update($, previewAtom, () => preview)
    $.clock.after(60_500, clear)
    const pet = chosen ?? (await petNow($))
    const toast = pet === null ? null : await sceneToast($, pet, preview, now)
    if (toast !== null) $.ui.toast(`【預覽】${toast}`, { timeoutMs: 10_000 })
    const label = scene === 'belly' ? `肚子 ${belly}%` : SCENE_LABEL[scene]
    return `預覽「${label}」一分鐘（只是演的，真實的時間、context 都沒有動）`
  }

  if (pctWord !== undefined) {
    const pct = Math.min(100, Number(pctWord))
    await update($, previewAtom, () => ({ pct, until, petId }))
    $.clock.after(60_500, clear)
    return `預覽 ${pct}% 一分鐘（只是演的，真實額度沒有動）`
  }

  const steps = [10, 45, 70, 87, 92, 96, 99, 100]
  let index = 0
  await update($, previewAtom, () => ({ pct: steps[0] ?? 10, until: now + 4000 * (steps.length + 1), petId }))
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
  // The turns running now: while one runs, the session is at work.
  const running = new Set<string>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'petdex',
      description: '額度寵物圖鑑：抽過的貓狗、陣亡紀錄、保底（試抽／十連／預覽）',
      argumentHint: '[試抽 | 十連 | 預覽 [0-100 | 深夜 | 散步 | 肚子 0-100 | 吐 | 減肥] [名字]]',
    })
    const usage = await $.session.usage()
    await serial(() => ingest($, usage.rateLimits))
    await serial(() => digest($, usage.context))
    learnLater($)
    // The countdowns move even when the percent does not, and a run of work grows by the minute.
    $.clock.every(MINUTE, () => {
      void serial(() => tick($, running.size > 0)).catch(error => $.ui.log(`tick failed: ${String(error)}`, { to: 'debug' }))
      $.ui.invalidate('ui.render')
    })

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.changed.includes('rateLimits')) {
      await serial(() => ingest($, e.rateLimits))
    }
    if (e.changed.includes('context')) {
      await serial(() => digest($, e.context))
      // Another model, another window: its threshold is asked for once.
      if (!learned.has(e.context.window)) learnLater($)
    }

    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.messages !== undefined) {
      const { tokensBefore = null, tokensAfter = null } = result
      await serial(() => slim($, e.trigger !== 'manual', tokensBefore, tokensAfter))
    }

    return result
  })

  on('turn.start', async ($, e, next) => {
    running.add(e.turnId)
    const usage = await $.session.usage()
    const life = await read($, lifeAtom)
    // /clear starts a new conversation in the same session, and a new conversation pulls its own pet.
    if (life === null || life.conv !== usage.startedAt) {
      await serial(() => ingest($, usage.rateLimits))
    }
    const limits = await read($, limitsAtom)
    const five = limits?.five ?? null
    turnStart = five === null ? null : { turnId: e.turnId, pct: five.pct, window: five.resetsAt }
    const now = await $.clock.now()
    await serial(() => stir($, now))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    running.delete(e.turnId)
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await serial(() => stir($, now))
    }
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

  on('command.run', { command: 'petdex' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(word => word.length > 0)
    const [verb, ...rest] = words
    if (verb === '試抽' || verb === 'try') return { text: trialText(1) }
    if (verb === '十連' || verb === '10') return { text: trialText(10) }
    if (verb === '預覽' || verb === 'preview') return { text: await startPreview($, rest) }

    return { text: await dexText($) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const held = await read($, lifeAtom)
    if (e.props.hasSurvey || held === null) return next(e)

    const limits = await read($, limitsAtom)
    const preview = await read($, previewAtom)
    const activity = await read($, activityAtom)
    const now = await $.clock.now()
    const shown = preview !== null && preview.until > now ? preview : null
    const scene = shown?.scene ?? null
    const belly = bellyOf(await read($, bellyAtom), held.conv, shown, now)
    const pet = petById(shown?.petId ?? held.id)
    const five: QuotaPetsLimit | null =
      shown === null
        ? (limits?.five ?? null)
        : { pct: shown.pct, resetsAt: now + (100 - shown.pct) * 3 * 60_000 + 20 * 60_000 }
    const week = limits?.week ?? null
    const isOver = shown === null && five !== null && five.resetsAt !== null && now >= five.resetsAt
    const countdown = countdownOf(five, now)

    let face = portrait(pet)
    let say = '還沒拿到額度資料…跟我說句話吧'
    let stage: Stage | null = null
    if (five !== null && isOver) {
      face = pick(SPECIES[pet.kind].egg, pet.id, held.since)
      say = held.isDead
        ? `額度重置了！說句話就開扭蛋（${pet.name}轉生中…）`
        : '額度重置了！說句話就能開新扭蛋'
    } else {
      if (five !== null) {
        stage = (shown === null && held.isDead) || five.pct >= 100 ? 'dead' : stageOf(five.pct, pet)
        const seed = Math.floor(five.pct)
        face = faceOf(pet, stage, seed, e.props.isWorking)
        say = sayOf(pet, stage, seed, countdown)
      }
      // The ghost stories and the death keep the floor; otherwise the pet may bring up something else.
      // A quota preview shows the quota alone.
      const aside = scene !== null ? sceneAside(scene, now, belly) : shown === null ? asideOf(now, activity, belly) : null
      if (aside !== null && (stage === null || typeof stage === 'number')) {
        const seed = Math.floor(now / (10 * MINUTE))
        if (aside.kind === 'night') face = yawnOf(pet, seed)
        say = asideLine(pet, aside, seed)
      }
    }
    const isCreepy = stage === 'h1' || stage === 'h2' || stage === 'h3' || stage === 'peek'
    const faceColor = isCreepy ? 'error' : stage === 2 ? 'warning' : undefined
    const food = week === null ? null : foodLine(week, now)
    const cell = bellyCell(belly, now)
    const paint = (color: string | undefined) => (color === undefined ? {} : { color })

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Text bold dimColor={stage === 'dead'} {...paint(faceColor)}>
            {face}
          </Text>
          <Text color={RARITY_COLOR[pet.rarity]} bold={RANK[pet.rarity] >= RANK.SSR}>
            {`[${pet.rarity}]`}
          </Text>
          <Text>{pet.name}</Text>
          <Text dimColor italic={isCreepy} wrap="truncate-end">
            {`「${say}」`}
          </Text>
        </Box>
        {(five !== null || food !== null || cell !== null) && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
            {five !== null && !isOver && (
              <Box flexDirection="row" columnGap={1}>
                <Text dimColor>5h</Text>
                <Text color={barColor(five.pct)}>{bar(five.pct)}</Text>
                <Text>{pctText(five.pct)}</Text>
                <Text dimColor>{`· ${countdown} 後重置`}</Text>
              </Box>
            )}
            {isOver && <Text dimColor>5h 已重置</Text>}
            {week !== null && food !== null && (
              <Box flexDirection="row" columnGap={1}>
                <Text dimColor>飼料(週)</Text>
                <Text>
                  {lane(week, now, food.color === 'error').map(cell => (
                    <Text dimColor={cell.color === undefined} {...paint(cell.color)}>
                      {cell.glyph}
                    </Text>
                  ))}
                </Text>
                <Text color={food.color}>{pctText(week.pct)}</Text>
                <Text dimColor wrap="truncate-end">
                  {`· ${food.text}`}
                </Text>
              </Box>
            )}
            {cell !== null && (
              <Box flexDirection="row" columnGap={1}>
                <Text dimColor>肚子</Text>
                <Text color={cell.color}>{cell.gauge}</Text>
                <Text>{cell.text}</Text>
              </Box>
            )}
            {shown !== null && <Text color="magenta">（預覽中）</Text>}
          </Box>
        )}
      </Box>
    )
  })
}
