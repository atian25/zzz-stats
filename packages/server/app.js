/*
 * 本地采集页的前端逻辑。
 *
 * ## 三条硬规则（都是用户明确要求，别为了「方便」加回来）
 *
 * 1. **页面加载时什么都不做。** 不申请二维码、不查上一次运行、不显示任何人的报表。
 *    每个人进来都从介绍页开始；二维码只在点了「开始扫码」之后才实时申请。
 *    （上一版会在 `DOMContentLoaded` 时 fetch('/api/state') 并自动接上正在进行的运行，
 *    那等于「谁打开页面谁就看到别人的码」，多人用会直接串台，已删除。）
 *
 * 2. **一个 run 一份状态。** 所有请求都带自己的 runId：二维码、SSE 流、报表地址。
 *    前端不持有任何全局单例，也不假设「同时只有一个人在跑」。
 *
 * 3. **不写 localStorage / sessionStorage。** 刷新页面 = 重新开始；
 *    留下 runId 只会让下一次访问看起来像「接着别人的流程」。
 *
 * ## 扫码之后要遮住二维码
 *
 * 用户的原话：「扫码后那个二维码应该遮罩住，免得下面还在处理，上面还以为需要扫码」。
 * 所以一旦进入扫码之后的阶段（`已登录并查到角色` / `开始取数` / `采集完成` / `构建报表` …），
 * 立刻给二维码盖遮罩：码变暗变模糊、遮罩上写明当前在干什么、「换一张二维码」按钮隐藏。
 *
 * 判据用**后端实际推的阶段名**，不靠计时器猜：
 * `serve.mjs` 的 `execute()` 只在扫码确认之后才会推那几条（见那里的注释），
 * 而扫码期间只会出现「申请二维码」和「二维码已生成，等待扫码」。
 * 另外收到 `account`（拿到昵称/UID）也一定是扫码之后。
 *
 * ## SSE 断线重连
 *
 * EventSource 自带重连并会带上 Last-Event-ID，服务端从头重放。前端按 seq 去重，
 * 所以重连不会出现重复的进度行。`retry:` 由服务端给。
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var intro = $('intro');
  var runBox = $('run');
  var startBtn = $('start');
  var restartBtn = $('restart');
  var reissueBtn = $('reissue');
  var qrBox = $('qrbox');
  var qrWrap = $('qrwrap');
  var qrMask = $('qrmask');
  var qrMaskText = $('qrmask-text');
  var qrImg = $('qr');
  var qrTip = $('qrtip');
  var stageList = $('stages');
  var errBox = $('err');
  var doneBox = $('done-box');
  var reportLink = $('report-link');
  var runTitle = $('run-title');

  /** 当前这次运行。没有任何持久化，刷新即丢。 */
  var cur = null;

  function makeRun() {
    return {
      runId: null,
      es: null,
      lastSeq: 0,
      expiredAt: 0,
      tickTimer: null,
      finished: false
    };
  }

  function resetStages() {
    while (stageList.firstChild) stageList.removeChild(stageList.firstChild);
  }

  function stopTick(r) {
    if (r && r.tickTimer) { clearInterval(r.tickTimer); r.tickTimer = null; }
  }

  function closeStream(r) {
    if (r && r.es) { r.es.close(); r.es = null; }
    stopTick(r);
  }

  function addLine(text, cls, elapsedMs) {
    var li = document.createElement('li');
    if (cls) li.className = cls;
    li.appendChild(document.createTextNode(text));
    if (typeof elapsedMs === 'number' && elapsedMs >= 0) {
      var t = document.createElement('span');
      t.className = 't';
      t.textContent = (elapsedMs / 1000).toFixed(1) + 's';
      li.appendChild(t);
    }
    stageList.appendChild(li);
  }

  function showError(message) {
    errBox.hidden = false;
    errBox.textContent = '';
    var b = document.createElement('b');
    b.textContent = '失败：';
    errBox.appendChild(b);
    errBox.appendChild(document.createTextNode(message));
  }

  function hideError() {
    errBox.hidden = true;
    errBox.textContent = '';
  }

  /*
   * ------------------------------------------------------------ 二维码遮罩
   *
   * 扫码成功之后，二维码本身就没有再次扫的价值了，但**它还亮着**时用户会以为
   * 「是不是还没扫上、要不要再扫一次」。所以进入后续阶段就立刻盖上遮罩：
   *   1. 码变暗 + 模糊（视觉上失效）
   *   2. 遮罩上写明当前在干什么（`aria-live` 会被读屏念出来）
   *   3. 「换一张二维码」按钮藏掉（避免误点，那会新起一个 run）
   * 遮罩只盖二维码那一块（`.qrwrap` 的 inset: 0），不是整页弹窗。
   */

  /** 遮罩文案。键是后端推的阶段名（见 serve.mjs 的 execute()）。 */
  var MASK_TEXT = {
    '已登录并查到角色': '已扫码，正在取数…',
    '开始取数': '已扫码，正在取数…',
    '采集完成': '采集完成，正在构建报表…',
    '构建报表': '采集完成，正在构建报表…',
    '完成': '已完成，正在打开报表…'
  };

  /** 扫码**之前**才会出现的阶段。除此之外一律当作「扫码之后」。 */
  var PRESCAN_STAGES = ['申请二维码', '二维码已生成，等待扫码'];

  function setQrMasked(masked, label, spinning) {
    if (!qrWrap || !qrMask) return;
    if (masked) {
      qrWrap.classList.add('masked');
      qrMask.hidden = false;
      // 出错/结束时不该还转圈：转圈等于「仍在处理」
      qrMask.classList.toggle('done', spinning === false);
      qrMaskText.textContent = MASK_TEXT[label] || label || '已扫码，正在处理…';
      reissueBtn.hidden = true;
      // 码已经失效，倒计时留在下面只会让人以为还需要再扫
      qrTip.hidden = true;
    } else {
      qrWrap.classList.remove('masked');
      qrMask.hidden = true;
      qrMask.classList.remove('done');
      qrMaskText.textContent = '';
      qrTip.hidden = false;
      reissueBtn.hidden = false;
    }
  }

  function showRun() {
    intro.hidden = true;
    runBox.hidden = false;
    runTitle.textContent = '等待扫码';
    hideError();
    doneBox.hidden = true;
    resetStages();
    qrBox.hidden = true;
    setQrMasked(false);
    qrImg.removeAttribute('src');
    qrTip.textContent = '';
    qrTip.className = 'qrtip';
    reissueBtn.hidden = true;
    restartBtn.disabled = false;
  }

  function startCountdown(r, ttlMs) {
    r.expiredAt = Date.now() + ttlMs;
    stopTick(r);
    var render = function () {
      var left = Math.max(0, Math.round((r.expiredAt - Date.now()) / 1000));
      if (left > 0) {
        qrTip.textContent = '二维码有效期剩余 ' + left + ' 秒';
        qrTip.className = 'qrtip';
      } else {
        qrTip.textContent = '二维码可能已失效，点下面的按钮换一张';
        qrTip.className = 'qrtip expired';
      }
    };
    render();
    r.tickTimer = setInterval(render, 1000);
  }

  /** 只在当前 run 上挂 listener；事件里的 seq 用来跨重连去重。 */
  function on(r, type, fn) {
    if (!r.es) return;
    r.es.addEventListener(type, function (ev) {
      if (r.finished) return;
      var data;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      if (data.seq && data.seq <= r.lastSeq) return;
      if (data.seq) r.lastSeq = data.seq;
      fn(data);
    });
  }

  function openStream(r) {
    closeStream(r);
    r.es = new EventSource('/api/events?runId=' + encodeURIComponent(r.runId));

    on(r, 'stage', function (d) {
      addLine(d.label, d.tone, d.elapsed);
      /*
       * 扫码之后的判据：**出现任何不是「扫码前」的阶段**就遮。
       * 白名单而不是黑名单 —— 后端以后多推一个阶段名，黑名单会漏遮，
       * 白名单只会多遮一次（遮着比让用户重复扫要好）。
       */
      if (d.label && PRESCAN_STAGES.indexOf(d.label) < 0) {
        stopTick(r);
        setQrMasked(true, d.label);
      }
      if (d.tone === 'ok' && d.label && /等待扫码|二维码/.test(d.label) === false) {
        runTitle.textContent = d.label;
      }
    });

    on(r, 'log', function (d) { addLine(d.text, 'log'); });

    on(r, 'qr', function (d) {
      qrImg.src = d.dataUrl;
      qrBox.hidden = false;
      // 新的码 = 又回到「等扫码」，遮罩必须撤掉
      setQrMasked(false);
      reissueBtn.hidden = false;
      runTitle.textContent = '等待扫码';
      if (Number.isFinite(d.ttlMs) && d.ttlMs > 0) startCountdown(r, d.ttlMs);
      else stopTick(r);
    });

    on(r, 'account', function (d) {
      // 拿到账号 = 登录已经成功，一定在扫码之后
      stopTick(r);
      setQrMasked(true, '已登录并查到角色');
      var who = d.nickname ? d.nickname + '（UID ' + d.uid + '）' : 'UID ' + d.uid;
      addLine('账号：' + who);
    });

    on(r, 'done', function (d) {
      r.finished = true;
      closeStream(r);
      showFinal(r, d.url);
    });

    on(r, 'error', function (d) {
      r.finished = true;
      closeStream(r);
      runTitle.textContent = '失败';
      // 已经扫过码的话遮罩还在转圈，失败时要停下来（不再「处理中」）
      if (qrWrap.classList.contains('masked')) setQrMasked(true, '已扫码，处理失败', false);
      showError(d.message || '未知错误');
      restartBtn.disabled = false;
    });

    on(r, 'cancelled', function (d) {
      r.finished = true;
      closeStream(r);
      addLine('这次运行已结束：' + (d.reason || '已取消'), 'muted');
      runTitle.textContent = '已取消';
      if (qrWrap.classList.contains('masked')) setQrMasked(true, '这次运行已取消', false);
    });

    r.es.addEventListener('error', function () {
      // EventSource 自己会重连；只要还没 finished 就不当失败处理。
      if (!r.finished) addLine('连接中断，正在重连……', 'muted');
    });
  }

  function showFinal(r, url) {
    runTitle.textContent = '完成';
    var href = url || ('/report?runId=' + encodeURIComponent(r.runId));
    reportLink.href = href;
    doneBox.hidden = false;
    // 自动跳转：用户要的是「跑完就能看报表」，不想再点一次
    window.location.assign(href);
  }

  function beginRun() {
    if (cur) { closeStream(cur); cur = null; }
    cur = makeRun();
    showRun();
    startBtn.disabled = true;
    addLine('正在申请二维码……');

    fetch('/api/start', { method: 'POST' })
      .then(function (res) {
        if (res.status === 503) {
          return res.json().then(function (j) {
            throw new Error(j.message || '服务当前繁忙，请稍后再试');
          });
        }
        if (!res.ok) throw new Error('启动失败：HTTP ' + res.status);
        return res.json();
      })
      .then(function (j) {
        if (!j.runId) throw new Error('服务没有返回 runId');
        cur.runId = j.runId;
        openStream(cur);
        restartBtn.disabled = false;
      })
      .catch(function (e) {
        cur.finished = true;
        runTitle.textContent = '失败';
        showError(e && e.message ? e.message : String(e));
        restartBtn.disabled = false;
        startBtn.disabled = false;
      });
  }

  startBtn.addEventListener('click', beginRun);
  restartBtn.addEventListener('click', beginRun);
  reissueBtn.addEventListener('click', beginRun);

  /*
   * 离开页面时收掉流。不是必需（服务端有自己的回收），
   * 但能让「关掉标签页 = 这个 run 没人看了」这件事更快传导过去。
   */
  window.addEventListener('pagehide', function () {
    if (cur) closeStream(cur);
  });
})();
