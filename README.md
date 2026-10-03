# claude-mods

我的 Claude Code mods。

## 安裝

```bash
claude plugin marketplace add Open01277/claude-mods
claude plugin install quota-cat@claude-mods
```

也可以在 Claude Code 裡面輸入：

```
/plugin marketplace add Open01277/claude-mods
/plugin install quota-cat@claude-mods
```

## 更新

```bash
claude plugin marketplace update claude-mods
```

## 新增一個 mod

1. 把 mod 資料夾放到 `plugins/<mod-name>/`
2. 在 `.claude-plugin/marketplace.json` 的 `plugins` 陣列加一筆
3. 記得同時把該 mod 的 `plugin.json` 和 `marketplace.json` 裡的 `version` 調高，別台電腦才會拿到更新
