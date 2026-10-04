# claude-mods

我的 Claude Code mods。

- **quota-pets**：額度寵物扭蛋，每個對話抽一隻顏文字貓或狗陪你看額度
  - context 是寵物的肚子：快自動壓縮時會撐、壓縮完會吐，`/compact` 是減肥（桌面版右下角已經有 context 圈圈，所以不再畫肚子的刻度，寵物照樣會抱怨、會吐）
  - 桌面版可以按「收起」把寵物收成一行，按「展開」恢復，下次開也會記得
  - 額度在所有對話之間同步：別的對話拿到新的數字，這個對話幾秒內就跟著更新，新開的對話或切回來的對話也一樣，不用先說話
  - `/petdex 肚子` 看牠吃了什麼：context 裡最大的前五口（讀了哪個大檔案、哪個指令輸出特別長），快撐爆時的提醒也會說最大的一口是什麼
  - 連續寫 50 分鐘會吵著要散步，提醒你休息；半夜會打呵欠催你去睡
  - `/petdex 預覽 深夜`（或 `散步`、`肚子 85`、`吐`、`減肥`）可以先看看長什麼樣子
- **convo-diff**：`/convo-diff` 打開面板，只列出這個對話在 repo 裡改過、還沒 commit 的檔案 diff，不會混進別的對話或手動的修改
  - 每個檔案跟它在這個對話第一次被改之前的內容比；commit 過之後就改跟那次 commit 比，所以 commit 完只剩之後的改動。只 commit 一部分、amend、在別的終端機 commit 都會算對；對話開始前就有、還沒 commit 的改動不會算進來
  - 整個檔案都 commit 了、之後沒再改的，收成一行「已經 commit、之後沒再改」
  - 「看整段對話」：每個檔案跟這個對話第一次改它之前比，commit 過的也算，只能看、不能還原
  - 桌面版：這個對話有改檔案時，輸入框上方右側會出現「對話 diff（檔案數）」按鈕，按一下就打開面板，不用打指令；全部 commit 了會顯示「對話 diff（都 commit 了）」；終端機則是在輸入框下面的狀態列顯示改了幾個檔案
  - Edit、Write、Bash 改的檔案都會列出來；PowerShell 改的也會（指令前後用 git 各拍一次快照比對，快照存在 `.git` 裡自己的 index，不會動到你的暫存區）
  - 「解釋」：直接在對話裡請 Claude 解釋這個檔案改了什麼、為什麼改，看完可以接著追問
  - 「還原」：確認後把檔案還原成面板比的那個版本：commit 過的還原成上次 commit 的樣子，沒 commit 過的還原成這個對話改之前的樣子（這個對話新增的檔案會刪掉）。不會倒掉已經 commit（或 push）的改動，還原後可以按「復原」

## 安裝

```bash
claude plugin marketplace add https://github.com/Open01277/claude-mods.git
claude plugin install quota-pets@claude-mods
claude plugin install convo-diff@claude-mods
```

也可以在 Claude Code 裡面輸入：

```
/plugin marketplace add https://github.com/Open01277/claude-mods.git
/plugin install quota-pets@claude-mods
/plugin install convo-diff@claude-mods
```

## 更新

```bash
claude plugin marketplace update claude-mods
claude plugin update quota-pets@claude-mods
claude plugin update convo-diff@claude-mods
```

更新完要重開 Claude Code 才會載入新版。

## 新增一個 mod

1. 把 mod 資料夾放到 `plugins/<mod-name>/`
2. 在 `.claude-plugin/marketplace.json` 的 `plugins` 陣列加一筆
3. 記得同時把該 mod 的 `plugin.json` 和 `marketplace.json` 裡的 `version` 調高，別台電腦才會拿到更新
