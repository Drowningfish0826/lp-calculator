網頁版線性規劃計算器 (Web-based LP Calculator)
==========================================
使用方式：解壓縮後，以瀏覽器（Chrome / Edge / Firefox / Safari）直接開啟 index.html 即可，不需要網路、不需要安裝任何東西。

檔案結構
  index.html        主頁面
  style.css         樣式
  app.js            介面與流程
  lib/lp-core.js    核心：建模、呼叫求解器、敏感度分析、管理意涵、運輸/指派範本
  lib/graph.js      兩變數圖形化分析
  lib/highs.js      HiGHS 求解器 (WebAssembly) 載入器
  lib/highs-wasm.js HiGHS 求解器 (WebAssembly 二進位，base64 內嵌)

求解器：HiGHS (https://highs.dev, MIT License)，透過 highs-js 以 WebAssembly 在瀏覽器本機執行。
