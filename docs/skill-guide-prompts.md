# 技能說明圖產圖提示詞（全 52 技能）

> 用途：餵給圖像生成 AI（Midjourney / DALL·E / Stable Diffusion / 即夢等），
> 產出與 `src/skills/weather/guide.svg` 同風格的教學說明圖。
> 完成後存為 `src/skills/<id>/guide.svg|png|jpg`，跑 `node scripts/build-library.mjs`
> 即會出現在 library 用法區塊（可參考 weather 範例）。

## 使用方法

1. 先貼上**共用風格前綴**（§0），再接各技能的場景提示詞。
2. 中文文字容易亂碼：請在提示詞保留「exact Traditional Chinese text」要求，
   出圖後務必檢查標題／泡泡／手機文字；壞掉就重抽或只出圖、文字後製疊加。
3. 建議橫圖 16:10、解析度越高越好；手機對話框一律在右側。

## §0 共用風格前綴（每次貼上）

```text
Kawaii Taiwanese chatbot tutorial illustration, flat vector sticker style.
Cream background (#FFFBF0) with mint-green gradient outer frame and dark navy
hand-drawn rounded border. Big chunky rounded title on top, Traditional Chinese,
each 2-character word a different color (blue, orange-yellow, pink, green) with
thick white sticker outline. A cute white-and-blue robot and a chibi boy with
brown hair on the left, white speech bubbles with black rounded text. Three
thick curved arrows (yellow, pink, blue) sweeping across the middle with cute
themed icons around them. A smartphone mockup on the right showing a chat app:
green user bubble with the command, white bot bubble with the answer. Pastel
clouds, stars and sparkles as decoration. Thick dark outlines, soft pastel
fills, cheerful, clean, high detail. Exact Traditional Chinese text, no
gibberish, no watermark.
```

---

## 智慧助理

### 1. AI 助理（ai）

```text
Title text "AI助理指令教學". Speech bubbles: "阿寶請幫忙 問 台灣最高的山",
"啟動AI模式". Center icons: chat bubble with stars, glowing brain, small photo
with question mark. Phone reply shows: "玉山 3952公尺" with a small mountain,
and a second line "已進入 AI 對話模式，接下來 10 分鐘可以直接問我".
```

## 生活資訊

### 2. 天氣（weather）——已有 `guide.svg`，以此為範本

```text
Title text "天氣查詢指令教學". Speech bubbles: "阿寶請幫忙 天氣 台北",
"天氣 一週 高雄", "天氣雷達". Center icons: smiling sun, rain cloud, radar
screen. Phone reply shows: "台北 天氣 25°C (體感28°C) 濕度 84%" plus a
5-day forecast row with sun/cloud icons and "25°" temperatures.
```

### 3. 空氣品質（air-quality）

```text
Title text "空品查詢指令教學". Speech bubbles: "阿寶請幫忙 空品 高雄",
"空氣品質 台中". Center icons: face mask, green leaf, factory with fresh air
swirl. Phone reply shows: "高雄 空氣品質：AQI 45（良好） 主要污染物：PM2.5".
```

### 4. 放假 / 工作日曆（holiday）

```text
Title text "放假查詢指令教學". Speech bubbles: "阿寶請幫忙 放假 明天",
"放假 今年". Center icons: wall calendar with a star on a holiday, beach
umbrella, office building. Phone reply shows: "明天放假（週末）" with a small
confetti.
```

### 5. 颱風 / 警特報（typhoon）

```text
Title text "颱風查詢指令教學". Speech bubbles: "阿寶請幫忙 颱風",
"颱風 訂閱 30". Center icons: typhoon swirl, umbrella in wind, warning
triangle. Phone reply shows: "輕度颱風 路徑預報" with a dotted track map and
"每 30 分鐘檢查，有新警報會通知你".
```

### 6. 地震速報（quake）

```text
Title text "地震速報指令教學". Speech bubbles: "阿寶請幫忙 地震".
Center icons: seismograph with wiggling line, cracked ground, warning siren.
Phone reply shows: "花蓮 M5.2 地震 震度4級" with a map pin.
```

### 7. 晨報（morning）

```text
Title text "晨報指令教學". Speech bubbles: "阿寶請幫忙 晨報 08:00 高雄".
Center icons: sunrise over mountains, newspaper, coffee cup. Phone reply shows
a morning digest: "早安！今天要上班 高雄 26°C AQI良好 台股開盤上漲".
```

## 交通

### 8. 火車時刻表（train）

```text
Title text "火車查詢指令教學". Speech bubbles: "阿寶請幫忙 火車 台北 到 高雄 明天 08:00".
Center icons: railway train, rails, station clock. Phone reply shows:
"台北→高雄 自強號 08:30開 11:58到".
```

### 9. 高鐵時刻（hsr）

```text
Title text "高鐵查詢指令教學". Speech bubbles: "阿寶請幫忙 高鐵 台北到左營 明天08:00".
Center icons: bullet train, platform sign, speed lines. Phone reply shows:
"台北→左營 0833車次 09:00開 10:34到".
```

### 10. 公車動態（bus）

```text
Title text "公車查詢指令教學". Speech bubbles: "阿寶請幫忙 公車 307 台北車站",
"公車 訂閱 307 台北車站 5". Center icons: city bus, bus stop sign, alarm
bell. Phone reply shows: "307路 往板橋：3分鐘到站" with a small bus.
```

### 11. 捷運班距票價（metro）

```text
Title text "捷運查詢指令教學". Speech bubbles: "阿寶請幫忙 捷運 台北車站 到 西門".
Center icons: MRT train, colorful route map, ticket gate. Phone reply shows:
"板南線 約4分鐘一班 票價 NT$20".
```

### 12. YouBike 即時車位（ybike）

```text
Title text "YouBike查詢指令教學". Speech bubbles: "阿寶請幫忙 YouBike 台北車站".
Center icons: yellow bicycle, docking station, number counter. Phone reply
shows: "台北車站 可借 12台 可還 8位".
```

### 13. 低價機票（flight）

```text
Title text "機票查詢指令教學". Speech bubbles: "阿寶請幫忙 機票 台北飛東京 12月".
Center icons: airplane taking off, boarding ticket, calendar. Phone reply
shows: "台北→東京 最低 NT$8,900（12/15）".
```

## 金融理財

### 14. 股價（stock）

```text
Title text "股價查詢指令教學". Speech bubbles: "阿寶請幫忙 股價 2330",
"股價 台積電". Center icons: candlestick chart going up, red up-arrow, bank
building. Phone reply shows: "2330 台積電 現價 1080 ▲15 (+1.4%)".
```

### 15. 台股大盤（taiex）

```text
Title text "大盤查詢指令教學". Speech bubbles: "阿寶請幫忙 大盤".
Center icons: rising index line chart, gold coins, bull horn. Phone reply
shows: "台股加權指數 24500 ▲120 (+0.5%) 昨收 24380".
```

### 16. ETF 比較（etf-compare）

```text
Title text "ETF比較指令教學". Speech bubbles: "阿寶請幫忙 ETF 0050 0056 00878".
Center icons: bar chart comparing three funds, coins, piggy bank. Phone reply
shows: "0050 / 0056 / 00878 配息與漲跌比較表".
```

### 17. 加密貨幣（crypto）

```text
Title text "幣價查詢指令教學". Speech bubbles: "阿寶請幫忙 幣價 比特幣",
"0.5比特幣值多少". Center icons: gold bitcoin coin, price chart, little
rocket. Phone reply shows: "比特幣 NT$ 3,600,000 ▲+1.2% (24h)".
```

### 18. 匯率換算（exchange-rate）

```text
Title text "匯率換算指令教學". Speech bubbles: "阿寶請幫忙 匯率 1000 日幣 台幣",
"100美金等於台幣". Center icons: yen and dollar coins, calculator, globe.
Phone reply shows: "1000 JPY = 208 TWD（匯率 1 JPY ≈ 0.208 TWD）".
```

### 19. 到價通知（price-alert）

```text
Title text "到價通知指令教學". Speech bubbles: "阿寶請幫忙 警示 台積電 跌破 800".
Center icons: ringing bell, falling stock arrow, target with arrow. Phone
reply shows: "已設定：台積電 跌破 800 通知你" and a push bubble "台積電已跌破800！".
```

### 20. 統一發票 / 樂透（lottery-invoice）

```text
Title text "發票對獎指令教學". Speech bubbles: "阿寶請幫忙 發票 上一期",
"大樂透". Center icons: receipt with numbers, colorful lottery balls, money
burst. Phone reply shows: "本期特別獎 12345678" with confetti.
```

## 生活消費

### 21. 麥當勞優惠（mcdonald）

```text
Title text "麥當勞優惠指令教學". Speech bubbles: "阿寶請幫忙 麥當勞 買一送一".
Center icons: red fries box, burger, coupon ticket. Phone reply shows:
"大薯買一送一 $99" list with prices.
```

### 22. 肯德基優惠（kfc-coupon）

```text
Title text "肯德基優惠指令教學". Speech bubbles: "阿寶請幫忙 肯德基 100".
Center icons: fried chicken bucket, drumstick, coupon with code. Phone reply
shows: "【15730】$99 咔啦雞腿堡餐".
```

### 23. 漢堡王（burger-coupon）

```text
Title text "漢堡優惠指令教學". Speech bubbles: "阿寶請幫忙 漢堡王 100",
"摩斯 漢堡". Center icons: flame-grilled burger, onion rings, coupon.
Phone reply shows: "$129 華堡限時優惠".
```

### 24. 星巴克優惠（starbucks）

```text
Title text "星巴克優惠指令教學". Speech bubbles: "阿寶請幫忙 星巴克 買一送一".
Center icons: coffee cup with star logo, cake slice, calendar. Phone reply
shows: "【10/16】拿鐵買一送一" date-grouped list.
```

### 25. 全聯 / 家樂福促銷（promo）

```text
Title text "賣場促銷指令教學". Speech bubbles: "阿寶請幫忙 促銷 全聯",
"促銷 家樂福 買一送一". Center icons: supermarket storefront, shopping cart,
red SALE tag. Phone reply shows: "[全聯] 衛生紙買一送一 附新聞連結".
```

### 26. 優惠速覽（deals）

```text
Title text "優惠速覽指令教學". Speech bubbles: "阿寶請幫忙 優惠",
"優惠 漢堡". Center icons: shopping bag full of goodies, gift box, ticket
stack. Phone reply shows a multi-brand list: "【麥當勞】大薯買一送一
【肯德基】$99套餐 【星巴克】拿鐵買一送一".
```

### 27. 產品比價（price-compare）

```text
Title text "比價指令教學". Speech bubbles: "阿寶請幫忙 比價 iPhone 16".
Center icons: price tags, magnifier over cart, balance scale. Phone reply
shows: "iPhone 16：A商城 $28,900 / B商城 $27,500" comparison.
```

## 工具

### 28. 提醒 / 倒數（remind）

```text
Title text "提醒指令教學". Speech bubbles: "阿寶請幫忙 提醒 明天 09:00 開會",
"提醒 每天 08:00 吃藥". Center icons: alarm clock ringing, bell, calendar
with check. Phone reply shows a push bubble: "⏰ 開會".
```

### 29. 待辦清單（todo）

```text
Title text "待辦指令教學". Speech bubbles: "阿寶請幫忙 待辦 買牛奶 明天",
"待辦 完成 1". Center icons: checklist with ticks, pencil, sticky note.
Phone reply shows: "1. ▫ 買牛奶（10/16到期） 2. ☑ 雞蛋（完成）".
```

### 30. 紀念日 / 倒數（countdown）

```text
Title text "紀念日倒數指令教學". Speech bubbles: "阿寶請幫忙 紀念日 2026-12-31 跨年",
"紀念日 每年 5/20 交往紀念日". Center icons: wall calendar, party popper,
heart. Phone reply shows: "跨年｜還有 77 天 🎉就是今天（第3週年）".
```

### 31. 翻譯（translate）

```text
Title text "翻譯指令教學". Speech bubbles: "阿寶請幫忙 翻成英文 你好嗎".
Center icons: two speech bubbles with "A" and "あ", globe, dictionary.
Phone reply shows: "翻譯（中→英）：How are you?".
```

### 32. 辭典（dict）

```text
Title text "辭典查詢指令教學". Speech bubbles: "阿寶請幫忙 辭典 台灣",
"辭典 朝三暮四". Center icons: open dictionary book, magnifier, ink brush.
Phone reply shows: "台灣：太平洋西南島嶼……" dictionary definition.
```

### 33. 維基百科（wiki）

```text
Title text "維基查詢指令教學". Speech bubbles: "阿寶請幫忙 維基 台灣".
Center icons: globe puzzle ball, bookshelf, magnifier. Phone reply shows:
"台灣（維基百科）：……" with article summary lines.
```

### 34. 網頁摘要（summarize）

```text
Title text "摘要指令教學". Speech bubbles: "阿寶請幫忙 摘要 https://example.com/article".
Center icons: document with highlighter, bullet list, bookmark. Phone reply
shows: "重點：一、…… 二、…… 三、……" summary.
```

### 35. 農曆 / 國曆轉換（lunar）

```text
Title text "農曆查詢指令教學". Speech bubbles: "阿寶請幫忙 農曆 2026 八月初七",
"國曆 2026-09-28". Center icons: crescent moon, traditional calendar, red
lantern. Phone reply shows: "國曆 2026-09-28 → 農曆 八月初七".
```

### 36. 單位換算（unit）

```text
Title text "換算指令教學". Speech bubbles: "阿寶請幫忙 換算 100公分等於幾公尺".
Center icons: ruler, kitchen scale, calculator. Phone reply shows:
"100 公分 = 1 公尺".
```

### 37. 郵遞區號（postcode）

```text
Title text "郵遞區號查詢指令教學". Speech bubbles: "阿寶請幫忙 郵遞區號 台北市大安區".
Center icons: envelope, red mailbox, map pin. Phone reply shows:
"台北市大安區 的郵遞區號：106".
```

### 38. QR / 短網址（qr）

```text
Title text "QR指令教學". Speech bubbles: "阿寶請幫忙 qr https://example.com".
Center icons: QR code square, link chain, camera frame. Phone reply shows a
QR code image with "短網址：https://…" below.
```

### 39. 網路工具（net）

```text
Title text "網路工具指令教學". Speech bubbles: "阿寶請幫忙 網路 我的IP",
"網路 dns google.com". Center icons: globe with arrows, server rack,
magnifier. Phone reply shows: "你的對外 IP：203.0.113.8".
```

### 40. 隨機 / 抽籤（random）

```text
Title text "隨機指令教學". Speech bubbles: "阿寶請幫忙 骰子",
"抽籤 火鍋 日料 義大利麵", "吃什麼". Center icons: red dice, coin toss,
fortune sticks. Phone reply shows: "今天就吃「火鍋」吧！".
```

### 41. 投票（poll）

```text
Title text "投票指令教學". Speech bubbles: "阿寶請幫忙 投票 要吃什麼？ | 火鍋 | 日料",
"投票 1", "投票 結果". Center icons: ballot box, raised hand with check,
result chart. Phone reply shows: "1.火鍋 2票 2.日料 1票".
```

### 42. 網頁收藏（web-bookmark）

```text
Title text "收藏指令教學". Speech bubbles: "阿寶請幫忙 收藏 https://example.com #工具",
"收藏 清單". Center icons: bookmark ribbon, folder, gold star. Phone reply
shows: "收藏清單（共 3 筆）：1. …… #工具".
```

### 43. RSS 訂閱摘要（rss）

```text
Title text "訂閱指令教學". Speech bubbles: "阿寶請幫忙 rss 訂閱 https://example.com/feed.xml",
"rss 清單". Center icons: orange RSS symbol, newspaper stack, bell. Phone
reply shows: "📰 新文章：……（AI摘要：……）".
```

### 44. 關鍵字自動回覆（auto-reply）

```text
Title text "自動回覆設定教學". Speech bubbles: "關鍵字「營業時間」→自動回覆",
"有人問：請問營業時間？". Center icons: gear with chat bubble, lightning
bolt, robot hand waving. Phone reply shows user asking "請問營業時間？"
and the bot auto-replying "10:00–22:00，全年無休".
```

## 內容訂閱

### 45. 電影時刻（movie）

```text
Title text "電影查詢指令教學". Speech bubbles: "阿寶請幫忙 電影 信義威秀".
Center icons: film strip, popcorn bucket, cinema ticket. Phone reply shows:
"信義威秀 今日場次：沙丘 13:20 / 16:40".
```

### 46. 中職戰績（cpbl）

```text
Title text "中職戰績指令教學". Speech bubbles: "阿寶請幫忙 中職",
"中職 上半季". Center icons: baseball, crossed bats, gold trophy. Phone
reply shows a standings table: "1.兄弟 勝率.620 2.樂天 …".
```

### 47. 菜價（crop-price）

```text
Title text "菜價查詢指令教學". Speech bubbles: "阿寶請幫忙 菜價 高麗菜".
Center icons: cabbage, market basket, weighing scale. Phone reply shows:
"高麗菜（台北一）均價 28 元/公斤".
```

### 48. 油價（oil-price）

```text
Title text "油價查詢指令教學". Speech bubbles: "阿寶請幫忙 油價".
Center icons: red gas pump, fuel nozzle, little car. Phone reply shows:
"92無鉛 29.5 / 95無鉛 31.0 / 98無鉛 33.0（本週）".
```

### 49. 水庫水情（reservoir）

```text
Title text "水庫查詢指令教學". Speech bubbles: "阿寶請幫忙 水庫 石門".
Center icons: concrete dam, big water drop, percentage gauge. Phone reply
shows: "石門水庫 蓄水率 78% 水位 244公尺".
```

### 50. 停水停電查詢（outage）

```text
Title text "停水停電查詢指令教學". Speech bubbles: "阿寶請幫忙 停水 台北",
"停電". Center icons: faucet with drop, unplugged power plug, warning
triangle. Phone reply shows: "停水公告（士林區）：10/20 09:00–16:00".
```

### 51. 垃圾車時刻（garbage）

```text
Title text "垃圾車查詢指令教學". Speech bubbles: "阿寶請幫忙 垃圾車 士林區".
Center icons: green garbage truck, trash bag, clock. Phone reply shows:
"士林區 接下來：18:20 中正路口 ※週三週日停收".
```

## 運維監控

### 52. 網站監控（website）

```text
Title text "網站監控指令教學". Speech bubbles: "阿寶請幫忙 網站 https://example.com",
"網站 訂閱 https://example.com 30". Center icons: monitor with heartbeat
line, shield check, bell. Phone reply shows: "example.com 正常 200（0.8秒）"
and an alert bubble "example.com 異常，已通知！".
```
