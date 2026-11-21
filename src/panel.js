import { PANEL_ID } from './constants.js';
import { parseServiceAccount, defaultLabelFor, isDuplicate } from './credential-validator.js';
import { createCredential, activateCredential, removeCredential, renameCredential } from './secrets-bridge.js';

/**
 * 设置面板。
 *
 * 结构：默认收起的一行摘要 + 展开后的状态与列表 + 三个原生 <details> 二级折叠。
 * 折叠由本模块自己绑定点击并切换 hidden，不依赖宿主的委托事件，
 * 避免宿主调整事件绑定后点了没反应。
 *
 * 样式全部挂在根 id #gcp-credit-rotator 下，不使用 !important，
 * 避免压住酒馆会内联写入的属性。
 */

const TEMPLATE = `
<div class="gcr-bar" role="button" tabindex="0" aria-expanded="false">
  <span class="gcr-name">GCP 赠金轮询</span>
  <span class="gcr-summary" id="gcr-summary">读取中…</span>
  <span class="gcr-bar-right">
    <label class="gcr-switch" id="gcr-switch-wrap" title="总开关">
      <input id="gcr-enabled" type="checkbox">
      <span class="gcr-switch-track"><span class="gcr-switch-thumb"></span></span>
    </label>
    <span class="gcr-chevron" aria-hidden="true"></span>
  </span>
</div>

<div class="gcr-body" id="gcr-body" hidden>
  <div class="gcr-status">
    <div class="gcr-status-text">
      <div id="gcr-current-project" class="gcr-status-title">—</div>
      <div id="gcr-current-email" class="gcr-status-sub">—</div>
    </div>
    <button id="gcr-next" class="gcr-btn gcr-btn-primary" type="button">切到下一个</button>
  </div>

  <ul id="gcr-list" class="gcr-list"></ul>
  <p id="gcr-empty" class="gcr-empty" hidden>还没有凭据，展开下方「导入服务账号」添加。</p>

  <details class="gcr-fold">
    <summary class="gcr-fold-title">导入服务账号</summary>
    <div class="gcr-fold-body">
      <textarea id="gcr-import-text" class="gcr-textarea" rows="3" spellcheck="false" placeholder="粘贴 service account JSON，或选择文件"></textarea>
      <div class="gcr-row">
        <input id="gcr-import-file" type="file" accept=".json,application/json" class="gcr-file">
        <button id="gcr-import-btn" class="gcr-btn gcr-btn-ghost" type="button">导入</button>
      </div>
      <p id="gcr-hint" class="gcr-hint">只校验 type / project_id / client_email / private_key 四项；私钥只写入酒馆 secrets，不保存在本地。</p>
    </div>
  </details>

  <details class="gcr-fold">
    <summary class="gcr-fold-title">策略</summary>
    <div class="gcr-fold-body">
      <p id="gcr-guard-state" class="gcr-note">429 兜底：检查中…</p>
      <label class="gcr-check"><input id="gcr-rotate-each-turn" type="checkbox"><span>每条回复后轮换</span></label>
      <label class="gcr-check"><input id="gcr-retry-quota" type="checkbox"><span>额度报错换号补发一次</span></label>
      <div class="gcr-field">
        <span>冷却时长</span>
        <input id="gcr-cooldown" type="number" min="0" max="120" step="1">
        <span class="gcr-unit">分钟</span>
      </div>
    </div>
  </details>

  <details class="gcr-fold">
    <summary class="gcr-fold-title">最近记录</summary>
    <div class="gcr-fold-body">
      <ul id="gcr-log" class="gcr-log"></ul>
      <button id="gcr-clear-log" class="gcr-btn gcr-btn-ghost gcr-btn-block" type="button">清空记录</button>
    </div>
  </details>
</div>
`;

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** 从 label 猜项目号：vertexai@<project>.iam.gserviceaccount.com */
function projectOf(label) {
    const match = /@([^.@]+)\.iam\.gserviceaccount\.com$/i.exec(String(label ?? ''));
    return match ? match[1] : '';
}

function findMountTarget() {
    for (const selector of ['#extensions_settings2', '#extensions_settings']) {
        const node = document.querySelector(selector);
        if (node) return node;
    }
    return null;
}

export function mountPanel({ rotator, log, getGuard }) {
    if (document.getElementById(PANEL_ID)) return null;
    const mount = findMountTarget();
    if (!mount) {
        log?.error('找不到扩展设置容器（#extensions_settings）');
        return null;
    }

    const host = document.createElement('div');
    host.id = PANEL_ID;
    host.className = 'gcr-root inline-drawer';
    host.innerHTML = TEMPLATE;
    mount.appendChild(host);

    const $ = id => host.querySelector(`#${id}`);
    const bar = host.querySelector('.gcr-bar');
    const body = $('gcr-body');
    const summaryEl = $('gcr-summary');
    const listEl = $('gcr-list');
    const emptyEl = $('gcr-empty');
    const logEl = $('gcr-log');
    const hintEl = $('gcr-hint');

    let lastSnapshot = null;
    let importText = '';
    let pendingDeleteId = '';
    let deleteTimer = 0;
    let tickTimer = 0;

    /* ---------- 折叠 ---------- */
    function setOpen(open) {
        body.hidden = !open;
        bar.setAttribute('aria-expanded', String(open));
        host.classList.toggle('is-open', open);
    }

    bar.addEventListener('click', event => {
        if (event.target.closest('#gcr-switch-wrap')) return;
        setOpen(body.hidden);
    });

    bar.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        setOpen(body.hidden);
    });

    // 开关自己吃掉点击，避免顺带展开
    $('gcr-switch-wrap').addEventListener('click', event => event.stopPropagation());

    /* ---------- 渲染 ---------- */
    function hint(message, tone = '') {
        if (!hintEl) return;
        hintEl.textContent = message;
        hintEl.dataset.tone = tone;
    }

    function renderLog() {
        if (!logEl) return;
        const rows = log?.list?.() ?? [];
        logEl.innerHTML = rows
            .slice(-10)
            .reverse()
            .map(entry => {
                const time = new Date(entry.t).toLocaleTimeString();
                return `<li class="gcr-log-item" data-tone="${escapeHtml(entry.level)}"><span class="gcr-log-time">${escapeHtml(time)}</span><span class="gcr-log-text">${escapeHtml(entry.message)}</span></li>`;
            })
            .join('');
    }

    function badgeFor(item, activeId) {
        if (item.id === activeId) return '<span class="gcr-badge gcr-badge-on">生效中</span>';
        if (item.coolingMs > 0) {
            const minutes = Math.ceil(item.coolingMs / 60000);
            return `<span class="gcr-badge gcr-badge-cool">冷却 ${minutes}m</span>`;
        }
        return '<span class="gcr-badge">待命</span>';
    }

    function renderList(snap) {
        if (!listEl) return;
        const items = snap.credentials ?? [];
        emptyEl.hidden = items.length > 0;
        listEl.innerHTML = items
            .map(item => {
                const project = projectOf(item.label);
                const title = project || item.label || item.id.slice(0, 8);
                const isActive = item.id === snap.activeId;
                return `
<li class="gcr-item${isActive ? ' is-active' : ''}" data-id="${escapeHtml(item.id)}">
  <div class="gcr-item-body">
    <div class="gcr-item-title" title="${escapeHtml(item.label)}">${escapeHtml(title)}</div>
    <div class="gcr-item-sub">429 × ${item.throttled} · 切换 ${item.switches}</div>
  </div>
  <div class="gcr-item-actions">
    ${badgeFor(item, snap.activeId)}
    ${isActive ? '' : '<button class="gcr-mini" type="button" data-act="activate">启用</button>'}
    <button class="gcr-mini" type="button" data-act="rename">改名</button>
    <button class="gcr-mini gcr-mini-danger" type="button" data-act="delete">${pendingDeleteId === item.id ? '确认删除' : '删除'}</button>
  </div>
</li>`;
            })
            .join('');
    }

    function renderSummary(snap) {
        if (snap.active === false) {
            if (snap.settings?.enabled !== true) {
                summaryEl.textContent = '未启用（总开关关闭）';
                summaryEl.title = '打开右侧开关后开始工作';
            } else {
                summaryEl.textContent = '未启用（非 Vertex 渠道）';
                summaryEl.title = '当前 Chat Completion 源不是 Vertex，插件完全不介入';
            }
            return;
        }
        const items = snap.credentials ?? [];
        const active = items.find(item => item.id === snap.activeId);
        if (!active) {
            summaryEl.textContent = items.length ? `${items.length} 个凭据` : '未配置凭据';
            return;
        }
        const project = projectOf(active.label) || active.label;
        summaryEl.textContent = `${project} · ${items.length} 个`;
        summaryEl.title = active.label;
    }

    function render(snap) {
        lastSnapshot = snap;
        const settings = snap.settings ?? {};
        $('gcr-enabled').checked = Boolean(settings.enabled);
        $('gcr-rotate-each-turn').checked = Boolean(settings.rotateEachTurn);
        $('gcr-retry-quota').checked = Boolean(settings.retryOnQuota);
        $('gcr-cooldown').value = String(settings.cooldownMinutes ?? 10);

        const items = snap.credentials ?? [];
        const activeItem = items.find(item => item.id === snap.activeId);
        const activeProject = activeItem ? projectOf(activeItem.label) : '';
        if (snap.active === false) {
            $('gcr-current-project').textContent = '插件待命';
            $('gcr-current-email').textContent = snap.settings?.enabled !== true
                ? '总开关已关闭，打开后开始轮换'
                : '当前源不是 Vertex，插件不介入任何生成请求';
        } else {
            $('gcr-current-project').textContent = activeItem ? (activeProject || activeItem.label || '—') : '—';
            $('gcr-current-email').textContent = activeItem ? activeItem.label : '尚未选择凭据';
        }
        $('gcr-next').disabled = snap.active === false || items.length < 2;

        const guardEl = $('gcr-guard-state');
        if (guardEl) {
            const detach = typeof getGuard === 'function' ? getGuard() : null;
            if (!detach) {
                guardEl.textContent = '429 兜底：等待接入…';
                guardEl.dataset.tone = '';
            } else {
                const inChain = detach.isInChain?.() === true;
                guardEl.textContent = inChain
                    ? '429 兜底：已接入请求链'
                    : '429 兜底：未接入（fetch 由其它扩展占用，仅执行轮换）';
                guardEl.dataset.tone = inChain ? 'ok' : 'warn';
            }
        }

        renderSummary(snap);
        renderList(snap);
        renderLog();
    }

    /* ---------- 交互 ---------- */
    function applySettings(patch) {
        rotator.updateSettings(patch);
    }

    $('gcr-enabled').addEventListener('change', event => applySettings({ enabled: event.target.checked }));
    $('gcr-rotate-each-turn').addEventListener('change', event => applySettings({ rotateEachTurn: event.target.checked }));
    $('gcr-retry-quota').addEventListener('change', event => applySettings({ retryOnQuota: event.target.checked }));
    $('gcr-cooldown').addEventListener('change', event => {
        const value = Math.max(0, Math.min(120, Number(event.target.value) || 0));
        event.target.value = String(value);
        applySettings({ cooldownMinutes: value });
    });

    $('gcr-next').addEventListener('click', async () => {
        try {
            await rotator.manualNext();
            hint('已切到下一个凭据', 'ok');
        } catch (error) {
            hint(`切换失败：${error?.message ?? error}`, 'error');
        }
        renderLog();
    });

    $('gcr-clear-log').addEventListener('click', () => {
        log?.clear();
        renderLog();
    });

    async function doImport() {
        const text = (importText || $('gcr-import-text').value || '').trim();
        if (!text) {
            hint('先粘贴 JSON 或选择文件', 'warn');
            return;
        }
        const parsed = parseServiceAccount(text);
        if (!parsed.ok) {
            hint(parsed.error, 'error');
            return;
        }
        const before = rotator.snapshot();
        if (isDuplicate(parsed.meta, before.credentials)) {
            hint('这个服务账号已经在列表里了', 'warn');
            return;
        }
        const previousActive = before.activeId;
        try {
            await createCredential(text, defaultLabelFor(parsed.meta));
            // 酒馆语义：写入即 active。导入后把原本生效的那条切回去，不改动用户当前账号。
            if (previousActive) {
                try {
                    await activateCredential(previousActive);
                } catch (error) {
                    log?.warn(`恢复原生效凭据失败：${error?.message ?? error}`);
                }
            }
            await rotator.refresh();
            importText = '';
            $('gcr-import-text').value = '';
            $('gcr-import-file').value = '';
            hint(`已导入 ${parsed.meta.projectId}`, 'ok');
            log?.info(`导入服务账号 ${parsed.meta.clientEmail}（${parsed.meta.projectId}）`);
            renderLog();
        } catch (error) {
            hint(`导入失败：${error?.message ?? error}`, 'error');
            log?.error(`导入失败：${error?.message ?? error}`);
            renderLog();
        }
    }

    $('gcr-import-btn').addEventListener('click', doImport);

    $('gcr-import-file').addEventListener('change', event => {
        const file = event.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            importText = String(reader.result ?? '');
            $('gcr-import-text').value = importText;
            hint(`已读入 ${file.name}，点导入继续`, 'ok');
        };
        reader.onerror = () => hint('读取文件失败', 'error');
        reader.readAsText(file);
    });

    listEl.addEventListener('click', async event => {
        const button = event.target.closest('button[data-act]');
        if (!button) return;
        const item = button.closest('.gcr-item');
        const id = item?.dataset?.id;
        if (!id) return;
        const act = button.dataset.act;

        if (act === 'activate') {
            try {
                await activateCredential(id);
                await rotator.refresh();
                hint('已切换生效凭据', 'ok');
            } catch (error) {
                hint(`切换失败：${error?.message ?? error}`, 'error');
            }
            return;
        }

        if (act === 'rename') {
            const titleEl = item.querySelector('.gcr-item-title');
            if (!titleEl || item.querySelector('.gcr-rename')) return;
            const original = titleEl.textContent ?? '';
            const input = document.createElement('input');
            input.className = 'gcr-rename';
            input.value = original;
            titleEl.replaceWith(input);
            input.focus();
            input.select();

            const finish = async commit => {
                const value = input.value.trim();
                input.replaceWith(titleEl);
                titleEl.textContent = original;
                if (!commit || !value || value === original) return;
                try {
                    await renameCredential(id, value);
                    await rotator.refresh();
                    hint('已改名', 'ok');
                } catch (error) {
                    hint(`改名失败：${error?.message ?? error}`, 'error');
                }
            };

            input.addEventListener('keydown', ev => {
                if (ev.key === 'Enter') finish(true);
                if (ev.key === 'Escape') finish(false);
            });
            input.addEventListener('blur', () => finish(false));
            return;
        }

        if (act === 'delete') {
            if (pendingDeleteId !== id) {
                pendingDeleteId = id;
                renderList(lastSnapshot ?? rotator.snapshot());
                clearTimeout(deleteTimer);
                deleteTimer = window.setTimeout(() => {
                    pendingDeleteId = '';
                    renderList(lastSnapshot ?? rotator.snapshot());
                }, 4000);
                return;
            }
            pendingDeleteId = '';
            try {
                await removeCredential(id);
                await rotator.refresh();
                hint('已删除', 'ok');
            } catch (error) {
                hint(`删除失败：${error?.message ?? error}`, 'error');
            }
        }
    });

    // 挂载后强制回到收起态：宿主在渲染扩展列表时可能对 inline-drawer 做初始化，
    // 出现过刚加载就展开、把整个设置页顶开的情况。
    setOpen(false);

    const unsubscribe = rotator.subscribe(render);

    // 冷却倒计时：仅在展开且页面可见时刷新
    tickTimer = window.setInterval(() => {
        if (document.visibilityState !== 'visible') return;
        if (body.hidden || !document.body.contains(host)) return;
        renderList(rotator.snapshot());
    }, 15000);

    return {
        render,
        setOpen,
        destroy() {
            clearInterval(tickTimer);
            clearTimeout(deleteTimer);
            unsubscribe?.();
            host.remove();
        },
    };
}
