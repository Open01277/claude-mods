# claude-mods

我的 Claude Code mods。

- **quota-pets**：額度寵物扭蛋，每個對話抽一隻顏文字貓或狗陪你看額度
  - context 是寵物的肚子：快自動壓縮時會撐、壓縮完會吐，`/compact` 是減肥（桌面版右下角已經有 context 圈圈，所以不再畫肚子的刻度，寵物照樣會抱怨、會吐）
  - 桌面版可以按「收起」把寵物收成一行，按「展開」恢復，下次開也會記得
  - 額度在同一個帳號的所有對話之間同步：別的對話拿到新的數字，這個對話幾秒內就跟著更新；登入別的帳號的對話（例如終端機的 `claude` 登的是另一個帳號）不會混進來
  - 打開或切回對話時，如果手上的數字超過 2 分鐘，會用這個對話自己的登入在背景查一次最新額度（就是用量面板讀的那份，不用 token），所有對話都閒著時每 10 分鐘補查一次；多個對話不會同時重複查
  - `/petdex 肚子` 看牠吃了什麼：context 裡最大的前五口（讀了哪個大檔案、哪個指令輸出特別長），快撐爆時的提醒也會說最大的一口是什麼
  - 連續寫 50 分鐘會吵著要散步，提醒你休息；半夜會打呵欠催你去睡
  - `/petdex 預覽 深夜`（或 `散步`、`肚子 85`、`吐`、`減肥`）可以先看看長什麼樣子
- **convo-diff**：`/convo-diff` 打開面板，只列出這個對話在 repo 裡改過、還沒 commit 的檔案 diff，不會混進別的對話或手動的修改
  - 每個檔案跟它在這個對話第一次被改之前的內容比；commit 過之後就改跟那次 commit 比，所以 commit 完只剩之後的改動。只 commit 一部分、amend、在別的終端機 commit 都會算對；對話開始前就有、還沒 commit 的改動不會算進來
  - 整個檔案都 commit 了、之後沒再改的，收成一行「已經 commit、之後沒再改」
  - 「看整段對話」：每個檔案跟這個對話第一次改它之前比，commit 過的也算，只能看、不能還原
  - 桌面版：這個對話有改檔案時，輸入框上方右側會出現「對話 diff（檔案數）」按鈕，按一下就打開面板，不用打指令；全部 commit 了會顯示「對話 diff（都 commit 了）」；終端機則是在輸入框下面的狀態列顯示改了幾個檔案
  - Edit、Write、Bash、PowerShell 改的檔案都會列出來。每輪對話開始時用 git 拍一次 repo 的快照，PowerShell 指令跑完、或 Bash 一次改太多檔案（Claude Code 只記得前幾個檔案改了什麼）時，再拍一次跟上一次比，所以這些檔案也比得出來；唯讀的指令不拍。快照存在 `.git` 裡自己的 index，不會動到你的暫存區
  - diff 很長時，往下捲每隔一段會再出現一次淡色的「檔名（續）」，捲到哪裡都看得到現在是哪個檔案
  - 「解釋」：直接在對話裡請 Claude 解釋這個檔案改了什麼、為什麼改，看完可以接著追問
  - 「還原」：確認後把檔案還原成面板比的那個版本：commit 過的還原成上次 commit 的樣子，沒 commit 過的還原成這個對話改之前的樣子（這個對話新增的檔案會刪掉）。不會倒掉已經 commit（或 push）的改動，還原後可以按「復原」
- **convo-board**：右側看板，一眼看出別的對話哪些在等你回、哪些跑完了你還沒看、哪些正在跑，按一下就跳過去
  - 桌面版每個對話打開時，看板自動出現在右邊；在某個對話按 × 關掉，那個對話就不再自動打開，打 `/convo-board` 可以再叫出來。終端機要打 `/convo-board` 才會打開
  - 等你回：卡在權限確認、AskUserQuestion 問你問題、計畫等你批准，直接寫出在問什麼；auto 模式自己放行、沒跳出確認框的不算
  - 跑完沒看：跑完時你沒在看那個對話。顯示最後回答的第一句，結尾在問你的會標「（有問你）」，按「看結果」直接在看板裡展開最後的回答，不用切過去捲到底；出錯停下來、或跑到一半對話被關掉的也列在這裡
  - 正在跑：現在在做什麼（執行哪個指令、編輯哪個檔），跑了多久
  - 每列都有對話名稱、專案資料夾、你最後說了什麼；「跳過去」讓桌面版直接切到那個對話，切過去之後它就從「跑完沒看」消失
  - 看過、閒著的對話不列，這個對話自己也不列；桌面版封存的對話會消失
  - 每個對話自己回報狀態，所以裝好之後新開或重開的對話才會回報；還沒重開、但正在跑的對話會列在「正在跑」，只是看不到細節
  - 狀態存在所有對話共用的 store，每個對話只寫自己那一格，每 30 秒報一次平安；跑到一半卻超過 90 秒沒消息的，算對話被關掉了

## 安裝

```bash
claude plugin marketplace add https://github.com/Open01277/claude-mods.git
claude plugin install quota-pets@claude-mods
claude plugin install convo-diff@claude-mods
claude plugin install convo-board@claude-mods
```

也可以在 Claude Code 裡面輸入：

```
/plugin marketplace add https://github.com/Open01277/claude-mods.git
/plugin install quota-pets@claude-mods
/plugin install convo-diff@claude-mods
/plugin install convo-board@claude-mods
```

## 更新

```bash
claude plugin marketplace update claude-mods
claude plugin update quota-pets@claude-mods
claude plugin update convo-diff@claude-mods
claude plugin update convo-board@claude-mods
```

更新完要重開 Claude Code 才會載入新版。

## 新增一個 mod

1. 把 mod 資料夾放到 `plugins/<mod-name>/`
2. 在 `.claude-plugin/marketplace.json` 的 `plugins` 陣列加一筆
3. 記得同時把該 mod 的 `plugin.json` 和 `marketplace.json` 裡的 `version` 調高，別台電腦才會拿到更新
