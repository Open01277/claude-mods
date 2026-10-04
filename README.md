# claude-mods

我的 Claude Code mods。

- **quota-pets**：額度寵物扭蛋，每個對話抽一隻顏文字貓或狗陪你看額度
  - context 是寵物的肚子：快自動壓縮時會撐、壓縮完會吐，`/compact` 是減肥
  - 連續寫 50 分鐘會吵著要散步，提醒你休息；半夜會打呵欠催你去睡
  - `/petdex 預覽 深夜`（或 `散步`、`肚子 85`、`吐`、`減肥`）可以先看看長什麼樣子
- **convo-diff**：`/convo-diff` 打開面板，只列出這個對話在 repo 裡改過的檔案 diff（每個檔案跟它在這個對話第一次被改之前的內容比），不會混進別的對話或手動的修改
  - 桌面版：這個對話有改檔案時，輸入框上方會出現「對話 diff」按鈕，按一下就打開面板，不用打指令
  - Edit、Write、Bash 改的檔案都會列出來；PowerShell 改的也會（指令前後用 git 各拍一次快照比對，快照存在 `.git` 裡自己的 index，不會動到你的暫存區）
  - 「解釋」：直接在對話裡請 Claude 解釋這個檔案改了什麼、為什麼改，看完可以接著追問
  - 「還原」：確認後把檔案還原成這個對話改之前的樣子（這個對話新增的檔案會刪掉），還原後可以按「復原」

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
```

## 新增一個 mod

1. 把 mod 資料夾放到 `plugins/<mod-name>/`
2. 在 `.claude-plugin/marketplace.json` 的 `plugins` 陣列加一筆
3. 記得同時把該 mod 的 `plugin.json` 和 `marketplace.json` 裡的 `version` 調高，別台電腦才會拿到更新
