/* ミズタ在庫管理 アプリ本体（移行先スケルトン）。
 *
 * ★移行のやること（MIGRATION_GUIDE §Step3）:
 *   1) 現行UIは分割構成: _legacy/gas/ui.html（マークアップ）/ js.html（<script>ロジック2128行）/ styles.html（CSS）。
 *      js.html のロジックを app-core.js へ、styles.html を styles.css へ、ui.html のマークアップを #app へ。
 *   2) `google.script.run.xxx(...)` はそのままでOK（auth.js のシムが fetch に橋渡し）。
 *   3) ログイン後、auth.js が boot() を呼ぶ。ここで初期データ取得→初期描画。
 */

function busyOff() {}   // auth.js が任意参照。現行UIのローディング停止関数に合わせて実装。

function boot() {
  // TODO: 現行UIの初期化をここへ（_legacy/gas/js.html の初期化処理を移植）。
  document.getElementById('loading').style.display = 'none';
  var app = document.getElementById('app');
  app.style.display = '';
  app.innerHTML = '<div style="padding:48px;max-width:720px;margin:0 auto;color:#6b7280;font-family:Inter,\'Noto Sans JP\',sans-serif;line-height:1.9">'
    + '<h2 style="color:#1f2430;margin:0 0 8px">ミズタ在庫管理（移行スケルトン）</h2>'
    + '認証は完成しています（共通ログイン/SSO）。ここに現行UI（<code>_legacy/gas/ui.html + js.html + styles.html</code>）を移植してください。'
    + '手順は <code>docs/MIGRATION_GUIDE.md</code> と <code>docs/README.md</code>。</div>';
}
