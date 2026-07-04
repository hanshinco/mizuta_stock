/* ミズタ在庫管理 アプリ本体（_legacy/gas/js.html より移植）。
 *
 * 移行の要点（MIGRATION_GUIDE §Step3）:
 *   - google.script.run.xxx(...) は auth.js のシムがそのまま fetch に橋渡し（無改変）。
 *   - 起動入口は旧 window.onload → グローバル boot()（auth.js がログイン成功後に呼ぶ）。
 *   - 絵文字はナビ=単色SVG(index.html) / その他=テキストに置換（HANDOVER §7 の方針）。
 */
// ============================================================
// js.html – クライアントサイド JS
// ============================================================

// ---- グローバル状態 ----
const state = {
  inventory: [],    // getInventoryList() の結果キャッシュ
  categories: [],
  currentPanel: 'inventory',
  // 新商品追加
  np: {
    yayoiMode: 'existing',
    selectedYayoi: null,
    currentStep: 1,
  },
  // 照合
  recDiffs: [],
  // 読み込み中の下書きID（PDF作成成功時に自動削除する）
  loadedDraft: { pull: null, ret: null },
  // メール → {email, name, photoUrl} のキャッシュ（Googleアイコン用）
  _profileCache: {},
  // 引き寄せプレビュー状態（{pdfId, params}）。確定 or 破棄で null に戻る
  previewPull: null,
  // 返送プレビュー状態（{pdfId, params}）。確定 or 破棄で null に戻る
  previewRet: null,
  // ログインユーザーが ADMIN_EMAILS に含まれるか。サーバーから取得するまでは false（安全側）
  isAdmin: false,
  // 権限の確定状態を3値で持つ: 'unknown'(確認中/未確定) | 'admin' | 'user'。
  // 'unknown' と確定 'user' を区別し、権限APIがこけただけの時に「権限のない人UI」で固定しない。
  adminState: 'unknown',
  // 在庫キャッシュの取得時刻（loadInventory の再訪キャッシュ判定に使う）
  _invLoadedAt: 0,
};

// 要素があればクリックイベントを登録（未デプロイ時のエラーで初期化が止まるのを防ぐ）
function bindClick(id, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', fn);
}

// サイドバー左下にログインユーザー（写真・氏名・メール）を表示。共通アカウントなら で注意喚起。
function loadCurrentUserLabel(attempt) {
  attempt = attempt || 1;
  google.script.run
    .withSuccessHandler(prof => {
      const el = document.getElementById('user-label');
      if (!el) return;
      const email = String((prof && prof.email) || '').trim();
      const name  = String((prof && prof.name)  || '').trim();
      const photo = String((prof && prof.photoUrl) || '').trim();
      if (!email) { el.textContent = ''; return; }
      // 取得済みプロフィールをキャッシュに登録（下書き一覧等での再問い合わせを抑止）
      state._profileCache[email.toLowerCase()] = { email: email, name: name, photoUrl: photo };
      // 権限を反映: data-admin-only 要素は body.is-admin が付くまで非表示（styles.html 側で制御）
      state.isAdmin = !!(prof && prof.isAdmin);
      state.adminState = state.isAdmin ? 'admin' : 'user';   // 確定
      document.body.classList.toggle('is-admin', state.isAdmin);
      const isShared = email.toLowerCase() === 'sales@hanshinco.com';
      const warn = isShared
        ? `<span title="共通アカウントでログインしています。個人メールアドレスでログインしてください。" `
          + `style="cursor:default;font-size:15px">注意</span>`
        : '';
      // 写真があれば <img>、無ければ頭文字丸にフォールバック
      const avatar = photo
        ? `<img src="${esc(photo)}" referrerpolicy="no-referrer" alt="" `
          + `style="width:32px;height:32px;border-radius:50%;object-fit:cover;flex:none" `
          + `onerror="this.outerHTML=userChip('${esc(String(email).replace(/'/g,''))}')">`
        : userChip(email);
      el.innerHTML =
        `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">`
        + avatar
        + warn
        + `<div style="min-width:0;flex:1">`
        +   (name ? `<div style="color:#fff;font-size:12px;font-weight:600;line-height:1.2">${esc(name)}</div>` : '')
        +   `<div style="font-size:10px;word-break:break-all;line-height:1.3">${esc(email)}</div>`
        + `</div>`
        + `</div>`;
    })
    .withFailureHandler(() => {
      // ここで握りつぶすと state.isAdmin が false のままになり、管理者に「権限の無い人の表示」を
      // 見せてしまう（管理者メニューが隠れる）。api() 側で既に数回リトライ済みだが、より長い
      // 一時障害に備えてアプリ側でも間隔を空けて再試行する。
      if (attempt < 3) {
        setTimeout(() => loadCurrentUserLabel(attempt + 1), attempt * 2000);
      } else {
        // 確定できなかった＝'unknown' のまま。黙って一般ユーザーUIに固定せず、ユーザーに再確認手段を出す。
        console.warn('ユーザー権限の取得に失敗しました。管理者メニューが表示されない場合は再読み込みしてください。');
        const el = document.getElementById('user-label');
        if (el && state.adminState === 'unknown') {
          el.innerHTML =
            `<div style="font-size:11px;color:#ffd">権限を確認できませんでした。`
            + `<button id="perm-retry" class="btn btn-secondary btn-xs" style="margin-left:6px">再確認</button></div>`;
          const b = document.getElementById('perm-retry');
          if (b) b.addEventListener('click', () => loadCurrentUserLabel(1));
        }
      }
    })
    .getCurrentUserProfile();
}

// ============================================================
// 初期化
// ============================================================
// 起動入口（旧 window.onload）。auth.js がログイン成功後に呼ぶ。
// ここで初めてアプリ本体を表示し、初期データ取得〜イベント登録を行う。
function boot() {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('app').style.display = '';

  setTodayDates();
  initNav();
  loadInventory();
  loadCurrentUserLabel();

  // イベント登録
  document.getElementById('inv-search').addEventListener('input', filterInventory);
  document.getElementById('inv-cat').addEventListener('change', filterInventory);
  document.getElementById('inv-show-zero').addEventListener('change', filterInventory);

  document.getElementById('btn-csv').addEventListener('click', exportCsv);
  document.getElementById('btn-pull-submit').addEventListener('click', submitPull);
  document.getElementById('btn-ret-submit').addEventListener('click', submitRet);
  document.getElementById('btn-pull-new').addEventListener('click', () => newRequest('pull'));
  document.getElementById('btn-ret-new').addEventListener('click', () => newRequest('ret'));
  bindClick('btn-pull-save', () => saveDraftRequest('pull'));
  bindClick('btn-ret-save',  () => saveDraftRequest('ret'));
  bindClick('btn-pull-draft-log', openDraftLog);
  bindClick('btn-ret-draft-log',  openDraftLog);
  bindClick('draft-close',   () => document.getElementById('draft-modal').classList.add('hidden'));
  bindClick('confirm-cancel', _closeConfirm);
  bindClick('confirm-ok', () => { const cb = _confirmCb; _closeConfirm(); if (cb) cb(); });
  bindClick('draft-log-btn', openDraftLog);
  document.getElementById('btn-rec-import').addEventListener('click', importExcel);
  document.getElementById('btn-rec-register').addEventListener('click', registerReconNew);
  document.getElementById('btn-master-import').addEventListener('click', importYayoiMaster);
  document.getElementById('btn-rec-apply').addEventListener('click', applyReconciliation);
  bindClick('btn-inb-parse', parseInboundPdf);
  bindClick('btn-inb-apply', applyInboundPdf);
  document.getElementById('btn-hist-reload').addEventListener('click', loadHistory);
  document.getElementById('btn-hist-delete').addEventListener('click', deleteSelectedHistory);
  document.getElementById('hist-type').addEventListener('change', loadHistory);
  document.getElementById('hist-select-all').addEventListener('change', function() {
    document.querySelectorAll('.hist-row-cb').forEach(cb => cb.checked = this.checked);
  });
  document.getElementById('np-mizuta-code').addEventListener('input', e => onMizutaCodeInput(e.target.value));

  document.getElementById('btn-np-commit').addEventListener('click', commitNewProduct);
  document.getElementById('btn-np-continue').addEventListener('click', continueNewProduct);

  addItemRow('pull');
  addItemRow('ret');

  // スプレッドシートリンク（スクリプトプロパティから設定するか固定URL）
  document.getElementById('btn-open-ss').addEventListener('click', () => {
    google.script.run.withSuccessHandler(url => {
      if (url) window.open(url, '_blank');
    }).getSpreadsheetUrl();
  });

  applyInitialRoute();   // 現在のURLに合わせて初期パネルを復元（deep link/リロード対応）
};

function setTodayDates() {
  const today    = new Date();
  const yyyymmdd = today.toISOString().slice(0, 10);

  // 翌日
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  document.getElementById('pull-date').value = yyyymmdd;
  document.getElementById('ret-date').value  = tomorrowStr; // 入庫予定日の初期値は翌日

  // 希望到着日は明日以降のみ・初期値も翌日
  document.getElementById('pull-arrival-date').min   = tomorrowStr;
  document.getElementById('pull-arrival-date').value = tomorrowStr;
}

// ============================================================
// ナビゲーション
// ============================================================
const PANEL_TITLES = {
  inventory:    '在庫一覧',
  pull:         '引き寄せ依頼',
  'pull-drafts':'引き寄せ依頼 下書き一覧',
  ret:          '返送依頼',
  'ret-drafts': '返送依頼 下書き一覧',
  newproduct:   '新商品追加',
  reconcile:    '在庫照合（月次）',
  inbound:      '入庫報告書取込',
  history:      '依頼書履歴',
  master:       'マスタ更新',
  help:         '使い方',
};

function initNav() {
  // 親項目（サブメニューを持つ）はクリックで開閉（各々独立。他のサブメニューには触らない）
  document.querySelectorAll('.nav-toggle').forEach(t => {
    t.addEventListener('click', e => {
      e.preventDefault();
      const group = t.dataset.group;
      const sub = document.getElementById('submenu-' + group);
      sub.classList.toggle('open');
      t.classList.toggle('open');
    });
  });
  // パネル切替（子項目とフラット項目どちらも）
  document.querySelectorAll('.nav-link').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      attemptSwitchPanel(a.dataset.panel);
    });
  });
}

// 指定パネルのサブメニュー（親）を自動で開いてactive表示にする
function _openParentSubmenuFor(name) {
  const parent = name === 'pull' || name === 'pull-drafts' ? 'pull'
              : name === 'ret'  || name === 'ret-drafts'  ? 'ret'  : null;
  if (!parent) return;
  const sub = document.getElementById('submenu-' + parent);
  const toggle = document.querySelector('.nav-toggle[data-group="' + parent + '"]');
  if (sub) sub.classList.add('open');
  if (toggle) toggle.classList.add('open');
}

// 引き寄せ/返送で未保存の編集があるまま他ページへ移動しようとしたら確認する
function attemptSwitchPanel(target) {
  const cur = state.currentPanel;
  if ((cur === 'pull' || cur === 'ret') && target !== cur && hasUnsavedRequest(cur)) {
    showConfirm('編集を終了しますか？', '保存していない編集内容は破棄されます。', '終了', () => {
      resetRequestForm(cur); // 破棄
      switchPanel(target);
    });
    return;
  }
  switchPanel(target);
}

// 入力中の品目があるか（未保存の編集とみなす）
function hasUnsavedRequest(mode) {
  return gatherDraftPayload(mode).items.length > 0;
}

// 汎用確認モーダル（OKで onOk を実行）
let _confirmCb = null;
function showConfirm(title, msg, okLabel, onOk) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-msg').textContent   = msg;
  document.getElementById('confirm-ok').textContent     = okLabel || 'OK';
  _confirmCb = onOk || null;
  document.getElementById('confirm-modal').classList.remove('hidden');
}
function _closeConfirm() {
  document.getElementById('confirm-modal').classList.add('hidden');
  _confirmCb = null;
}

// ブラウザの戻る/タブを閉じる/リロード時：未保存の編集があれば標準の離脱警告を出す
window.addEventListener('beforeunload', e => {
  const cur = state.currentPanel;
  if ((cur === 'pull' || cur === 'ret') && hasUnsavedRequest(cur)) {
    e.preventDefault();
    e.returnValue = ''; // これで各ブラウザの確認ダイアログが出る
  }
});

/* ===== ルーティング（History API パス型：各メニューでURL変化。戻る/進む/リロード/ブックマークOK） =====
   demo_rental と同方式。GitHub Pages のサブパス(/mizuta_stock/)は index.html 冒頭の <base> 自動注入で吸収。
   存在しないパスは 404.html(=index.html) が返り、SPAが起動して既定=在庫一覧を表示する。 */
const ROUTE_PANELS = ['inventory','pull','pull-drafts','ret','ret-drafts','newproduct','reconcile','inbound','history','master','help'];
const ROUTE_BASE = window.__BASE || '/';
let _routeSuppress = false;   // popstate/初期復元時は履歴を積まない
function routePath(name) { return ROUTE_BASE + (name === 'inventory' ? '' : name); }   // 在庫一覧はルート(/)
function routeParse() {
  let path = location.pathname;
  if (path.indexOf(ROUTE_BASE) === 0) path = path.slice(ROUTE_BASE.length);
  let seg = (path.split('/').filter(Boolean)[0]) || '';
  if (/^(index|404)\.html$/i.test(seg)) seg = '';        // /index.html・/404.html はルート扱い
  if (!seg) return 'inventory';
  return ROUTE_PANELS.indexOf(seg) >= 0 ? seg : 'inventory';   // 未知パスは在庫一覧へフォールバック
}
// 起動時：現在のURLに従って初期パネルを復元（deep link/リロードでも同じ画面）
function applyInitialRoute() {
  const name = routeParse();
  _routeSuppress = true;
  if (name !== 'inventory') switchPanel(name);          // inventory は既定でactiveなので何もしない
  history.replaceState(null, '', routePath(name));      // URLを正規化
  _routeSuppress = false;
}
// 戻る/進む
window.addEventListener('popstate', function () {
  _routeSuppress = true;
  switchPanel(routeParse());
  _routeSuppress = false;
});

function switchPanel(name) {
  document.querySelectorAll('.nav-link').forEach(a =>
    a.classList.toggle('active', a.dataset.panel === name)
  );
  document.querySelectorAll('.panel').forEach(p =>
    p.classList.toggle('active', p.id === `panel-${name}`)
  );
  document.getElementById('page-title').textContent = PANEL_TITLES[name] || name;
  state.currentPanel = name;
  // 引き寄せ/返送系のページは親サブメニューを自動で開いておく
  _openParentSubmenuFor(name);

  if (name === 'history')      loadHistory();
  if (name === 'inventory')    loadInventory(true);   // ナビ再訪はキャッシュが新しければ通信しない
  if (name === 'pull-drafts')  loadDraftsList('pull');
  if (name === 'ret-drafts')   loadDraftsList('ret');

  // URLを現在のパネルに同期（ナビ/内部遷移では pushState、戻る進む・初期復元では積まない）
  if (!_routeSuppress) {
    const url = routePath(name);
    if (url !== location.pathname) history.pushState(null, '', url);
  }
}

// ============================================================
// Loading overlay
// ============================================================
function showLoading(msg = '処理中…') {
  document.getElementById('overlay').classList.add('show');
  document.getElementById('overlay-msg').textContent = msg;
}
function hideLoading() {
  document.getElementById('overlay').classList.remove('show');
}
// auth.js が API 失敗時（withFailureHandler 未指定）に参照する共通停止関数。
function busyOff() { try { hideLoading(); } catch (e) {} }

// ============================================================
// 在庫一覧
// ============================================================
// useCache=true（ナビでの再訪など）のときは、直近取得のキャッシュが新しければ
// サーバーへ行かず再描画だけで済ませる。重い3シート読みを毎回走らせないことで
// 負荷と、一過性ヒカップに当たる回数を減らす。
// ★在庫が変わる操作（確定・照合・入庫取込・更新ボタン）の後は必ず loadInventory()（引数なし）で
//   サーバーから取り直すこと（キャッシュを使わない＝常に最新を表示）。
const INV_FRESH_MS = 60 * 1000;
function loadInventory(useCache) {
  if (useCache && Array.isArray(state.inventory) && state.inventory.length
      && state._invLoadedAt && (Date.now() - state._invLoadedAt) < INV_FRESH_MS) {
    filterInventory();   // キャッシュから即描画（通信なし）
    return;
  }
  showLoading('在庫データを読み込み中…');
  google.script.run
    .withSuccessHandler(data => {
      hideLoading();
      // 一過性の通信失敗で配列以外が返ることがある。ここで弾いて cryptic な
      // 「Cannot read properties of undefined (reading 'map')」を防ぐ。
      if (!Array.isArray(data)) {
        alert('在庫データを正しく取得できませんでした。通信が不安定な可能性があります。\n'
          + 'お手数ですが、画面を再読み込みしてください。');
        return; // 既存の state.inventory は壊さない（前回表示を保持）
      }
      state.inventory = data;
      state._invLoadedAt = Date.now();
      buildCategoryFilter(data);
      filterInventory();
    })
    .withFailureHandler(err => { hideLoading(); alert('エラー: ' + err.message); })
    .getInventoryList();
}

function buildCategoryFilter(data) {
  const cats = [...new Set(data.map(r => r.cat4Name).filter(Boolean))].sort();
  const sel  = document.getElementById('inv-cat');
  sel.innerHTML = '<option value="">すべて</option>';
  cats.forEach(c => {
    const opt = document.createElement('option');
    opt.value = opt.textContent = c;
    sel.appendChild(opt);
  });
}

function filterInventory() {
  const q       = toHalfKana(document.getElementById('inv-search').value).toLowerCase();
  const cat     = document.getElementById('inv-cat').value;
  const showZero= document.getElementById('inv-show-zero').checked;

  const filtered = state.inventory.filter(r => {
    if (!showZero && r.qty === 0) return false;
    if (r.hidden) return false;
    if (cat    && r.cat4Name !== cat) return false;
    if (q && !(
      fieldIncludes(r.mizutaCode, q) ||
      fieldIncludes(r.mizutaName, q) ||
      fieldIncludes(r.yayoiName,  q)
    )) return false;
    return true;
  });
  renderInventory(filtered, true);
}

function renderInventory(data, filtered = false) {
  const tbody = document.getElementById('inv-tbody');
  tbody.innerHTML = '';
  const showZero = document.getElementById('inv-show-zero').checked;

  const displayed = filtered ? data : data.filter(r => !r.hidden && (showZero || r.qty > 0));

  displayed.forEach(r => {
    const tr = document.createElement('tr');
    if (r.qty === 0) tr.className = 'row-zero';
    tr.innerHTML = `
      <td class="mono">${esc(r.mizutaCode)}</td>
      <td>${esc(r.mizutaName)}</td>
      <td class="mono text-muted" style="font-size:12px">${esc(r.yayoiCode)}</td>
      <td class="text-muted" style="font-size:12px">${esc(r.yayoiName)}</td>
      <td class="text-right">${r.iri}</td>
      <td class="text-right qty">${r.qty}</td>
      <td class="text-right">${r.cases}</td>
      <td class="text-right">${r.bara}</td>
      <td class="text-muted">${esc(r.updatedAt)}</td>
      <td class="text-muted">${esc(r.cat4Name)}</td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById('inv-count').textContent =
    `${displayed.length} 件表示 / 合計 ${data.length} 件`;
}

function statusBadge(s) {
  const map = {
    '通常': 'normal', 'サンプル': 'sample', 'NG': 'ng',
    '旧パッケージ': 'old', '新パッケージ': 'new', 'OS': 'os',
  };
  return `<span class="badge badge-${map[s] || 'normal'}">${esc(s || '通常')}</span>`;
}

// HTMLエスケープ。テキストだけでなく属性値（src="..." title="..." 等）にも差し込むため、
// 引用符 " ' もエスケープして属性からの脱出を防ぐ（値がGoogleプロフィールやマスタでもXSSにしない）。
function esc(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// 半角換算の文字数（半角=1, 全角=2。半角カナは1）
function halfWidthLen(s) {
  let w = 0;
  for (const ch of String(s || '')) {
    const c = ch.codePointAt(0);
    w += (c <= 0x7F || (c >= 0xFF61 && c <= 0xFF9F)) ? 1 : 2;
  }
  return w;
}

// 全角カタカナ → 半角カタカナへ変換（検索時の正規化用）。
// マスタは半角カナ中心だが、ユーザーが全角で検索した時もヒットさせるため、
// 検索文字列・マスタ値の両方をこれで揃えてから比較する。
// 濁点・半濁点付きは2文字に分解される（ガ → ｶﾞ）。
const _KANA_MAP = (function() {
  const m = {
    'ア':'ｱ','イ':'ｲ','ウ':'ｳ','エ':'ｴ','オ':'ｵ',
    'カ':'ｶ','キ':'ｷ','ク':'ｸ','ケ':'ｹ','コ':'ｺ',
    'サ':'ｻ','シ':'ｼ','ス':'ｽ','セ':'ｾ','ソ':'ｿ',
    'タ':'ﾀ','チ':'ﾁ','ツ':'ﾂ','テ':'ﾃ','ト':'ﾄ',
    'ナ':'ﾅ','ニ':'ﾆ','ヌ':'ﾇ','ネ':'ﾈ','ノ':'ﾉ',
    'ハ':'ﾊ','ヒ':'ﾋ','フ':'ﾌ','ヘ':'ﾍ','ホ':'ﾎ',
    'マ':'ﾏ','ミ':'ﾐ','ム':'ﾑ','メ':'ﾒ','モ':'ﾓ',
    'ヤ':'ﾔ','ユ':'ﾕ','ヨ':'ﾖ',
    'ラ':'ﾗ','リ':'ﾘ','ル':'ﾙ','レ':'ﾚ','ロ':'ﾛ',
    'ワ':'ﾜ','ヲ':'ｦ','ン':'ﾝ',
    'ガ':'ｶﾞ','ギ':'ｷﾞ','グ':'ｸﾞ','ゲ':'ｹﾞ','ゴ':'ｺﾞ',
    'ザ':'ｻﾞ','ジ':'ｼﾞ','ズ':'ｽﾞ','ゼ':'ｾﾞ','ゾ':'ｿﾞ',
    'ダ':'ﾀﾞ','ヂ':'ﾁﾞ','ヅ':'ﾂﾞ','デ':'ﾃﾞ','ド':'ﾄﾞ',
    'バ':'ﾊﾞ','ビ':'ﾋﾞ','ブ':'ﾌﾞ','ベ':'ﾍﾞ','ボ':'ﾎﾞ',
    'パ':'ﾊﾟ','ピ':'ﾋﾟ','プ':'ﾌﾟ','ペ':'ﾍﾟ','ポ':'ﾎﾟ',
    'ァ':'ｧ','ィ':'ｨ','ゥ':'ｩ','ェ':'ｪ','ォ':'ｫ',
    'ッ':'ｯ','ャ':'ｬ','ュ':'ｭ','ョ':'ｮ',
    'ヴ':'ｳﾞ','ー':'ｰ','・':'･','「':'｢','」':'｣','、':'､','。':'｡',
  };
  return m;
})();
// 関数名は kana だが、検索用の総合正規化として全角ASCII(英数字・記号・括弧)・全角スペースも半角化する。
function toHalfKana(s) {
  return String(s == null ? '' : s)
    // 全角カナ・全角記号 → 半角カナ
    .replace(/[、-ヿ]/g, ch => _KANA_MAP[ch] || ch)
    // 全角ASCII(！〜～ = ０-９/Ａ-Ｚ/ａ-ｚ/（）など) → 半角ASCII
    .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    // 全角スペース → 半角スペース
    .replace(/　/g, ' ');
}

// CSV エクスポート
function exportCsv() {
  const q       = toHalfKana(document.getElementById('inv-search').value).toLowerCase();
  const cat     = document.getElementById('inv-cat').value;
  const showZero= document.getElementById('inv-show-zero').checked;

  const filtered = state.inventory.filter(r => {
    if (!showZero && r.qty === 0) return false;
    if (r.hidden) return false;
    if (cat && r.cat4Name !== cat) return false;
    if (q && !(fieldIncludes(r.mizutaCode, q) || fieldIncludes(r.mizutaName, q))) return false;
    return true;
  });

  const header = ['ミズタコード','弥生コード','商品名','状態','入数','在庫数','ケース数','内バラ数','最終更新','分類4'];
  const rows = filtered.map(r => [
    r.mizutaCode, r.yayoiCode, r.mizutaName || r.yayoiName,
    r.status, r.iri, r.qty, r.cases, r.bara, r.updatedAt, r.cat4Name,
  ]);
  const csv = [header, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\r\n');
  const bom  = '﻿';
  const blob = new Blob([bom + csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: '在庫一覧.csv' });
  a.click(); URL.revokeObjectURL(url);
}

// ============================================================
// 依頼書 共通：商品行
// ============================================================
let itemRowCounter = 0;

// 検索可能なテキストボックス1つぶんの <td> を生成。どのボックスに打っても
// 全フィールド横断で検索し、選択すると4ボックス＋数量系がまとめて埋まる。
// 返送モード × ミズタ商品名のときだけ、文字数カウンタも更新するため onMnameChange を追加で呼ぶ。
function itemSearchCell(mode, id, cls, placeholder) {
  const extra = (mode === 'ret' && cls === 'item-mname')
    ? `;onMnameChange(this,'${mode}',${id})`
    : '';
  return `
    <td>
      <div class="autocomplete-wrap">
        <input type="text" class="${cls} item-search w-full" placeholder="${placeholder}"
          oninput="onItemEdit(this, '${mode}', ${id})${extra}"
          onfocus="onItemSearch(this, '${mode}', ${id})">
        <ul class="autocomplete-list hidden item-ac-list"></ul>
      </div>
    </td>`;
}

function addItemRow(mode) {
  const id = ++itemRowCounter;
  const tbody = document.getElementById(`${mode}-items`);
  const tr = document.createElement('tr');
  tr.dataset.rowId = id;

  const isPull = mode === 'pull';
  const isRet  = mode === 'ret';
  const noteCell = isPull
    ? `<td><input type="text" class="item-note w-full" style="min-width:100px"></td>`
    : `<td><input type="text" class="item-note w-full" style="min-width:160px" placeholder="JAN等"></td>`;
  const stockCell = isPull ? `<td class="text-right item-stock qty" data-code="">-</td>` : '';
  // 返送: ミズタ商品名の右隣に文字数列を追加
  const nameLenCell = isRet ? `<td class="text-right item-namelen qty">0</td>` : '';
  // 返送: 入数を編集可能 input に。引き寄せは従来どおり表示のみ。
  const iriCell = isRet
    ? `<td><input type="number" class="item-iri-input qty" min="1" placeholder="-" style="width:62px;text-align:right" oninput="onIriChange(this,'ret',${id})"></td>`
    : `<td class="text-right item-iri-disp qty">-</td>`;

  tr.innerHTML =
      itemSearchCell(mode, id, 'item-ycode', 'コード(弥生)')
    + itemSearchCell(mode, id, 'item-yname', '商品名(弥生)')
    + itemSearchCell(mode, id, 'item-mcode', 'コード(ミズタ)')
    + itemSearchCell(mode, id, 'item-mname', '商品名(ミズタ)')
    + nameLenCell
    + iriCell
    + `<td>
        <input type="number" class="item-qty" min="1" value=""
          oninput="onQtyChange(this, '${mode}', ${id})">
        <input type="hidden" class="item-code">
        <input type="hidden" class="item-iri" value="1">
      </td>`
    + `<td class="text-right item-cases qty">-</td>`
    + `<td class="text-right item-bara qty">-</td>`
    + stockCell
    + noteCell
    + `<td><button class="btn btn-danger btn-xs" onclick="removeItemRow(this, '${mode}')">×</button></td>`;
  tbody.appendChild(tr);
}

function removeItemRow(btn, mode) {
  btn.closest('tr').remove();
  updateTotals(mode);
}

// 新規作成：確認のうえ、入力・警告・作成結果をすべてリセット
function newRequest(mode) {
  if (!confirm('入力内容・警告・作成結果をすべてクリアして新規作成します。よろしいですか？')) return;
  resetRequestForm(mode);
}

// PDF作成成功後用：注意書きと作成結果カードは残し、フォーム入力だけクリア
function clearFormKeepingResult(mode) {
  if (state.loadedDraft) state.loadedDraft[mode] = null;
  const tbody = document.getElementById(`${mode}-items`);
  tbody.innerHTML = '';
  addItemRow(mode);
  if (mode === 'pull') {
    const dl = document.getElementById('pull-delivery');
    if (dl) dl.selectedIndex = 0;
  }
  setTodayDates();
  updateTotals(mode);
}

function resetRequestForm(mode) {
  // 読み込み中の下書き紐付けも解除
  if (state.loadedDraft) state.loadedDraft[mode] = null;
  // プレビュー中なら破棄
  if (mode === 'pull' && state.previewPull) {
    const pid = state.previewPull.pdfId;
    state.previewPull = null;
    document.getElementById('panel-pull').classList.remove('preview-locked');
    if (pid) google.script.run.withFailureHandler(() => {}).cancelPreviewPdf(pid);
  }
  if (mode === 'ret' && state.previewRet) {
    const pid = state.previewRet.pdfId;
    state.previewRet = null;
    document.getElementById('panel-ret').classList.remove('preview-locked');
    if (pid) google.script.run.withFailureHandler(() => {}).cancelPreviewPdf(pid);
  }
  // 商品行を全消去して空行を1つだけに戻す
  const tbody = document.getElementById(`${mode}-items`);
  tbody.innerHTML = '';
  addItemRow(mode);

  // 警告・作成結果をクリア
  const alerts = document.getElementById(`${mode}-alerts`);
  if (alerts) alerts.innerHTML = '';
  const result = document.getElementById(`${mode}-result`);
  if (result) { result.innerHTML = ''; result.classList.add('hidden'); }

  // 配送方法・日付を初期値へ
  if (mode === 'pull') {
    const dl = document.getElementById('pull-delivery');
    if (dl) dl.selectedIndex = 0;
  }
  setTodayDates();
  updateTotals(mode);
}

// ============================================================
// 下書き（途中保存）
// ============================================================
// 現在のフォーム内容を緩く収集（未完成でも保存可）
function gatherDraftPayload(mode) {
  const head = {};
  if (mode === 'pull') {
    head.date        = document.getElementById('pull-date').value;
    head.delivery    = document.getElementById('pull-delivery').value;
    head.arrivalDate = document.getElementById('pull-arrival-date').value;
  } else {
    head.date = document.getElementById('ret-date').value;
  }
  const items = [];
  document.querySelectorAll(`#${mode}-items tr`).forEach(tr => {
    const g = sel => { const e = tr.querySelector(sel); return e ? e.value : ''; };
    const item = {
      code:  g('.item-code'),
      ycode: g('.item-ycode'), yname: g('.item-yname'),
      mcode: g('.item-mcode'), mname: g('.item-mname'),
      iri:   g('.item-iri'),   qty:   g('.item-qty'),  note: g('.item-note'),
    };
    if (item.code || item.ycode || item.yname || item.mcode || item.mname || item.qty || item.note) {
      items.push(item);
    }
  });
  return { mode, head, items };
}

function saveDraftRequest(mode) {
  const payload = gatherDraftPayload(mode);
  if (!payload.items.length) { alert('保存する内容がありません。'); return; }
  const typeLabel    = mode === 'pull' ? '引き寄せ' : '返送';
  const defaultLabel = `${typeLabel} ${payload.head.date || ''}（${payload.items.length}品）`;
  const label = prompt('下書きの名前を入力してください。', defaultLabel);
  if (label === null) return;

  const existingId = state.loadedDraft[mode]; // 呼び出し中の下書きがあれば同じIDを上書き更新
  showLoading('下書きを保存中…');
  const onDone = res => {
    hideLoading();
    if (res && res.success) {
      // ret モード: 下書きスプシ操作の警告があれば、フォームを残したまま再保存を促す
      if (res.sheetWarning) {
        alert('下書き本体は保存しましたが、スプシ操作に失敗しました。\n\n'
          + res.sheetWarning + '\n\n'
          + 'もう一度「下書き保存」を押してリトライしてください。');
        return; // フォームはそのまま、リセットしない
      }
      alert(existingId ? '下書きを更新しました。' : '下書きを保存しました。');
      resetRequestForm(mode); // 保存後はフォームを全クリアして次の作業へ
    } else {
      alert('保存に失敗しました' + (res && res.message ? '：' + res.message : ''));
    }
  };
  const runner = google.script.run
    .withSuccessHandler(onDone)
    .withFailureHandler(err => { hideLoading(); alert('保存エラー: ' + err.message); });

  if (existingId) {
    runner.updateRequestDraft(existingId, mode, label, JSON.stringify(payload));
  } else {
    runner.saveRequestDraft(mode, label, JSON.stringify(payload));
  }
}

let _draftModalMode = 'pull';

// 操作者アイコン（頭文字の色付き丸・title でメール表示）
function userChip(email) {
  const e = String(email || '');
  const initial = (e.replace(/[^A-Za-z0-9]/, '')[0] || e[0] || '?').toUpperCase();
  let h = 0;
  for (const ch of e) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const color = `hsl(${h},50%,45%)`;
  return `<span class="user-chip" title="${esc(e)}" style="background:${color}">${esc(initial)}</span>`;
}

// Googleプロフィール写真があれば <img>、無ければ頭文字丸にフォールバック。
// profileMap は ensureProfiles で取得したマップ
function userAvatar(email, profileMap) {
  const e = String(email || '');
  const p = profileMap && profileMap[e.toLowerCase()];
  if (p && p.photoUrl) {
    const tip = p.name ? `${p.name} (${e})` : e;
    const safeE = esc(String(e).replace(/'/g, ''));
    return `<img src="${esc(p.photoUrl)}" referrerpolicy="no-referrer" alt="" title="${esc(tip)}" `
      + `style="width:24px;height:24px;border-radius:50%;object-fit:cover;flex:none;cursor:default" `
      + `onerror="this.outerHTML=userChip('${safeE}')">`;
  }
  return userChip(e);
}

// 指定メール群のプロフィールをキャッシュから取得。未取得分はサーバーへ問い合わせ。
// cb には常に最新のキャッシュマップを渡す（取れなかったメールは name/photo空でキャッシュして再要求を防ぐ）
function ensureProfiles(emails, cb) {
  const need = [];
  const seen = {};
  (emails || []).forEach(e => {
    const s = String(e || '').trim().toLowerCase();
    if (!s || seen[s]) return;
    seen[s] = true;
    if (!state._profileCache[s]) need.push(s);
  });
  if (!need.length) { cb(state._profileCache); return; }
  google.script.run
    .withSuccessHandler(map => {
      for (const k in map) state._profileCache[k] = map[k];
      // 取れなかったものも空エントリで埋めて次回フェッチを抑止
      need.forEach(e => { if (!state._profileCache[e]) state._profileCache[e] = { email: e, name: '', photoUrl: '' }; });
      cb(state._profileCache);
    })
    .withFailureHandler(() => cb(state._profileCache))
    .getUserProfiles(need);
}

function openDraftModal(mode) {
  _draftModalMode = mode;
  document.getElementById('draft-modal-title').textContent = '下書き一覧';
  showLoading('下書きを読み込み中…');
  google.script.run
    .withSuccessHandler(list => {
      hideLoading();
      renderDraftList(mode, list);
      document.getElementById('draft-modal').classList.remove('hidden');
    })
    .withFailureHandler(err => { hideLoading(); alert('エラー: ' + err.message); })
    .listRequestDrafts(mode);
}

// パネル用：指定モードの下書きをサーバーから取得して該当パネルに描画
function loadDraftsList(mode) {
  showLoading('下書きを読み込み中…');
  google.script.run
    .withSuccessHandler(list => {
      hideLoading();
      renderDraftList(mode, list, `${mode}-draft-list`);
    })
    .withFailureHandler(err => { hideLoading(); alert('エラー: ' + err.message); })
    .listRequestDrafts(mode);
}

function renderDraftList(mode, list, containerId) {
  const box = document.getElementById(containerId || 'draft-list');
  box.innerHTML = '';
  if (!list || !list.length) {
    box.innerHTML = '<p class="text-muted" style="padding:8px">保存された下書きはありません。</p>';
    return;
  }
  ensureProfiles(list.map(d => d.user), profileMap => {
    box.innerHTML = '';
    list.forEach(d => {
      const row = document.createElement('div');
      row.className = 'draft-row';
      const info = document.createElement('div');
      info.style.display = 'flex';
      info.style.alignItems = 'center';
      info.style.gap = '8px';
      info.innerHTML = userAvatar(d.user, profileMap)
        + `<span><strong>${esc(d.label)}</strong>`
        + `<br><span style="font-size:11px;color:var(--gray-600)">${esc(d.updatedAt)}</span></span>`;
      const btns = document.createElement('div');
      btns.className = 'gap-8';
      const histBtn = document.createElement('button');
      histBtn.className = 'btn btn-secondary btn-xs';
      histBtn.textContent = '履歴';
      histBtn.addEventListener('click', () => openDraftLogForId(d.id, d.label));
      // 返送モード: 下書きスプシを別タブで開く（倉庫が段ボール貼付のコピペ用に使う）
      let ssBtn = null;
      if (mode === 'ret' && d.sheetUrl) {
        ssBtn = document.createElement('a');
        ssBtn.href = d.sheetUrl;
        ssBtn.target = '_blank';
        ssBtn.className = 'btn btn-outline btn-xs';
        ssBtn.textContent = 'スプシ';
      }
      const openBtn = document.createElement('button');
      openBtn.className = 'btn btn-primary btn-xs';
      openBtn.textContent = '開く';
      openBtn.addEventListener('click', () => loadDraftRequest(mode, d.id));
      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-danger btn-xs';
      delBtn.textContent = '削除';
      delBtn.addEventListener('click', () => deleteDraftRequest(mode, d.id));
      btns.append(histBtn);
      if (ssBtn) btns.append(ssBtn);
      btns.append(openBtn, delBtn);
      row.append(info, btns);
      box.appendChild(row);
    });
  });
}

// 操作ログ表示（モーダルで開く）。全件モード（最新200件まで）
function openDraftLog() {
  document.getElementById('draft-modal-title').textContent = '下書き操作ログ（最新200件）';
  showLoading('操作ログを読み込み中…');
  google.script.run
    .withSuccessHandler(logs => {
      hideLoading();
      renderDraftLog(logs);
      document.getElementById('draft-modal').classList.remove('hidden');
    })
    .withFailureHandler(err => { hideLoading(); alert('エラー: ' + err.message); })
    .listDraftLogs(null, 200);
}

// 特定の下書きの操作ログだけをモーダルで表示
function openDraftLogForId(draftId, label) {
  document.getElementById('draft-modal-title').textContent = '' + (label ? esc(label) : '下書き') + ' の履歴';
  showLoading('履歴を読み込み中…');
  google.script.run
    .withSuccessHandler(logs => {
      hideLoading();
      renderDraftLog(logs);
      document.getElementById('draft-modal').classList.remove('hidden');
    })
    .withFailureHandler(err => { hideLoading(); alert('エラー: ' + err.message); })
    .listDraftLogs(draftId);
}

function renderDraftLog(logs) {
  const box = document.getElementById('draft-list');
  box.innerHTML = '';
  if (!logs || !logs.length) {
    box.innerHTML = '<p class="text-muted" style="padding:8px">操作ログはまだありません。</p>';
    return;
  }
  const cls = a => a === '作成' ? 'create' : (a === '削除' || a === '行削除') ? 'delete' : 'add';
  ensureProfiles(logs.map(g => g.user), profileMap => {
    box.innerHTML = '';
    logs.forEach(g => {
      const row = document.createElement('div');
      row.className = 'log-row';
      const detail = []
        .concat(g.added       ? [`＋${esc(g.added)}`]         : [])
        .concat(g.qtyChanges  ? [`${esc(g.qtyChanges)}`]   : [])
        .concat(g.removed     ? [`－${esc(g.removed)}`]       : [])
        .join('　');
      row.innerHTML =
        userAvatar(g.user, profileMap)
        + `<span class="log-badge ${cls(g.action)}">${esc(g.action)}</span>`
        + `<span style="flex:1;min-width:0">`
        +   `<strong>${esc(g.label || '(無題)')}</strong>`
        +   (detail ? `<br><span style="color:var(--gray-600)">${detail}</span>` : '')
        + `</span>`
        + `<span style="font-size:11px;color:var(--gray-600);white-space:nowrap">${esc(g.at)}</span>`;
      box.appendChild(row);
    });
  });
}

function loadDraftRequest(mode, id) {
  showLoading('下書きを開いています…');
  google.script.run
    .withSuccessHandler(res => {
      hideLoading();
      if (!res.success) { alert(res.message); return; }
      let payload;
      try { payload = JSON.parse(res.json); } catch (e) { alert('下書きデータが壊れています。'); return; }
      applyDraftPayload(mode, payload);
      state.loadedDraft[mode] = id; // PDF作成成功時に自動削除するため記憶
      // フォーム画面（新規作成側）へ遷移
      switchPanel(mode);
    })
    .withFailureHandler(err => { hideLoading(); alert('エラー: ' + err.message); })
    .loadRequestDraft(id);
}

function deleteDraftRequest(mode, id) {
  if (!confirm('この下書きを削除しますか？')) return;
  google.script.run
    .withSuccessHandler(() => loadDraftsList(mode)) // 一覧パネルを再読込
    .withFailureHandler(err => alert('削除エラー: ' + err.message))
    .deleteRequestDraft(id);
}

function applyDraftPayload(mode, payload) {
  const head = payload.head || {};
  if (mode === 'pull') {
    if (head.date)        document.getElementById('pull-date').value = head.date;
    if (head.delivery !== undefined) document.getElementById('pull-delivery').value = head.delivery;
    if (head.arrivalDate) document.getElementById('pull-arrival-date').value = head.arrivalDate;
  } else {
    if (head.date) document.getElementById('ret-date').value = head.date;
  }

  const tbody = document.getElementById(`${mode}-items`);
  tbody.innerHTML = '';
  const items = payload.items || [];
  if (!items.length) { addItemRow(mode); updateTotals(mode); return; }

  items.forEach(it => {
    addItemRow(mode);
    const tr = tbody.lastElementChild;
    tr.querySelector('.item-ycode').value = it.ycode || '';
    tr.querySelector('.item-yname').value = it.yname || '';
    tr.querySelector('.item-mcode').value = it.mcode || '';
    tr.querySelector('.item-mname').value = it.mname || '';
    tr.querySelector('.item-code').value  = it.code  || '';
    tr.querySelector('.item-iri').value   = it.iri   || 1;
    const irid = tr.querySelector('.item-iri-disp');
    if (irid) irid.textContent = it.code ? (it.iri || 1) : '-';
    // 返送モード: 入数 input と文字数カウンタも反映
    const iriInputEl = tr.querySelector('.item-iri-input');
    if (iriInputEl) iriInputEl.value = it.iri || '';
    if (mode === 'ret') _updateNameLenCell(tr);
    tr.querySelector('.item-qty').value   = it.qty   || '';
    tr.querySelector('.item-note').value  = it.note  || '';
    // 在庫表示（引き寄せ）
    if (mode === 'pull' && it.code) {
      const stock = tr.querySelector('.item-stock');
      const inv   = state.inventory.find(r => r.mizutaCode === it.code);
      if (stock && inv) {
        stock.dataset.code = it.code;
        stock.textContent  = inv.qty;
        stock.style.color  = inv.qty === 0 ? 'var(--danger)' : '';
      }
    }
    onQtyChange(tr.querySelector('.item-qty'), mode);
  });
  updateTotals(mode);
}

// 依頼書作成の品目検索：state.inventory キャッシュをブラウザ内で絞り込む。
// サーバー往復・3シート全読込を行わないため即時に反応する。
// （在庫数の鮮度が必要な場面は selectItem 側で別途取得する想定）
// 数値だけのコード/品名はシートから Number 型で来るため、必ず String 化してから比較する。
// マスタ値も検索文字列もどちらも半角カナ化してから比較する（呼び出し側で ql は toHalfKana(q).toLowerCase() 済み前提）。
function fieldIncludes(v, ql) {
  return toHalfKana(String(v == null ? '' : v)).toLowerCase().includes(ql);
}

function searchInventoryLocal(q, incNG, incSample, incOld) {
  const ql = toHalfKana(q).toLowerCase();
  return state.inventory
    .filter(r => {
      if (r.hidden) return false;
      if (r.status === 'NG' && !incNG) return false;
      if (r.status === 'サンプル' && !incSample) return false;
      if (r.status === '旧パッケージ' && !incOld) return false;
      if (!ql) return true;
      return (
        fieldIncludes(r.mizutaCode, ql) ||
        fieldIncludes(r.mizutaName, ql) ||
        fieldIncludes(r.yayoiName,  ql) ||
        fieldIncludes(r.yayoiCode,  ql)
      );
    })
    .slice(0, 30);
}

// 検索ボックスを手入力で変更したら、確定済みの選択を解除（再選択するまで未確定）。
// フォーカスのみ（値が変わらない）では解除しないので、onfocus とは分ける。
function onItemEdit(input, mode, rowId) {
  input.closest('tr').querySelector('.item-code').value = '';
  onItemSearch(input, mode, rowId);
}

function onItemSearch(input, mode, rowId) {
  const q         = input.value.trim();
  const tr        = input.closest('tr');
  const acList    = input.closest('.autocomplete-wrap').querySelector('.item-ac-list');
  // 操作中のボックスの候補のみ表示し、他のボックスの候補リストは閉じる
  document.querySelectorAll('.autocomplete-list').forEach(l => {
    if (l !== acList) l.classList.add('hidden');
  });
  // フィルタUIは廃止。NG・サンプル・旧パッケージも含め全件を検索対象にする
  const incNG = true, incSample = true, incOld = true;

  // どれかの検索ボックスを空欄にしたら行全体（4ボックス＋選択情報）をクリア
  // ただし返送モードはエクセルライク化のため、空欄でも行を保持する
  if (q.length < 1) {
    acList.classList.add('hidden');
    if (mode !== 'ret') clearItemRow(tr, mode);
    return;
  }

  const results = searchInventoryLocal(q, incNG, incSample, incOld);

  acList.innerHTML = '';
  if (!results.length) {
    acList.innerHTML = '<li class="text-muted" style="padding:8px">該当なし</li>';
    positionAcList(input, acList);
    acList.classList.remove('hidden');
    return;
  }
  results.forEach(r => {
    const li = document.createElement('li');
    const yayoiLine = (r.yayoiCode || r.yayoiName)
      ? `<div style="font-size:11px;color:var(--gray-600);margin-top:1px">`
        + `弥生: <span style="font-family:monospace">${esc(r.yayoiCode)}</span>`
        + (r.yayoiName ? `　${esc(r.yayoiName)}` : '')
        + `</div>`
      : '';
    li.innerHTML = `<span class="ac-code">${esc(r.mizutaCode)}</span> `
      + `<span class="ac-name">${esc(r.mizutaName)}</span> `
      + `<span class="ac-qty">在庫:${r.qty}</span>`
      + yayoiLine;
    li.addEventListener('click', () => {
      selectItem(tr, r, mode);
      acList.classList.add('hidden');
    });
    acList.appendChild(li);
  });
  positionAcList(input, acList);
  acList.classList.remove('hidden');
}

function selectItem(tr, r, mode) {
  tr.querySelector('.item-code').value  = r.mizutaCode;
  tr.querySelector('.item-iri').value   = r.iri;
  // 入数の表示更新: 引き寄せは表示専用セル、返送は編集可 input にミラー
  const iriDisp = tr.querySelector('.item-iri-disp');
  if (iriDisp) iriDisp.textContent = r.iri;
  const iriInput = tr.querySelector('.item-iri-input');
  if (iriInput) {
    iriInput.value = r.iri;
    iriInput.classList.remove('iri-err');
  }
  // 4ボックスをまとめて埋める
  tr.querySelector('.item-ycode').value = r.yayoiCode  || '';
  tr.querySelector('.item-yname').value = r.yayoiName  || '';
  tr.querySelector('.item-mcode').value = r.mizutaCode || '';
  tr.querySelector('.item-mname').value = r.mizutaName || '';
  // 返送は摘要に弥生コードを自動挿入（無い／「不明」なら空欄）＋ 文字数カウンタ更新
  if (mode === 'ret') {
    const note = tr.querySelector('.item-note');
    if (note) {
      const y = (r.yayoiCode || '').trim();
      note.value = (y === '不明') ? '' : y;
    }
    _updateNameLenCell(tr);
  }
  if (mode === 'pull') {
    const stockCell = tr.querySelector('.item-stock');
    if (stockCell) {
      stockCell.dataset.code = r.mizutaCode;
      stockCell.textContent  = r.qty;
      stockCell.style.color  = r.qty === 0 ? 'var(--danger)' : '';
    }
  }
  onQtyChange(tr.querySelector('.item-qty'), mode, tr.dataset.rowId);
}

// 行の商品選択を解除：4つの検索ボックスと選択情報・計算列をリセット（数量・備考は残す）
// 注: 返送モードは onItemSearch 側で本関数を呼ばないため、ここに ret 専用処理は不要
function clearItemRow(tr, mode) {
  ['.item-ycode', '.item-yname', '.item-mcode', '.item-mname']
    .forEach(sel => { tr.querySelector(sel).value = ''; });
  tr.querySelector('.item-code').value = '';
  tr.querySelector('.item-iri').value  = '1';
  const iriDisp = tr.querySelector('.item-iri-disp');
  if (iriDisp) iriDisp.textContent = '-';
  tr.querySelector('.item-cases').textContent = '-';
  tr.querySelector('.item-bara').textContent  = '-';
  const stockCell = tr.querySelector('.item-stock');
  if (stockCell) {
    stockCell.dataset.code = '';
    stockCell.textContent  = '-';
    stockCell.style.color  = '';
  }
  updateTotals(mode);
}

function onQtyChange(input, mode) {
  const tr   = input.closest('tr');
  const qty  = parseInt(input.value) || 0;
  // 入数: 返送モードでは編集可 input、引き寄せでは hidden を使う
  const iriInput = tr.querySelector('.item-iri-input');
  const iri  = parseInt(iriInput ? iriInput.value : tr.querySelector('.item-iri').value) || 0;
  const validIri = iri > 0;
  const cases = validIri ? Math.floor(qty / iri) : 0;
  const bara  = validIri ? qty % iri : 0;
  // 入数が0/空のときはケース・バラを "-" 表示（要望c）
  tr.querySelector('.item-cases').textContent = (qty && validIri) ? cases : '-';
  tr.querySelector('.item-bara').textContent  = (qty && validIri) ? bara  : '-';
  // 引き寄せでは在庫数を超える数量を赤塗り＆ツールチップで警告
  if (mode === 'pull') {
    const stockCell = tr.querySelector('.item-stock');
    const stock = stockCell ? parseInt(stockCell.textContent) : NaN;
    if (!isNaN(stock) && qty > 0 && qty > stock) {
      input.classList.add('qty-over');
      input.title = `在庫不足：在庫 ${stock} 個 / 入力 ${qty} 個`;
    } else {
      input.classList.remove('qty-over');
      input.title = '';
    }
  }
  updateTotals(mode);
}

function updateTotals(mode) {
  const tbody = document.getElementById(`${mode}-items`);
  let totalQty = 0, totalCases = 0;
  tbody.querySelectorAll('tr').forEach(tr => {
    const qty  = parseInt(tr.querySelector('.item-qty').value)  || 0;
    const iriInput = tr.querySelector('.item-iri-input');
    const iri  = parseInt(iriInput ? iriInput.value : tr.querySelector('.item-iri').value) || 0;
    totalQty   += qty;
    if (iri > 0) totalCases += Math.floor(qty / iri);
  });
  document.getElementById(`${mode}-total-qty`).textContent   = totalQty;
  document.getElementById(`${mode}-total-cases`).textContent = totalCases;
}

function collectItems(mode) {
  const tbody = document.getElementById(`${mode}-items`);
  const items = [];
  let error   = null;
  tbody.querySelectorAll('tr').forEach(tr => {
    // ---- 返送モード: エクセルライク。マスタ突合に依存せず、フォーム入力値をそのまま採用 ----
    if (mode === 'ret') {
      const mcode = tr.querySelector('.item-mcode').value.trim();
      const mname = tr.querySelector('.item-mname').value.trim();
      const yayoiCode  = tr.querySelector('.item-ycode').value.trim();
      const yayoiName  = tr.querySelector('.item-yname').value.trim();
      const qty   = parseInt(tr.querySelector('.item-qty').value) || 0;
      const iriInput = tr.querySelector('.item-iri-input');
      const iriRaw   = iriInput ? iriInput.value : tr.querySelector('.item-iri').value;
      const iri   = parseInt(iriRaw);
      const note  = tr.querySelector('.item-note').value.trim();
      // 「使用中の行」判定: ミズタコード / ミズタ商品名 / 数量 のいずれかが入っていれば
      if (!mcode && !mname && qty <= 0) return;
      if (!mcode) { error = 'ミズタコードが空の行があります。'; return; }
      if (!mname) { error = `ミズタ商品名が空の行があります（${mcode}）。`; return; }
      if (halfWidthLen(mname) > 36) {
        error = `ミズタ商品名が36バイトを超えている行があります（${mcode}）。`; return;
      }
      if (isNaN(iri) || iri <= 0) {
        error = `入数が0または空欄の行があります（${mcode}）。`; return;
      }
      if (qty <= 0) { error = `数量が0または空欄の行があります（${mcode}）。`; return; }
      items.push({ mizutaCode: mcode, mizutaName: mname, yayoiName, yayoiCode, qty, iri, note });
      return;
    }
    // ---- 引き寄せモード: 従来通り、マスタ選択ベース ----
    const code = tr.querySelector('.item-code').value.trim();
    const qty  = parseInt(tr.querySelector('.item-qty').value) || 0;
    const iri  = parseInt(tr.querySelector('.item-iri').value) || 1;
    const note = tr.querySelector('.item-note').value.trim();
    const mizutaName = tr.querySelector('.item-mname').value.trim();
    const yayoiName  = tr.querySelector('.item-yname').value.trim();
    const yayoiCode  = tr.querySelector('.item-ycode').value.trim();
    // いずれかの検索ボックスに入力があれば「使用中の行」とみなす
    const hasInput = ['.item-ycode', '.item-yname', '.item-mcode', '.item-mname']
      .some(sel => tr.querySelector(sel).value.trim());

    if (!hasInput) return;
    if (!code) { error = '商品が選択されていない行があります。'; return; }
    if (qty <= 0) { error = '数量が入力されていない行があります。'; return; }

    items.push({ mizutaCode: code, mizutaName, yayoiName, yayoiCode, qty, iri, note });
  });
  return { items, error };
}

// 返送モード: 入数 input の変化で hidden item-iri にミラーし、ケース/バラを即時再計算。
//   入数=0/空 のときは入数セルを赤塗り（要望b/c）。
function onIriChange(input, mode, rowId) {
  const tr = input.closest('tr');
  const v  = parseInt(input.value);
  const valid = !isNaN(v) && v > 0;
  // hidden item-iri へミラー（updateTotals 等の既存処理は hidden 経由でも整合させる）。
  // 無効値時は 0 を入れ、計算系（updateTotals/onQtyChange）側で「0=計算しない」とみなす。
  tr.querySelector('.item-iri').value = valid ? v : 0;
  input.classList.toggle('iri-err', !valid);
  // 数量と組み合わせてケース/バラ再計算
  const qtyEl = tr.querySelector('.item-qty');
  if (qtyEl) onQtyChange(qtyEl, mode, rowId);
}

// 返送モード: ミズタ商品名 input の変化で文字数セルを再計算（36バイト超で赤塗り）。
function onMnameChange(input, mode, rowId) {
  const tr = input.closest('tr');
  _updateNameLenCell(tr);
}

function _updateNameLenCell(tr) {
  const mnameEl = tr.querySelector('.item-mname');
  const cell    = tr.querySelector('.item-namelen');
  if (!cell || !mnameEl) return;
  const len = halfWidthLen(mnameEl.value);
  cell.textContent = len;
  cell.classList.toggle('byte-over', len > 36);
}

// ============================================================
// 引き寄せ依頼送信
// ============================================================
// プレビュー：サーバーで在庫不足チェック＋PDF生成のみ実行（在庫減算・メール下書きはまだ走らない）
function submitPull() {
  const date        = document.getElementById('pull-date').value;
  const delivery    = document.getElementById('pull-delivery').value;
  const arrivalDate = document.getElementById('pull-arrival-date').value;
  if (!date)     { alert('依頼日を入力してください。'); return; }
  if (!delivery) { alert('配送方法を選択してください。'); return; }

  const { items, error } = collectItems('pull');
  if (error)             { alert(error); return; }
  if (!items.length)     { alert('商品を1件以上追加してください。'); return; }

  // 警告アラート欄クリア
  document.getElementById('pull-alerts').innerHTML = '';

  const params = {
    date: date.replace(/-/g, '/'),
    delivery: delivery,
    arrivalDate: arrivalDate ? arrivalDate.replace(/-/g, '/') : '',
    items: items,
  };

  showLoading('プレビューを生成中…');
  google.script.run
    .withSuccessHandler(res => {
      hideLoading();
      // フォーム編集を一時ロック＆プレビュー結果表示
      document.getElementById('panel-pull').classList.add('preview-locked');
      state.previewPull = { pdfId: res.pdfId, params: params };
      showPullPreview(res);
    })
    .withFailureHandler(err => {
      hideLoading();
      document.getElementById('pull-alerts').innerHTML =
        `<div class="alert alert-danger">${esc(err.message).replace(/\n/g, '<br>')}</div>`;
    })
    .previewPullRequest(params);
}

// プレビュー結果カードを描画
function showPullPreview(res) {
  const div = document.getElementById('pull-result');
  let warningsHtml = '';
  if (res.warnings && res.warnings.length) {
    warningsHtml = res.warnings.map(w =>
      `<div class="alert alert-warning">${esc(w)}</div>`
    ).join('');
  }
  div.innerHTML = `
    ${warningsHtml}
    <div class="alert alert-info">
      <strong>プレビューを生成しました。</strong> 内容を確認してから確定してください。<br><br>
      <a href="${res.pdfUrl}" target="_blank" class="btn btn-primary btn-sm">PDFを開く（別タブ）</a>
    </div>
    <div class="gap-8 mt-8">
      <button class="btn btn-success" id="btn-pull-confirm">確定して下書き作成</button>
      <button class="btn btn-secondary" id="btn-pull-cancel-preview">破棄して戻る</button>
    </div>
  `;
  div.classList.remove('hidden');
  document.getElementById('btn-pull-confirm').addEventListener('click', confirmPull);
  document.getElementById('btn-pull-cancel-preview').addEventListener('click', cancelPullPreview);
}

// 確定：在庫減算 + Gmail下書き + ログ追加
function confirmPull() {
  if (!state.previewPull) return;
  const { params, pdfId } = state.previewPull;
  showLoading('下書きを作成中…');
  google.script.run
    .withSuccessHandler(res => {
      hideLoading();
      state.previewPull = null;
      document.getElementById('panel-pull').classList.remove('preview-locked');
      showRequestResult('pull', res); // 成功カード表示＋フォームクリア
    })
    .withFailureHandler(err => {
      hideLoading();
      document.getElementById('pull-alerts').innerHTML =
        `<div class="alert alert-danger">${esc(err.message).replace(/\n/g, '<br>')}</div>`;
      // 失敗時はプレビュー状態を解除してフォーム編集可能に戻す（修正してもう一度プレビュー）
      state.previewPull = null;
      document.getElementById('panel-pull').classList.remove('preview-locked');
      document.getElementById('pull-result').classList.add('hidden');
    })
    .confirmPullRequest(params, pdfId);
}

// 破棄：プレビューPDFを削除してフォームに戻る
function cancelPullPreview() {
  if (!state.previewPull) return;
  const pdfId = state.previewPull.pdfId;
  state.previewPull = null;
  document.getElementById('panel-pull').classList.remove('preview-locked');
  const div = document.getElementById('pull-result');
  div.innerHTML = '';
  div.classList.add('hidden');
  if (pdfId) {
    google.script.run
      .withFailureHandler(() => {})
      .cancelPreviewPdf(pdfId);
  }
}

// ============================================================
// 返送依頼送信  v24 でプレビュー→確定の2段階に変更
//   submitRet:        プレビュー（PDF）を生成してフォームに表示
//   confirmRet:       Excel(.xlsx) を生成して Gmail下書き＋ログ追加
//   cancelRetPreview: プレビューPDFを破棄してフォームに戻る
// ============================================================
function submitRet() {
  const date = document.getElementById('ret-date').value;
  if (!date) { alert('入庫予定日を入力してください。'); return; }

  const { items, error } = collectItems('ret');
  if (error)             { alert(error); return; }
  if (!items.length)     { alert('商品を1件以上追加してください。'); return; }

  const params = { date: date.replace(/-/g, '/'), items };

  showLoading('プレビューを生成中…');
  google.script.run
    .withSuccessHandler(res => {
      hideLoading();
      document.getElementById('panel-ret').classList.add('preview-locked');
      state.previewRet = { pdfId: res.pdfId, params: params };
      showRetPreview(res);
    })
    .withFailureHandler(err => {
      hideLoading();
      alert('エラー: ' + err.message);
    })
    .previewReturnRequest(params);
}

function showRetPreview(res) {
  const div = document.getElementById('ret-result');
  let warningsHtml = '';
  if (res.warnings && res.warnings.length) {
    warningsHtml = res.warnings.map(w =>
      `<div class="alert alert-warning">${esc(w)}</div>`
    ).join('');
  }
  div.innerHTML = `
    ${warningsHtml}
    <div class="alert alert-info">
      <strong>プレビュー（PDF）を生成しました。</strong> 内容を確認してから確定してください。<br>
      確定すると Excel(.xlsx) に変換してGmail下書きに添付します。<br><br>
      <a href="${res.pdfUrl}" target="_blank" class="btn btn-primary btn-sm">プレビューPDFを開く（別タブ）</a>
    </div>
    <div class="gap-8 mt-8">
      <button class="btn btn-success" id="btn-ret-confirm">確定して Excel下書き作成</button>
      <button class="btn btn-secondary" id="btn-ret-cancel-preview">破棄して戻る</button>
    </div>
  `;
  div.classList.remove('hidden');
  document.getElementById('btn-ret-confirm').addEventListener('click', confirmRet);
  document.getElementById('btn-ret-cancel-preview').addEventListener('click', cancelRetPreview);
}

function confirmRet() {
  if (!state.previewRet) return;
  const { params, pdfId } = state.previewRet;
  // 下書きから呼び出していれば、その下書きDB IDを渡す（サーバー側で下書きスプシを xlsx 化する）
  const srcDraftId = (state.loadedDraft && state.loadedDraft.ret) || null;
  showLoading('Excelを生成中…');
  google.script.run
    .withSuccessHandler(res => {
      hideLoading();
      state.previewRet = null;
      document.getElementById('panel-ret').classList.remove('preview-locked');
      showRequestResult('ret', res); // 成功カード表示＋フォームクリア
    })
    .withFailureHandler(err => {
      hideLoading();
      alert('エラー: ' + err.message);
      // 失敗時はプレビュー状態を解除してフォーム編集可能に戻す
      state.previewRet = null;
      document.getElementById('panel-ret').classList.remove('preview-locked');
      document.getElementById('ret-result').classList.add('hidden');
    })
    .confirmReturnRequest(params, pdfId, srcDraftId);
}

function cancelRetPreview() {
  if (!state.previewRet) return;
  const pdfId = state.previewRet.pdfId;
  state.previewRet = null;
  document.getElementById('panel-ret').classList.remove('preview-locked');
  const div = document.getElementById('ret-result');
  div.innerHTML = '';
  div.classList.add('hidden');
  if (pdfId) {
    google.script.run.withFailureHandler(() => {}).cancelPreviewPdf(pdfId);
  }
}

function showRequestResult(mode, res) {
  const div = document.getElementById(`${mode}-result`);
  let warningsHtml = '';
  if (res.warnings && res.warnings.length) {
    warningsHtml = res.warnings.map(w =>
      `<div class="alert alert-warning">${esc(w)}</div>`
    ).join('');
  }

  // この依頼が「下書きから呼び出したもの」なら、その下書きを自動削除
  let draftNote = '';
  if (state.loadedDraft && state.loadedDraft[mode]) {
    const id = state.loadedDraft[mode];
    state.loadedDraft[mode] = null;
    draftNote = '<br><span style="font-size:12px;color:var(--gray-600)">（使用した下書きを削除しました）</span>';
    google.script.run.deleteRequestDraft(id); // 失敗しても致命的でないので結果は待たない
  }

  const sheetLink = res.sheetUrl
    ? `&nbsp;<a href="${res.sheetUrl}" target="_blank" class="btn btn-secondary btn-sm">出入票（スプシを開く）</a>`
    : '';
  // 返送はExcel(.xlsx)、引き寄せはPDFがpdfUrlに入る
  const fileLabel = mode === 'ret' ? 'Excel を確認' : 'PDF を確認';
  div.innerHTML = `
    ${warningsHtml}
    <div class="alert alert-success">
      依頼書 #${res.reqId} を作成しました。${draftNote}
      <br><br>
      <a href="${res.draftUrl}" target="_blank" class="btn btn-primary btn-sm">
        Gmail 下書きを開く
      </a>
      &nbsp;
      <a href="${res.pdfUrl}" target="_blank" class="btn btn-secondary btn-sm">
        ${fileLabel}
      </a>${sheetLink}
    </div>
  `;
  div.classList.remove('hidden');
  // 在庫を再読み込み
  loadInventory();
  // フォーム入力（行・日付・配送方法）はクリア。結果カードと警告は残す
  clearFormKeepingResult(mode);
}

// ============================================================
// 新商品追加
// ============================================================
function toggleYayoiMode(mode) {
  state.np.yayoiMode = mode;
  document.getElementById('yayoi-existing').classList.toggle('hidden', mode !== 'existing');
  document.getElementById('yayoi-new').classList.toggle('hidden', mode !== 'new');
  const noneInfo = document.getElementById('yayoi-none-info');
  if (noneInfo) noneInfo.classList.toggle('hidden', mode !== 'none');
  // 既存以外に切り替えたら選択済み弥生をクリア
  if (mode !== 'existing') {
    state.np.selectedYayoi = null;
    document.getElementById('yayoi-selected-info').classList.add('hidden');
  }
}

function onYayoiSearch(q) {
  const input = document.getElementById('yayoi-search');
  const list  = document.getElementById('yayoi-ac-list');
  if (q.length < 1) { list.classList.add('hidden'); return; }

  google.script.run
    .withSuccessHandler(results => {
      list.innerHTML = '';
      results.forEach(r => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="ac-code">${esc(r.yayoiCode)}</span> ${esc(r.name)}`;
        li.addEventListener('click', () => {
          state.np.selectedYayoi = r;
          input.value = `${r.yayoiCode}  ${r.name}`;
          const info = document.getElementById('yayoi-selected-info');
          info.innerHTML = `<strong>${esc(r.yayoiCode)}</strong> ${esc(r.name)}`
            + (r.cat4Name ? `<br>ブランド: ${esc(r.cat4Name)}` : '')
            + (r.priceEx  ? `<br>税抜上代: ¥${r.priceEx.toLocaleString()}` : '');
          info.classList.remove('hidden');
          list.classList.add('hidden');
        });
        list.appendChild(li);
      });
      if (results.length) {
        positionAcList(input, list);
        list.classList.remove('hidden');
      } else {
        list.classList.add('hidden');
      }
    })
    .searchYayoiMaster(q);
}

function onMizutaCodeInput(code) {
  if (!code) return;
  google.script.run
    .withSuccessHandler(dec => {
      const el = document.getElementById('code-decompose-preview');
      el.innerHTML = `
        <strong>コード分解結果：</strong><br>
        本体番号: <code>${esc(dec.base)}</code>
        　バリエーション: <code>${esc(dec.variantId || '—')}</code>
        　入数: <code>${esc(dec.iri || '?')}</code>
        　状態: <code>${esc(dec.status)}</code>
        　ロット日: <code>${esc(dec.lotDate || '—')}</code>
      `;
      el.classList.remove('hidden');
      // 状態を自動セット
      const statusSel = document.getElementById('np-status');
      if (dec.status) statusSel.value = dec.status;
      // 入数を自動セット（未入力の場合）
      const iriInput = document.getElementById('np-iri');
      if (!iriInput.value && dec.iri) iriInput.value = dec.iri;
    })
    .decomposeCode(code);
}

function goStep(n) {
  // バリデーション
  if (n === 2) {
    if (state.np.yayoiMode === 'existing' && !state.np.selectedYayoi) {
      alert('弥生コードを検索・選択してください。'); return;
    }
    if (state.np.yayoiMode === 'new') {
      if (!document.getElementById('new-yayoi-code').value.trim()) {
        alert('弥生コードを入力してください。'); return;
      }
      if (!document.getElementById('new-yayoi-name').value.trim()) {
        alert('商品名を入力してください。'); return;
      }
    }
  }
  if (n === 3) {
    if (!document.getElementById('np-mizuta-code').value.trim()) {
      alert('ミズタコードを入力してください。'); return;
    }
    if (!document.getElementById('np-mizuta-name').value.trim()) {
      alert('ミズタ商品名を入力してください。'); return;
    }
    if (halfWidthLen(document.getElementById('np-mizuta-name').value.trim()) > 36) {
      alert('ミズタ商品名は半角36文字以内で入力してください。（全角は2文字換算）'); return;
    }
    if (!document.getElementById('np-iri').value) {
      alert('入数を入力してください。'); return;
    }
    buildPreview();
  }

  state.np.currentStep = n;
  ['step1','step2','step3'].forEach((s, i) => {
    document.getElementById(s).classList.toggle('hidden', i + 1 !== n);
    const tab = document.getElementById(`${s}-tab`);
    tab.classList.toggle('active', i + 1 === n);
    tab.classList.toggle('done',   i + 1 < n);
  });
}

function buildPreview() {
  const isNew   = state.np.yayoiMode === 'new';
  const yCode   = isNew
    ? document.getElementById('new-yayoi-code').value.trim()
    : (state.np.selectedYayoi ? state.np.selectedYayoi.yayoiCode : '');
  const yName   = isNew
    ? document.getElementById('new-yayoi-name').value.trim()
    : (state.np.selectedYayoi ? state.np.selectedYayoi.name : '');
  const mCode   = document.getElementById('np-mizuta-code').value.trim();
  const mName   = document.getElementById('np-mizuta-name').value.trim();
  const iri     = document.getElementById('np-iri').value;
  const status  = document.getElementById('np-status').value;
  const lotDate = document.getElementById('np-lot-date').value;
  const initQty = document.getElementById('np-init-qty').value || 0;

  document.getElementById('np-preview').innerHTML = `
    <table style="width:auto;font-size:13px">
      <tr><th style="text-align:right;padding:5px 12px 5px 0;color:var(--gray-600)">弥生コード</th>
          <td>${esc(yCode) || (state.np.yayoiMode === 'none' ? '（弥生未登録）' : '—')}${isNew ? '（新規作成）' : ''}</td></tr>
      <tr><th style="text-align:right;padding:5px 12px 5px 0;color:var(--gray-600)">弥生商品名</th>
          <td>${esc(yName) || '—'}</td></tr>
      <tr><th style="text-align:right;padding:5px 12px 5px 0;color:var(--gray-600)">ミズタコード</th>
          <td class="mono"><strong>${esc(mCode)}</strong></td></tr>
      <tr><th style="text-align:right;padding:5px 12px 5px 0;color:var(--gray-600)">ミズタ商品名</th>
          <td>${esc(mName)}</td></tr>
      <tr><th style="text-align:right;padding:5px 12px 5px 0;color:var(--gray-600)">入数</th>
          <td>${esc(iri)}</td></tr>
      <tr><th style="text-align:right;padding:5px 12px 5px 0;color:var(--gray-600)">初期在庫</th>
          <td><strong>${esc(initQty)}</strong> 個</td></tr>
    </table>
  `;
}

function getNpParams() {
  const isNew  = state.np.yayoiMode === 'new';
  return {
    isNewYayoi:      isNew,
    yayoiCode:       state.np.selectedYayoi ? state.np.selectedYayoi.yayoiCode : '',
    yayoiCodeNew:    isNew ? document.getElementById('new-yayoi-code').value.trim() : '',
    yayoiName:       isNew ? document.getElementById('new-yayoi-name').value.trim() : '',
    cat1:            isNew ? document.getElementById('new-yayoi-cat1').value.trim() : '',
    cat4Code:        isNew ? document.getElementById('new-yayoi-cat4code').value.trim() : '',
    cat4Name:        isNew ? document.getElementById('new-yayoi-cat4name').value.trim() : '',
    priceEx:         isNew ? parseFloat(document.getElementById('new-yayoi-price').value) || 0 : 0,
    costEx:          isNew ? parseFloat(document.getElementById('new-yayoi-cost').value)  || 0 : 0,
    mizutaCode:      document.getElementById('np-mizuta-code').value.trim(),
    mizutaName:      document.getElementById('np-mizuta-name').value.trim(),
    iri:             parseInt(document.getElementById('np-iri').value)      || 1,
    status:          document.getElementById('np-status').value,
    lotDate:         document.getElementById('np-lot-date').value,
    initialQty:      parseInt(document.getElementById('np-init-qty').value) || 0,
  };
}

function commitNewProduct() {
  showLoading('登録中…');
  google.script.run
    .withSuccessHandler(res => {
      hideLoading();
      alert(`登録完了: ${res.mizutaCode}`);
      resetNewProductForm();
      loadInventory();
    })
    .withFailureHandler(err => {
      hideLoading();
      alert('エラー: ' + err.message);
    })
    .addNewProduct(getNpParams());
}

function continueNewProduct() {
  // 弥生コード情報を保持してミズタコード欄だけリセット
  const savedYayoi = state.np.selectedYayoi;
  const savedMode  = state.np.yayoiMode;
  commitNewProduct();
  // コミット後に状態復元（非同期なので簡易的にタイムアウトで）
  setTimeout(() => {
    state.np.yayoiMode     = savedMode;
    state.np.selectedYayoi = savedYayoi;
    document.getElementById('np-mizuta-code').value = '';
    document.getElementById('np-mizuta-name').value = '';
    document.getElementById('np-iri').value         = '';
    document.getElementById('np-init-qty').value    = '0';
    goStep(2);
  }, 500);
}

function resetNewProductForm() {
  state.np = { yayoiMode: 'existing', selectedYayoi: null, currentStep: 1 };
  const existingRadio = document.querySelector('input[name="yayoi-mode"][value="existing"]');
  if (existingRadio) existingRadio.checked = true;
  toggleYayoiMode('existing');
  document.getElementById('yayoi-search').value       = '';
  document.getElementById('yayoi-selected-info').classList.add('hidden');
  document.getElementById('np-mizuta-code').value     = '';
  document.getElementById('np-mizuta-name').value     = '';
  document.getElementById('np-iri').value             = '';
  document.getElementById('np-init-qty').value        = '0';
  document.getElementById('code-decompose-preview').classList.add('hidden');
  goStep(1);
}

// ============================================================
// 在庫照合（月次）
// ============================================================
function importExcel() {
  const fileInput = document.getElementById('rec-file');
  if (!fileInput.files.length) { alert('ファイルを選択してください。'); return; }
  const file = fileInput.files[0];

  showLoading('ファイルを読み込み中…');
  const reader = new FileReader();
  reader.onload = e => {
    const base64 = btoa(
      new Uint8Array(e.target.result).reduce((d, b) => d + String.fromCharCode(b), '')
    );
    google.script.run
      .withSuccessHandler(res => {
        hideLoading();
        if (res.success) renderDiffs(res.diffs);
        else alert('エラー: ' + res.message);
      })
      .withFailureHandler(err => { hideLoading(); alert('エラー: ' + err.message); })
      .importExcelAndGetDiff(base64, file.name);
  };
  reader.readAsArrayBuffer(file);
}

// 弥生商品マスタ.xlsx をアップロードして商品マスタを即時更新
function importYayoiMaster() {
  const fileInput = document.getElementById('master-file');
  const result    = document.getElementById('master-result');
  if (!fileInput.files.length) { alert('ファイルを選択してください。'); return; }
  const file = fileInput.files[0];

  if (!confirm('現在の商品マスタを、選択したファイルの内容で丸ごと置き換えます。よろしいですか？')) return;

  showLoading('商品マスタを更新中…');
  const reader = new FileReader();
  reader.onload = e => {
    const base64 = btoa(
      new Uint8Array(e.target.result).reduce((d, b) => d + String.fromCharCode(b), '')
    );
    google.script.run
      .withSuccessHandler(res => {
        hideLoading();
        if (res && res.success) {
          result.innerHTML = `<div class="alert alert-success">商品マスタを更新しました（${res.count}件）。</div>`;
          fileInput.value = '';
          loadInventory(); // 在庫一覧のキャッシュを更新
        } else {
          result.innerHTML = `<div class="alert alert-danger">更新失敗: ${esc((res && res.message) || '不明なエラー')}</div>`;
        }
      })
      .withFailureHandler(err => {
        hideLoading();
        result.innerHTML = `<div class="alert alert-danger">エラー: ${esc(err.message)}</div>`;
      })
      .importYayoiMasterFromUpload(base64, file.name);
  };
  reader.readAsArrayBuffer(file);
}

function renderDiffs(diffs) {
  state.recDiffs = diffs;
  const tbody = document.getElementById('rec-tbody');
  tbody.innerHTML = '';
  let diffCount = 0, newCount = 0;

  const badge = '<span style="background:#ffebee;color:#c62828;border:1px solid #ef9a9a;'
    + 'border-radius:4px;padding:1px 6px;font-size:11px;font-weight:700;margin-left:6px">新規（未登録）</span>';

  diffs.forEach((d, idx) => {
    const isNew   = d.isNew === true || d.sysQty === null || d.sysQty === undefined || d.sysQty === '';
    const hasDiff = !isNew && d.diff !== 0 && d.diff !== '' && d.diff != null;
    if (isNew) newCount++;
    else if (hasDiff) diffCount++;

    // 一致行（システム＝Excel）は非表示。ズレている行と新規行のみ描画する。
    if (!isNew && !hasDiff) return;

    const tr = document.createElement('tr');
    if (isNew) tr.style.background = '#fff8f8';
    else if (d.diff > 0) tr.className = 'diff-plus';
    else if (d.diff < 0) tr.className = 'diff-minus';

    // 弥生コード・弥生名セル（新規行は入力欄、それ以外は—）
    const yayoiCells = isNew
      ? `<td><input class="rec-ycode" data-idx="${idx}" placeholder="弥生コード" style="width:130px;font-size:12px"></td>`
        + `<td><input class="rec-yname" data-idx="${idx}" placeholder="弥生商品名" style="width:170px;font-size:12px"></td>`
      : `<td class="text-muted">—</td><td class="text-muted">—</td>`;

    // 取扱いセル（新規行は登録対象、それ以外はExcel/システム選択）
    const actionCell = isNew
      ? `<td class="text-muted" style="font-size:12px">新規登録対象</td>`
      : `<td><select data-idx="${idx}" class="rec-action" style="font-size:12px">`
        + `<option value="excel">Excelに合わせる</option>`
        + `<option value="system">システムを維持</option></select></td>`;

    tr.innerHTML = `
      <td class="mono">${esc(d.code)}</td>
      <td>${esc(d.name)}${isNew ? badge : ''}</td>
      ${yayoiCells}
      <td class="text-right">${isNew ? '—' : d.sysQty}</td>
      <td class="text-right">${d.exQty}</td>
      <td class="text-right">${isNew ? '—' : (d.diff > 0 ? '+' : '') + d.diff}</td>
      ${actionCell}
    `;
    tbody.appendChild(tr);
  });

  // 全件一致の場合は専用メッセージを出して、表・サマリ・登録ボタンは非表示にする
  const noDiff = (diffCount + newCount === 0);
  if (noDiff) {
    tbody.innerHTML =
      '<tr><td colspan="8" style="text-align:center;padding:24px;font-size:14px;color:var(--success);font-weight:600">'
      + 'システムとエクセルの相違はありませんでした'
      + '</td></tr>';
  }

  document.getElementById('rec-summary').textContent = noDiff
    ? ''
    : `${diffs.length} 件中　差異 ${diffCount} 件　/　新規（未登録） ${newCount} 件`;

  const regBtn = document.getElementById('btn-rec-register');
  if (regBtn) regBtn.style.display = newCount ? '' : 'none';

  // 差異が無いときは「差異を確定」ボタンも隠す（押す意味がないため）
  const applyBtn = document.getElementById('btn-rec-apply');
  if (applyBtn) applyBtn.style.display = (diffCount ? '' : 'none');

  document.getElementById('rec-result').classList.remove('hidden');
}

// 在庫照合で見つかった新規（未登録）商品を一括登録
function registerReconNew() {
  const codeInputs = document.querySelectorAll('.rec-ycode');
  const items = [];
  codeInputs.forEach(inp => {
    const idx = parseInt(inp.dataset.idx);
    const d = state.recDiffs[idx];
    const yname = document.querySelector(`.rec-yname[data-idx="${idx}"]`);
    items.push({
      mizutaCode: d.code,
      mizutaName: d.name,
      yayoiCode:  inp.value.trim(),
      yayoiName:  yname ? yname.value.trim() : '',
      qty:        d.exQty,
    });
  });
  if (!items.length) { alert('新規（未登録）の商品がありません。'); return; }
  if (!confirm(`${items.length} 件の新規商品をDBに登録します。\n弥生コードを入力した行は弥生商品に紐づきます。よろしいですか？`)) return;

  showLoading('新規商品を登録中…');
  const rows = state.recDiffs.map(d => ({ code: d.code, name: d.name, qty: d.exQty }));
  google.script.run
    .withSuccessHandler(res => {
      let msg = `${res.registered} 件を登録しました。`;
      if (res.skipped && res.skipped.length) msg += `\n（スキップ: ${res.skipped.join(', ')}）`;
      alert(msg);
      loadInventory(); // 在庫一覧キャッシュ更新
      // 差異を再評価（登録済みは新規でなくなる）
      google.script.run
        .withSuccessHandler(diffs2 => { hideLoading(); renderDiffs(diffs2); })
        .withFailureHandler(err => { hideLoading(); alert('再計算エラー: ' + err.message); })
        .getReconciliationDiff(rows);
    })
    .withFailureHandler(err => { hideLoading(); alert('登録エラー: ' + err.message); })
    .registerNewProductsFromRecon(items);
}

function applyReconciliation() {
  const selects = document.querySelectorAll('.rec-action');
  const confirmed = [];
  selects.forEach(sel => {
    const d = state.recDiffs[parseInt(sel.dataset.idx)];
    confirmed.push({ code: d.code, qty: d.exQty, action: sel.value });
  });

  showLoading('在庫台帳を更新中…');
  google.script.run
    .withSuccessHandler(res => {
      hideLoading();
      alert(`${res.updated} 件の在庫を更新しました。`);
      document.getElementById('rec-result').classList.add('hidden');
      document.getElementById('rec-file').value = '';
      loadInventory();
    })
    .withFailureHandler(err => { hideLoading(); alert('エラー: ' + err.message); })
    .applyReconciliation(confirmed);
}

// ============================================================
// 入庫報告書 PDF 取込
// ============================================================
const PDFJS_VER = '3.11.174';
const PDFJS_CDN = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VER}`;

let _pdfjsReady = null;
function _loadPdfJs() {
  if (_pdfjsReady) return _pdfjsReady;
  _pdfjsReady = new Promise((resolve, reject) => {
    if (window.pdfjsLib) { resolve(window.pdfjsLib); return; }
    const s = document.createElement('script');
    s.src = `${PDFJS_CDN}/pdf.min.js`;
    s.onload = () => {
      try {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/pdf.worker.min.js`;
        resolve(window.pdfjsLib);
      } catch (e) { reject(e); }
    };
    s.onerror = () => reject(new Error('pdf.js の読み込みに失敗しました（ネットワーク制限の可能性）'));
    document.head.appendChild(s);
  });
  return _pdfjsReady;
}

// PDF Blob → 行ごとの文字列配列（テキスト埋め込みPDF前提）。
// 同じ行の文字を1行にまとめ、X座標で並べ替えてスペース連結する。
//   ※ 入庫報告書は「商品コード」「商品名」「数値」の各セルがわずかに違うY座標
//      （ベースラインずれ 0.1〜0.5pt 程度）で抽出されることがある。0.1pt 量子化では
//      これらが別行に割れてしまい、商品コードが取りこぼされる/商品名先頭が誤って
//      コード扱いされる不具合が起きるため、Y_TOL の許容差で同一行にクラスタリングする。
const _PDF_ROW_Y_TOL = 4; // 同一行とみなすY座標差(pt)。行ピッチ(~20pt)より十分小さく取る。
async function _extractPdfLines(file) {
  const pdfjsLib = await _loadPdfJs();
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const lines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc   = await page.getTextContent();
    const items = [];
    tc.items.forEach(it => {
      if (!it.str) return;
      items.push({ x: it.transform[4], y: it.transform[5], str: it.str });
    });
    // PDFは上が大きいY座標なので降順に並べ、Y_TOL以内を同一行クラスタにまとめる。
    items.sort((a, b) => b.y - a.y);
    const clusters = [];
    items.forEach(it => {
      const last = clusters.length ? clusters[clusters.length - 1] : null;
      if (last && Math.abs(last.y - it.y) <= _PDF_ROW_Y_TOL) {
        last.items.push(it);
      } else {
        clusters.push({ y: it.y, items: [it] });
      }
    });
    clusters.forEach(c => {
      c.items.sort((a, b) => a.x - b.x);
      lines.push(c.items.map(o => o.str).join(' ').replace(/\s+/g, ' ').trim());
    });
  }
  return lines.filter(l => l.length > 0);
}

let _inboundState = null; // { rows, fileName }

function parseInboundPdf() {
  const fileEl = document.getElementById('inb-file');
  const file   = fileEl.files && fileEl.files[0];
  if (!file) { alert('PDFファイルを選択してください。'); return; }
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    alert('PDFファイル(.pdf)を指定してください。'); return;
  }

  showLoading('PDFを解析中…');
  _extractPdfLines(file)
    .then(lines => {
      return new Promise((resolve, reject) => {
        google.script.run
          .withSuccessHandler(resolve)
          .withFailureHandler(reject)
          .parseInboundReport(lines);
      });
    })
    .then(res => {
      hideLoading();
      if (!res || !res.success) {
        alert('解析エラー: ' + (res && res.message ? res.message : '不明'));
        return;
      }
      _inboundState = { rows: res.rows, fileName: file.name };
      renderInboundPreview(res.rows, res.warnings || []);
      document.getElementById('inb-result').classList.remove('hidden');
    })
    .catch(err => {
      hideLoading();
      alert('エラー: ' + (err && err.message ? err.message : err));
    });
}

function renderInboundPreview(rows, warnings) {
  const tbody = document.getElementById('inb-tbody');
  tbody.innerHTML = '';

  let newVar = 0, dupVar = 0, newInv = 0, addInv = 0;
  rows.forEach(r => {
    if (r.varStatus === 'new')      newVar++;
    else if (r.varStatus === 'dup') dupVar++;
    if (r.invStatus === 'new')      newInv++;
    else if (r.invStatus === 'add') addInv++;

    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${esc(r.code)}</td>` +
      `<td>${esc(r.name)}</td>` +
      `<td class="text-right">${esc(r.iri)}</td>` +
      `<td class="text-right">${esc(r.qty)}</td>` +
      `<td class="text-right">${esc(r.cases)}</td>` +
      `<td class="text-right">${esc(r.bara)}</td>` +
      `<td>${_inbBadge(r.varStatus, r.varDetail)}</td>` +
      `<td>${_inbBadge(r.invStatus, r.invDetail)}</td>`;
    tbody.appendChild(tr);
  });

  document.getElementById('inb-summary').innerHTML =
    `データ行: ${rows.length}件　／　バリエーション: 新規追加 <strong>${newVar}</strong> / スキップ(既存) ${dupVar}　／　` +
    `在庫台帳: 新規追加 <strong>${newInv}</strong> / 加算更新 <strong>${addInv}</strong>`;

  const wbox = document.getElementById('inb-warnings');
  wbox.innerHTML = '';
  if (warnings && warnings.length) {
    wbox.innerHTML = warnings.map(w =>
      `<div class="alert alert-warning" style="font-size:12px">${esc(w)}</div>`
    ).join('');
  }
}

function _inbBadge(status, detail) {
  const map = {
    new:  ['新規追加', 'background:#e8f5e9;color:#2e7d32'],
    dup:  ['スキップ', 'background:#eceff1;color:#546e7a'],
    add:  ['加算',     'background:#fff8e1;color:#f57f17'],
  };
  const m = map[status];
  const txt = m ? m[0] : status;
  const sty = m ? m[1] : '';
  const det = detail ? `<br><span style="font-size:11px;color:var(--gray-600)">${esc(detail)}</span>` : '';
  return `<span style="display:inline-block;padding:2px 6px;border-radius:4px;font-size:11px;${sty}">${txt}</span>${det}`;
}

function applyInboundPdf() {
  if (!_inboundState || !_inboundState.rows || !_inboundState.rows.length) {
    alert('プレビューが空です。先にPDFを解析してください。'); return;
  }
  if (!confirm(`スプレッドシートに反映します。よろしいですか？\n（${_inboundState.rows.length}件）`)) return;

  showLoading('スプレッドシートに書き込み中…');
  google.script.run
    .withSuccessHandler(res => {
      hideLoading();
      if (!res || !res.success) {
        alert('書込エラー: ' + (res && res.message ? res.message : '不明'));
        return;
      }
      alert(
        `反映しました。\n` +
        `バリエーション: 追加 ${res.varAdded} 件 / スキップ ${res.varSkipped} 件\n` +
        `在庫台帳: 追加 ${res.invAdded} 件 / 加算 ${res.invUpdated} 件`
      );
      _inboundState = null;
      document.getElementById('inb-result').classList.add('hidden');
      document.getElementById('inb-file').value = '';
      loadInventory();
    })
    .withFailureHandler(err => { hideLoading(); alert('エラー: ' + err.message); })
    .applyInboundReport(_inboundState.rows);
}

// ============================================================
// 依頼書履歴
// ============================================================
function loadHistory() {
  const type = document.getElementById('hist-type').value;
  showLoading('履歴を読み込み中…');
  google.script.run
    .withSuccessHandler(rows => {
      hideLoading();
      renderHistory(rows);
    })
    .withFailureHandler(err => { hideLoading(); alert('エラー: ' + err.message); })
    .getRequestLog(type);
}

function renderHistory(rows) {
  const tbody = document.getElementById('hist-tbody');
  tbody.innerHTML = '';

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="text-muted" style="text-align:center;padding:20px">履歴がありません</td></tr>';
    return;
  }

  // 依頼日降順ソート
  const sorted = [...rows].sort((a, b) => {
    const da = a.date ? a.date.replace(/\//g, '-') : '';
    const db = b.date ? b.date.replace(/\//g, '-') : '';
    return db.localeCompare(da);
  });

  const badgeMap = { '依頼済み': 'requested', '受け取り済み': 'received', '返送済み': 'returned' };

  sorted.forEach(r => {
    const tr = document.createElement('tr');
    const nextStatus = r.type === '引き寄せ' ? '受け取り済み' : '返送済み';
    const canUpdate  = r.status === '依頼済み';
    const arrivalCell = r.type === '引き寄せ' ? esc(r.arrivalDate || '') : '-';

    tr.innerHTML = `
      <td style="text-align:center">
        <input type="checkbox" class="hist-row-cb" data-row-nums="${esc(JSON.stringify(r.rowNums))}">
      </td>
      <td>${r.id}</td>
      <td>${esc(r.type)}</td>
      <td>${esc(r.delivery)}</td>
      <td>${esc(r.date)}</td>
      <td>${arrivalCell}</td>
      <td class="text-right qty">${r.totalCases}</td>
      <td><span class="badge badge-${badgeMap[r.status] || 'requested'}">${esc(r.status)}</span></td>
      <td style="font-size:11px">${esc(r.user)}</td>
      <td></td>
    `;

    // 操作列（URLやrowNumsをデータバインドするためJSで構築）
    const opCell = tr.lastElementChild;
    const opDiv  = document.createElement('div');
    opDiv.className = 'gap-8';
    if (r.draftId) {
      const a = document.createElement('a');
      a.href = `https://mail.google.com/mail/u/0/#drafts/${r.draftId}`;
      a.target = '_blank';
      a.className = 'btn btn-outline btn-xs';
      a.textContent = 'Gmail';
      opDiv.appendChild(a);
    }
    if (r.pdfUrl) {
      const a = document.createElement('a');
      a.href = r.pdfUrl;
      a.target = '_blank';
      a.className = 'btn btn-secondary btn-xs';
      // v24 以降の返送は Excel(.xlsx) が pdfUrl 列に入る（v23 以前の返送履歴は PDF だが
      // 表記は新仕様に揃える方針: 返送=Excel / 引き寄せ=PDF）
      a.textContent = r.type === '返送' ? 'Excel' : 'PDF';
      opDiv.appendChild(a);
    }
    if (canUpdate) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-success btn-xs';
      btn.textContent = (r.type === '引き寄せ' ? '受け取り済み' : '返送済み') + 'にする';
      const rowNums = r.rowNums;
      btn.addEventListener('click', function() { updateStatus(rowNums, nextStatus, this); });
      opDiv.appendChild(btn);
    }
    opCell.appendChild(opDiv);
    tbody.appendChild(tr);
  });
}

function updateStatus(rowNums, newStatus, btn) {
  if (!confirm('ステータスを「' + newStatus + '」に変更してよいですか？')) return;
  btn.disabled = true;
  google.script.run
    .withSuccessHandler(() => loadHistory())
    .withFailureHandler(err => { alert('エラー: ' + err.message); btn.disabled = false; })
    .updateRequestStatus(rowNums, newStatus);
}

function deleteSelectedHistory() {
  const checked = [...document.querySelectorAll('.hist-row-cb:checked')];
  if (!checked.length) { alert('削除する行を選択してください。'); return; }
  const msg = '選択した ' + checked.length + ' 件の依頼書を削除します。\n\n'
    + '・対応する在庫を作成前の状態に戻します（引き寄せ→在庫を戻す）\n'
    + '・関連するPDF・出入票スプシも Drive のゴミ箱へ移動します（30日以内なら復旧可）\n\n'
    + 'よろしいですか？';
  if (!confirm(msg)) return;

  const rowNums = checked.flatMap(cb => JSON.parse(cb.dataset.rowNums));
  showLoading('削除して在庫を戻しています…');
  google.script.run
    .withSuccessHandler(res => {
      hideLoading();
      loadHistory();
      loadInventory(); // 在庫が変わったのでキャッシュを更新
      if (res) {
        const parts = ['削除しました。'];
        if (res.reverted)     parts.push(`${res.reverted} 品目の在庫を戻しました。`);
        if (res.trashedFiles) parts.push(`${res.trashedFiles} 件のファイルをゴミ箱へ移動しました。`);
        alert(parts.join('\n'));
      }
    })
    .withFailureHandler(err => { hideLoading(); alert('エラー: ' + err.message); })
    .deleteRequestLogRows(rowNums);
}

// ============================================================
// 更新ボタン（パネルに応じてデータだけ再取得）
// ============================================================
function refreshData() {
  const p = state.currentPanel;
  if (p === 'inventory')  loadInventory();
  else if (p === 'history') loadHistory();
  else loadInventory(); // 在庫データは常に最新に保つ
}

// ============================================================
// オートコンプリート：position:fixed でビューポート基準に配置
// ============================================================
function positionAcList(input, acList) {
  const rect  = input.getBoundingClientRect();
  const w     = Math.max(rect.width, 360);
  const left  = Math.min(rect.left, window.innerWidth - w - 8);
  acList.style.top   = (rect.bottom + 2) + 'px';
  acList.style.left  = Math.max(8, left) + 'px';
  acList.style.width = w + 'px';
}

// ============================================================
// 共通：画面外クリックで補完リストを閉じる
// ============================================================
document.addEventListener('click', e => {
  if (!e.target.closest('.autocomplete-wrap')) {
    document.querySelectorAll('.autocomplete-list').forEach(l => l.classList.add('hidden'));
  }
});
// ページスクロール時は閉じる（fixed配置のリストが入力欄から離れるため）。
// ただしリスト内スクロール／スクロールバー操作では閉じない。
document.addEventListener('scroll', (e) => {
  if (e.target && e.target.closest && e.target.closest('.autocomplete-list')) return;
  document.querySelectorAll('.autocomplete-list').forEach(l => l.classList.add('hidden'));
}, true);
